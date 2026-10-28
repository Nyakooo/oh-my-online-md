package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type folderClient struct {
	handler http.Handler
	cookies map[string]*http.Cookie
}

func (c *folderClient) request(method, path string, input any) *httptest.ResponseRecorder {
	var body bytes.Buffer
	if input != nil {
		_ = json.NewEncoder(&body).Encode(input)
	}
	r := httptest.NewRequest(method, path, &body)
	for _, cookie := range c.cookies {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	c.handler.ServeHTTP(w, r)
	for _, cookie := range w.Result().Cookies() {
		if cookie.MaxAge < 0 {
			delete(c.cookies, cookie.Name)
		} else {
			c.cookies[cookie.Name] = cookie
		}
	}
	return w
}
func requireStatus(t *testing.T, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	if w.Code != want {
		t.Fatalf("got %d, want %d: %s", w.Code, want, w.Body.String())
	}
}
func TestFolderStorageAndAccess(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	c := folderClient{a.routes(), map[string]*http.Cookie{}}
	stranger := folderClient{a.routes(), map[string]*http.Cookie{}}
	n, err := a.newNote("秘密标题", "秘密正文")
	if err != nil {
		t.Fatal(err)
	}
	asset := strings.Repeat("a", 32) + ".png"
	assetDir := filepath.Join(a.dataDir, n.DirName, "assets")
	if err = os.Mkdir(assetDir, 0755); err != nil {
		t.Fatal(err)
	}
	png := append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, make([]byte, 64)...)
	if err = os.WriteFile(filepath.Join(assetDir, asset), png, 0644); err != nil {
		t.Fatal(err)
	}
	share := c.request("POST", "/api/notes/"+n.ID+"/share", map[string]any{"days": 1})
	requireStatus(t, share, 201)
	var record shareRecord
	_ = json.Unmarshal(share.Body.Bytes(), &record)
	password := " x\n中 🔑 "
	requireStatus(t, c.request("POST", "/api/folders", map[string]any{"name": "私密", "password": password}), 201)
	stored, err := os.ReadFile(filepath.Join(a.dataDir, "私密", ".pwd"))
	if err != nil || string(stored) != password {
		t.Fatalf("password bytes not preserved: %v", err)
	}
	requireStatus(t, c.request("PUT", "/api/notes/"+n.ID+"/folder", map[string]any{"folder": "私密"}), 200)
	for _, name := range []string{"note.md", "meta.json", "assets/" + asset, "share.json"} {
		if _, err = os.Stat(filepath.Join(a.dataDir, "私密", n.DirName, name)); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"/api/notes", "/api/notes?q=秘密"} {
		w := stranger.request("GET", path, nil)
		requireStatus(t, w, 200)
		if strings.Contains(w.Body.String(), "秘密") {
			t.Fatalf("locked note leaked: %s", w.Body.String())
		}
	}
	for _, req := range [][2]string{{"GET", ""}, {"PUT", ""}, {"DELETE", ""}, {"GET", "/assets/" + asset}, {"POST", "/assets"}, {"GET", "/share"}, {"POST", "/share"}, {"DELETE", "/share"}, {"PUT", "/folder"}} {
		// createShare parses its duration before loading the note.
		w := stranger.request(req[0], "/api/notes/"+n.ID+req[1], map[string]any{"days": 1, "folder": ""})
		requireStatus(t, w, 403)
	}
	requireStatus(t, stranger.request("GET", record.Path, nil), 404)
	requireStatus(t, stranger.request("GET", "/私密/.pwd", nil), 404)
	requireStatus(t, stranger.request("POST", "/api/folders/私密/unlock", map[string]any{"password": "wrong"}), 403)
	requireStatus(t, stranger.request("POST", "/api/folders/私密/unlock", map[string]any{"password": password}), 204)
	requireStatus(t, stranger.request("GET", "/api/notes/"+n.ID, nil), 200)
	image := stranger.request("GET", "/api/notes/"+n.ID+"/assets/"+asset, nil)
	requireStatus(t, image, 200)
	if !bytes.Equal(image.Body.Bytes(), png) {
		t.Fatal("asset changed")
	}
	requireStatus(t, stranger.request("POST", "/api/notes/"+n.ID+"/share", map[string]any{"days": 1}), 403)
	// Renaming preserves the password, note IDs, and asset URLs, and invalidates old-folder grants.
	requireStatus(t, c.request("PUT", "/api/folders/私密", map[string]any{"name": "改名", "keepPassword": true}), 200)
	requireStatus(t, c.request("GET", "/api/notes/"+n.ID, nil), 200)
	requireStatus(t, stranger.request("GET", "/api/notes/"+n.ID, nil), 403)
	data, err := os.ReadFile(filepath.Join(a.dataDir, "改名", ".pwd"))
	if err != nil || string(data) != password {
		t.Fatal("rename lost password", err)
	}
	// Empty passwords are permitted and external edits invalidate previous unlock cookies.
	requireStatus(t, c.request("PUT", "/api/folders/改名", map[string]any{"name": "改名", "password": ""}), 200)
	requireStatus(t, c.request("POST", "/api/folders/改名/lock", nil), 204)
	requireStatus(t, c.request("GET", "/api/notes/"+n.ID, nil), 403)
	requireStatus(t, c.request("POST", "/api/folders/改名/unlock", map[string]any{"password": ""}), 204)
	if err = os.WriteFile(filepath.Join(a.dataDir, "改名", ".pwd"), []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, c.request("GET", "/api/notes/"+n.ID, nil), 403)
	requireStatus(t, c.request("POST", "/api/folders/改名/unlock", map[string]any{"password": "external"}), 204)
	requireStatus(t, c.request("PUT", "/api/notes/"+n.ID+"/folder", map[string]any{"folder": ""}), 200)
	requireStatus(t, stranger.request("GET", "/api/notes/"+n.ID, nil), 200)
	requireStatus(t, stranger.request("GET", record.Path, nil), 200)
	requireStatus(t, c.request("PUT", "/api/folders/改名", map[string]any{"name": "改名", "password": nil}), 200)
	if _, err = os.Stat(filepath.Join(a.dataDir, "改名", ".pwd")); !os.IsNotExist(err) {
		t.Fatal("password file not removed", err)
	}
}
func TestFolderFilesystemBoundaries(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	c := folderClient{a.routes(), map[string]*http.Cookie{}}
	n, err := a.newNote("原有笔记", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../outside", "a/b", "a\\b", ".", "..", ".hidden", " space", "a\n"} {
		requireStatus(t, c.request("POST", "/api/folders", map[string]any{"name": name}), 400)
	}
	requireStatus(t, c.request("POST", "/api/folders", map[string]any{"name": n.DirName}), 409)
	// Existing server-side directories appear without importing or rewriting them.
	external := filepath.Join(a.dataDir, "手动目录")
	if err = os.Mkdir(external, 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(filepath.Join(a.dataDir, n.DirName), filepath.Join(external, n.DirName)); err != nil {
		t.Fatal(err)
	}
	w := c.request("GET", "/api/folders", nil)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), "手动目录") {
		t.Fatal(w.Body.String())
	}
	requireStatus(t, c.request("GET", "/api/notes/"+n.ID, nil), 200)
	outside := t.TempDir()
	if err = os.Symlink(outside, filepath.Join(a.dataDir, "link")); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, c.request("PUT", "/api/notes/"+n.ID+"/folder", map[string]any{"folder": "link"}), 404)
	requireStatus(t, c.request("PUT", "/api/notes/"+n.ID+"/folder", map[string]any{"folder": "../outside"}), 404)
	// A symlinked password file fails closed and is not read through the web.
	if err = os.Symlink(filepath.Join(outside, "password"), filepath.Join(external, ".pwd")); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, c.request("GET", "/api/notes/"+n.ID, nil), 403)
}

func TestFolderMoveConflictsAndPasswordInvalidation(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	c := folderClient{a.routes(), map[string]*http.Cookie{}}
	visitor := folderClient{a.routes(), map[string]*http.Cookie{}}
	n, err := a.newNote("move", "original")
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, c.request("POST", "/api/folders", map[string]any{"name": "locked", "password": "p"}), 201)
	requireStatus(t, visitor.request("PUT", "/api/notes/"+n.ID+"/folder", map[string]any{"folder": "locked"}), 403)
	requireStatus(t, c.request("POST", "/api/folders", map[string]any{"name": "target"}), 201)
	collision := filepath.Join(a.dataDir, "target", n.DirName)
	if err = os.Mkdir(collision, 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(collision, "keep"), []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, c.request("PUT", "/api/notes/"+n.ID+"/folder", map[string]any{"folder": "target"}), 409)
	original, err := a.readNote(n.ID)
	if err != nil || original.DirName != n.DirName || original.Content != "original" {
		t.Fatal("collision altered source", err)
	}
	if b, err := os.ReadFile(filepath.Join(collision, "keep")); err != nil || string(b) != "keep" {
		t.Fatal("collision overwritten", err)
	}
	requireStatus(t, c.request("PUT", "/api/notes/"+n.ID+"/folder", map[string]any{"folder": "locked"}), 200)
	// A fresh server has a fresh signing key even with identical data and passwords.
	restarted := &app{dataDir: a.dataDir}
	visitor.handler = restarted.routes()
	visitor.cookies = c.cookies
	requireStatus(t, visitor.request("GET", "/api/notes/"+n.ID, nil), 403)
	// API clients cannot perform cross-origin folder mutations.
	req := httptest.NewRequest("POST", "/api/folders", strings.NewReader(`{"name":"forged"}`))
	req.Header.Set("Origin", "https://elsewhere.test")
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, req)
	requireStatus(t, w, 403)
	info, err := os.Stat(filepath.Join(a.dataDir, "locked", ".pwd"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("password file permissions", err)
	}
}
