package main

import (
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

//go:embed web/index.html web/editor.bundle.js web/diagrams.bundle.js web/editor.LICENSE.txt web/share.html web/login.html web/favicon.svg web/favicon.ico
var webFiles embed.FS

type app struct {
	dataDir, password string
	writeMu           sync.Mutex
}
type note struct {
	ID             string    `json:"id"`
	Title          string    `json:"title"`
	Content        string    `json:"content"`
	UpdatedAt      time.Time `json:"updatedAt"`
	DirName        string    `json:"-"`
	CleanupWarning string    `json:"cleanupWarning,omitempty"`
}
type noteSummary struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	UpdatedAt time.Time `json:"updatedAt"`
	Snippet   string    `json:"snippet,omitempty"`
}
type noteMetadata struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func main() {
	dataDir := env("DATA_DIR", "./data")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("create data directory: %v", err)
	}
	a := &app{dataDir: dataDir, password: os.Getenv("PASSWORD")}
	port := env("PORT", "10777")
	server := &http.Server{Addr: ":" + port, Handler: a.routes(), ReadHeaderTimeout: 5 * time.Second}
	log.Printf("online-md listening on :%s (data: %s)", port, dataDir)
	log.Fatal(server.ListenAndServe())
}
func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/preview", a.preview)
	mux.HandleFunc("POST /api/notes/{id}/assets", a.uploadImage)
	mux.HandleFunc("GET /api/notes/{id}/assets/{name}", a.getImage)
	mux.HandleFunc("GET /api/notes", a.listNotes)
	mux.HandleFunc("POST /api/notes", a.createNote)
	mux.HandleFunc("GET /api/notes/{id}", a.getNote)
	mux.HandleFunc("PUT /api/notes/{id}", a.updateNote)
	mux.HandleFunc("DELETE /api/notes/{id}", a.deleteNote)
	mux.HandleFunc("GET /editor.bundle.js", a.serveEditor)
	mux.HandleFunc("GET /diagrams.bundle.js", a.serveEditor)
	mux.HandleFunc("GET /editor.LICENSE.txt", a.serveEditorLicense)
	mux.HandleFunc("GET /", a.serveIndex)

	mux.HandleFunc("GET /api/notes/{id}/share", a.getShare)
	mux.HandleFunc("POST /api/notes/{id}/share", a.createShare)
	mux.HandleFunc("DELETE /api/notes/{id}/share", a.deleteShare)
	// Public links are isolated from the authenticated editor and note APIs.
	public := http.NewServeMux()
	public.HandleFunc("GET /s/{token}/{$}", a.serveShare)
	public.HandleFunc("GET /s/{token}/assets/{name}", a.serveShareImage)
	public.HandleFunc("GET /s/{token}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/s/"+url.PathEscape(r.PathValue("token"))+"/", http.StatusTemporaryRedirect)
	})
	public.HandleFunc("GET /favicon.svg", a.serveFavicon)
	public.HandleFunc("GET /favicon.ico", a.serveFavicon)
	public.HandleFunc("GET /login", a.serveLogin)
	public.HandleFunc("POST /login", a.login)
	public.Handle("/", a.auth(mux))
	return public
}
func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func (a *app) listNotes(w http.ResponseWriter, r *http.Request) {
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	entries, err := os.ReadDir(a.dataDir)
	if err != nil {
		writeError(w, 500, "cannot read notes")
		return
	}
	items := make([]noteSummary, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		item, err := a.readNoteFromDir(entry.Name())
		if err == nil {
			if query != "" && !strings.Contains(strings.ToLower(item.Title), query) && !strings.Contains(strings.ToLower(item.Content), query) {
				continue
			}
			summary := noteSummary{ID: item.ID, Title: item.Title, UpdatedAt: item.UpdatedAt}
			if query != "" {
				summary.Snippet = searchSnippet(item.Content, query)
			}
			items = append(items, summary)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt.After(items[j].UpdatedAt) })
	writeJSON(w, 200, items)
}
func (a *app) createNote(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	var input struct {
		Title   string `json:"title"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&input); err != nil {
		writeError(w, 400, "invalid note data")
		return
	}
	item, err := a.newNote(input.Title, input.Content)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	writeJSON(w, 201, item)
}
func (a *app) newNote(title, content string) (note, error) {
	title = normalizeTitle(title)
	if utf8.RuneCountInString(title) > 200 {
		return note{}, errors.New("title is too long")
	}
	id, err := newID()
	if err != nil {
		return note{}, err
	}
	item := note{ID: id, Title: title, Content: content, UpdatedAt: time.Now().UTC()}
	base := safeFolderName(title) + "_" + item.UpdatedAt.Format("20060102-150405")
	dirName := base
	if err := os.Mkdir(filepath.Join(a.dataDir, dirName), 0755); err != nil {
		if !os.IsExist(err) {
			return note{}, err
		}
		dirName += "_" + id[:8]
		if err = os.Mkdir(filepath.Join(a.dataDir, dirName), 0755); err != nil {
			return note{}, err
		}
	}
	item.DirName = dirName
	if err := a.writeNote(item); err != nil {
		_ = os.RemoveAll(filepath.Join(a.dataDir, dirName))
		return note{}, err
	}
	return item, nil
}
func (a *app) getNote(w http.ResponseWriter, r *http.Request) {
	item, err := a.readNote(r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "note not found")
		return
	}
	writeJSON(w, 200, item)
}
func (a *app) updateNote(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	item, err := a.readNote(r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "note not found")
		return
	}
	var input struct {
		Title          string   `json:"title"`
		Content        string   `json:"content"`
		UploadedAssets []string `json:"uploadedAssets"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&input); err != nil {
		writeError(w, 400, "invalid note data")
		return
	}
	previousContent := item.Content
	item.Title = normalizeTitle(input.Title)
	if utf8.RuneCountInString(item.Title) > 200 {
		writeError(w, 400, "title is too long")
		return
	}
	item.Content = input.Content
	item.UpdatedAt = time.Now().UTC()
	if err := a.writeNote(item); err != nil {
		writeError(w, 500, "cannot save note")
		return
	}
	if err := a.removeDeletedImages(item, previousContent, input.UploadedAssets); err != nil {
		log.Printf("clean deleted images for note %s: %v", item.ID, err)
		item.CleanupWarning = "笔记已保存，但部分图片文件清理失败，请检查服务器目录权限"
	}
	writeJSON(w, 200, item)
}
func (a *app) deleteNote(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	item, err := a.readNote(r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "note not found")
		return
	}
	if err = os.RemoveAll(filepath.Join(a.dataDir, item.DirName)); err != nil {
		writeError(w, 500, "cannot delete note")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (a *app) readNote(id string) (note, error) {
	if !validID(id) {
		return note{}, errors.New("invalid id")
	}
	entries, err := os.ReadDir(a.dataDir)
	if err != nil {
		return note{}, err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		item, err := a.readNoteFromDir(entry.Name())
		if err == nil && item.ID == id {
			return item, nil
		}
	}
	return note{}, os.ErrNotExist
}
func (a *app) readNoteFromDir(dirName string) (note, error) {
	if filepath.Base(dirName) != dirName {
		return note{}, errors.New("invalid directory")
	}
	dir := filepath.Join(a.dataDir, dirName)
	data, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return note{}, err
	}
	var item note
	if err = json.Unmarshal(data, &item); err != nil || !validID(item.ID) {
		return note{}, errors.New("invalid note metadata")
	}
	content, err := os.ReadFile(filepath.Join(dir, "note.md"))
	if err != nil {
		return note{}, err
	}
	item.Content = string(content)
	item.DirName = dirName
	return item, nil
}
func (a *app) writeNote(item note) error {
	if filepath.Base(item.DirName) != item.DirName || item.DirName == "." || item.DirName == "" {
		return errors.New("invalid directory")
	}
	dir := filepath.Join(a.dataDir, item.DirName)
	data, err := json.Marshal(noteMetadata{item.ID, item.Title, item.UpdatedAt})
	if err != nil {
		return err
	}
	if err := atomicWrite(filepath.Join(dir, "meta.json"), data); err != nil {
		return err
	}
	return atomicWrite(filepath.Join(dir, "note.md"), []byte(item.Content))
}
func normalizeTitle(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		return "未命名便签"
	}
	return title
}
func safeFolderName(title string) string {
	var name strings.Builder
	lastDash := false
	for _, r := range title {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-':
			name.WriteRune(r)
			lastDash = false
		case unicode.IsSpace(r):
			if name.Len() > 0 && !lastDash {
				name.WriteByte('-')
				lastDash = true
			}
		}
		if name.Len() >= 96 {
			break
		}
	}
	result := strings.Trim(name.String(), "-_ .")
	if result == "" {
		return "未命名便签"
	}
	return result
}
func validID(id string) bool {
	if len(id) != 32 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}
func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func (a *app) serveIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	content, err := webFiles.ReadFile("web/index.html")
	if err != nil {
		http.Error(w, "web interface unavailable", 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(content)
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

var markdown = goldmark.New(goldmark.WithExtensions(extension.GFM))

func (a *app) preview(w http.ResponseWriter, r *http.Request) {
	source, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if err != nil {
		writeError(w, 413, "note is too large")
		return
	}
	var output bytes.Buffer
	if err := markdown.Convert(source, &output); err != nil {
		writeError(w, 500, "cannot render Markdown")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(output.Bytes())
}
func (a *app) uploadImage(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	item, err := a.readNote(r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "note not found")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 10<<20))
	if err != nil {
		writeError(w, 413, "image exceeds 10 MiB")
		return
	}
	ext := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}[http.DetectContentType(data)]
	if ext == "" {
		writeError(w, 415, "supported images: PNG, JPEG, GIF, WebP")
		return
	}
	id, err := newID()
	if err != nil {
		writeError(w, 500, "cannot create image")
		return
	}
	dir := filepath.Join(a.dataDir, item.DirName, "assets")
	if err := os.MkdirAll(dir, 0755); err != nil {
		writeError(w, 500, "cannot create image directory")
		return
	}
	name := id + ext
	if err := os.WriteFile(filepath.Join(dir, name), data, 0644); err != nil {
		writeError(w, 500, "cannot save image")
		return
	}
	writeJSON(w, 201, map[string]string{"path": "assets/" + name})
}
func (a *app) getImage(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	ext := filepath.Ext(name)
	mime := imageTypes[ext]
	if mime == "" || !validID(strings.TrimSuffix(name, ext)) {
		http.NotFound(w, r)
		return
	}
	item, err := a.readNote(r.PathValue("id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, filepath.Join(a.dataDir, item.DirName, "assets", name))
}

// Replace a file only after all bytes have been written successfully.
func atomicWrite(filename string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(filename), ".note-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0644); err == nil {
		_, err = file.Write(data)
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), filename)
}

func imageReferences(item note, content string) map[string]bool {
	refs := make(map[string]bool)
	root := markdown.Parser().Parse(text.NewReader([]byte(content)))
	_ = ast.Walk(root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		var destination []byte
		switch node := node.(type) {
		case *ast.Image:
			destination = node.Destination
		case *ast.Link:
			destination = node.Destination
		default:
			return ast.WalkContinue, nil
		}
		parsed, err := url.Parse(string(destination))
		if err != nil {
			return ast.WalkContinue, nil
		}
		target := path.Clean(parsed.Path)
		name := ""
		if strings.HasPrefix(target, "assets/") && parsed.Host == "" {
			name = strings.TrimPrefix(target, "assets/")
		}
		if strings.HasPrefix(target, "/api/notes/"+item.ID+"/assets/") {
			name = strings.TrimPrefix(target, "/api/notes/"+item.ID+"/assets/")
		}
		ext := path.Ext(name)
		if validID(strings.TrimSuffix(name, ext)) && imageTypes[ext] != "" {
			refs[name] = true
		}
		return ast.WalkContinue, nil
	})
	return refs
}

// Compare saved revisions so another in-flight save's new uploads are not removed.
// Only application-managed images removed from the saved Markdown are deleted.
func (a *app) removeDeletedImages(item note, previousContent string, uploadedAssets []string) error {
	previous := imageReferences(item, previousContent)
	// Include this save's uploads so a retry can discard an image uploaded by an
	// earlier failed attempt, without touching another editor's in-flight files.
	for _, asset := range uploadedAssets {
		name := strings.TrimPrefix(asset, "assets/")
		ext := path.Ext(name)
		if validID(strings.TrimSuffix(name, ext)) && imageTypes[ext] != "" {
			previous[name] = true
		}
	}
	current := imageReferences(item, item.Content)
	var failures []error
	for name := range previous {
		if current[name] {
			continue
		}
		err := os.Remove(filepath.Join(a.dataDir, item.DirName, "assets", name))
		if err != nil && !os.IsNotExist(err) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

var imageTypes = map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}

func (a *app) serveEditor(w http.ResponseWriter, r *http.Request) {
	name := "web/editor.bundle.js"
	if r.URL.Path == "/diagrams.bundle.js" {
		name = "web/diagrams.bundle.js"
	}
	content, err := webFiles.ReadFile(name)
	if err != nil {
		http.Error(w, "editor unavailable", 500)
		return
	}
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(content)
}

func (a *app) serveEditorLicense(w http.ResponseWriter, r *http.Request) {
	content, err := webFiles.ReadFile("web/editor.LICENSE.txt")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(content)
}

func (a *app) serveFavicon(w http.ResponseWriter, r *http.Request) {
	name, contentType := "web/favicon.svg", "image/svg+xml"
	if r.URL.Path == "/favicon.ico" {
		name, contentType = "web/favicon.ico", "image/x-icon"
	}
	content, err := webFiles.ReadFile(name)
	if err != nil {
		http.Error(w, "cannot load favicon", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Write(content)
}
