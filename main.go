package main

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

//go:embed web/index.html
var webFiles embed.FS

type app struct{ dataDir, password string }
type note struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	UpdatedAt time.Time `json:"updatedAt"`
	DirName   string    `json:"-"`
}
type noteSummary struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	UpdatedAt time.Time `json:"updatedAt"`
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
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/notes", a.listNotes)
	mux.HandleFunc("POST /api/notes", a.createNote)
	mux.HandleFunc("GET /api/notes/{id}", a.getNote)
	mux.HandleFunc("PUT /api/notes/{id}", a.updateNote)
	mux.HandleFunc("DELETE /api/notes/{id}", a.deleteNote)
	mux.HandleFunc("GET /", a.serveIndex)
	port := env("PORT", "10777")
	server := &http.Server{Addr: ":" + port, Handler: a.auth(mux), ReadHeaderTimeout: 5 * time.Second}
	log.Printf("online-md listening on :%s (data: %s)", port, dataDir)
	log.Fatal(server.ListenAndServe())
}
func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func (a *app) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.password == "" {
			next.ServeHTTP(w, r)
			return
		}
		_, password, ok := r.BasicAuth()
		if !ok || subtle.ConstantTimeCompare([]byte(password), []byte(a.password)) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="Online Markdown Notes", charset="UTF-8"`)
			http.Error(w, "authentication required", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (a *app) listNotes(w http.ResponseWriter, _ *http.Request) {
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
			items = append(items, noteSummary{item.ID, item.Title, item.UpdatedAt})
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt.After(items[j].UpdatedAt) })
	writeJSON(w, 200, items)
}
func (a *app) createNote(w http.ResponseWriter, r *http.Request) {
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
	item, err := a.readNote(r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "note not found")
		return
	}
	var input struct {
		Title   string `json:"title"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&input); err != nil {
		writeError(w, 400, "invalid note data")
		return
	}
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
	writeJSON(w, 200, item)
}
func (a *app) deleteNote(w http.ResponseWriter, r *http.Request) {
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
	if err := os.WriteFile(filepath.Join(dir, "note.md"), []byte(item.Content), 0644); err != nil {
		return err
	}
	data, err := json.Marshal(noteMetadata{item.ID, item.Title, item.UpdatedAt})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "meta.json"), data, 0644)
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
