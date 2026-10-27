package main

import (
	"bytes"
	"encoding/json"
	"html/template"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

type shareRecord struct {
	Token     string    `json:"token"`
	NoteID    string    `json:"noteId"`
	Title     string    `json:"title"`
	Days      int       `json:"days"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
	Path      string    `json:"path"`
}

func (a *app) readShare(dir string) (shareRecord, error) {
	var record shareRecord
	data, err := os.ReadFile(filepath.Join(a.dataDir, dir, "share.json"))
	if err != nil {
		return record, err
	}
	if err = json.Unmarshal(data, &record); err != nil {
		return record, err
	}
	if !validID(record.Token) || !validID(record.NoteID) {
		return record, os.ErrNotExist
	}
	record.Path = "/s/" + record.Token + "/"
	return record, nil
}
func (a *app) getShare(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	item, err := a.readNote(r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "笔记不存在")
		return
	}
	record, err := a.readShare(item.DirName)
	if os.IsNotExist(err) {
		writeJSON(w, 200, nil)
		return
	}
	if err != nil {
		writeError(w, 500, "无法读取分享信息")
		return
	}
	if !record.ExpiresAt.After(time.Now()) {
		_ = os.Remove(filepath.Join(a.dataDir, item.DirName, "share.json"))
		_ = os.RemoveAll(filepath.Join(a.dataDir, item.DirName, "shares"))
		writeJSON(w, 200, nil)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, record)
}
func (a *app) createShare(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	var input struct {
		Days int `json:"days"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&input); err != nil || input.Days < 1 || input.Days > 7 {
		writeError(w, 400, "分享有效期为 1–7 个整天")
		return
	}
	item, err := a.readNote(r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "笔记不存在")
		return
	}
	old, err := a.readShare(item.DirName)
	if err != nil && !os.IsNotExist(err) {
		writeError(w, 500, "无法读取分享信息")
		return
	}
	token, err := newID()
	if err != nil {
		writeError(w, 500, "无法创建分享链接")
		return
	}
	now := time.Now().UTC()
	record := shareRecord{Token: token, NoteID: item.ID, Title: item.Title, Days: input.Days, CreatedAt: now, ExpiresAt: now.Add(time.Duration(input.Days) * 24 * time.Hour), Path: "/s/" + token + "/"}
	root := filepath.Join(a.dataDir, item.DirName)
	snapshot := filepath.Join(root, "shares", token)
	if err := os.MkdirAll(filepath.Join(snapshot, "assets"), 0755); err != nil {
		writeError(w, 500, "无法创建分享快照")
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(snapshot)
		}
	}()
	for name := range imageReferences(item, item.Content) {
		if err := copyShareImage(filepath.Join(root, "assets", name), filepath.Join(snapshot, "assets", name)); err != nil {
			writeError(w, 400, "笔记中的图片无法读取，请检查后重试")
			return
		}
	}
	if err := atomicWrite(filepath.Join(snapshot, "note.md"), []byte(item.Content)); err != nil {
		writeError(w, 500, "无法保存分享内容")
		return
	}
	data, err := json.Marshal(record)
	if err != nil {
		writeError(w, 500, "无法保存分享信息")
		return
	}
	if err := atomicWrite(filepath.Join(root, "share.json"), data); err != nil {
		writeError(w, 500, "无法保存分享信息")
		return
	}
	committed = true
	// Replacing the single active token revokes old links immediately, even if
	// removing an old snapshot fails. Only the token in share.json is accepted.
	if validID(old.Token) {
		_ = os.RemoveAll(filepath.Join(root, "shares", old.Token))
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 201, record)
}
func copyShareImage(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return err
	}
	_, err = io.Copy(output, input)
	closeErr := output.Close()
	if err != nil {
		return err
	}
	return closeErr
}
func (a *app) deleteShare(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	item, err := a.readNote(r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "笔记不存在")
		return
	}
	root := filepath.Join(a.dataDir, item.DirName)
	if err := os.Remove(filepath.Join(root, "share.json")); err != nil && !os.IsNotExist(err) {
		writeError(w, 500, "无法取消分享")
		return
	}
	if err := os.RemoveAll(filepath.Join(root, "shares")); err != nil {
		writeError(w, 500, "分享已取消，但快照清理失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (a *app) publicShare(token string) (shareRecord, string, error) {
	if !validID(token) {
		return shareRecord{}, "", os.ErrNotExist
	}
	entries, err := os.ReadDir(a.dataDir)
	if err != nil {
		return shareRecord{}, "", err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		record, err := a.readShare(entry.Name())
		if err == nil && record.Token == token && record.ExpiresAt.After(time.Now()) {
			return record, filepath.Join(a.dataDir, entry.Name(), "shares", token), nil
		}
	}
	return shareRecord{}, "", os.ErrNotExist
}
func shareHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self' https: http: data:; media-src 'self' https: http:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
}

var sharePage = template.Must(template.ParseFS(webFiles, "web/share.html"))

func (a *app) serveShare(w http.ResponseWriter, r *http.Request) {
	shareHeaders(w)
	record, dir, err := a.publicShare(r.PathValue("token"))
	if err != nil {
		http.Error(w, "分享链接已失效或不存在", 404)
		return
	}
	source, err := os.ReadFile(filepath.Join(dir, "note.md"))
	if err != nil {
		http.Error(w, "分享内容不可用", 404)
		return
	}
	rendered, err := renderNoteHTML(source)
	if err != nil {
		http.Error(w, "无法显示分享内容", 500)
		return
	}
	rendered = transformNoteHTML(rendered, func(destination string) string {
		if name := noteAssetName(record.NoteID, destination); name != "" {
			return "assets/" + name
		}
		return destination
	})
	var page bytes.Buffer
	data := struct {
		Title   string
		Body    template.HTML
		Expires string
	}{record.Title, template.HTML(rendered), record.ExpiresAt.In(time.FixedZone("UTC+8", 8*60*60)).Format("2006-01-02 15:04 (UTC+8)")}
	if err := sharePage.Execute(&page, data); err != nil {
		http.Error(w, "无法显示分享内容", 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(page.Bytes())
}
func (a *app) serveShareImage(w http.ResponseWriter, r *http.Request) {
	shareHeaders(w)
	name := r.PathValue("name")
	ext := path.Ext(name)
	if !validID(strings.TrimSuffix(name, ext)) || imageTypes[ext] == "" {
		http.NotFound(w, r)
		return
	}
	_, dir, err := a.publicShare(r.PathValue("token"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", imageTypes[ext])
	http.ServeFile(w, r, filepath.Join(dir, "assets", name))
}
