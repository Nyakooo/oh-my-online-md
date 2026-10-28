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
	"time"
)

func windowRequest(h http.Handler, window, method, path string, input any) *httptest.ResponseRecorder {
	var body bytes.Buffer
	if input != nil {
		_ = json.NewEncoder(&body).Encode(input)
	}
	r := httptest.NewRequest(method, path, &body)
	if window != "" {
		r.Header.Set("X-Note-Window", window)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func TestProtectedFolderWindowPolicy(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	h := a.routes()
	window := strings.Repeat("a", 32)
	other := strings.Repeat("b", 32)
	n, err := a.newNote("private", "content")
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(a.dataDir, "private")
	if err = os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(filepath.Join(a.dataDir, n.DirName), filepath.Join(dir, n.DirName)); err != nil {
		t.Fatal(err)
	}
	settings := windowRequest(h, window, "PUT", "/api/folders/private", map[string]any{"name": "private", "password": "secret"})
	requireStatus(t, settings, 200)
	var folder folderSummary
	_ = json.Unmarshal(settings.Body.Bytes(), &folder)
	if !folder.Locked {
		t.Fatal("saving a password auto-unlocked folder")
	}
	path := "/api/notes/" + n.ID
	requireStatus(t, windowRequest(h, window, "GET", path, nil), 403)
	requireStatus(t, windowRequest(h, "", "POST", "/api/folders/private/unlock", map[string]string{"password": "secret"}), 400)
	requireStatus(t, windowRequest(h, window, "POST", "/api/folders/private/unlock", map[string]string{"password": "secret"}), 204)
	requireStatus(t, windowRequest(h, window, "GET", path, nil), 200)
	requireStatus(t, windowRequest(h, other, "GET", path, nil), 403)
	requireStatus(t, windowRequest(h, "", "GET", path, nil), 403)
	// A fresh page/window ID cannot inherit access from the same browser login.
	requireStatus(t, windowRequest(h, strings.Repeat("c", 32), "GET", path, nil), 403)
	// Backend enforces idle expiry independently of any browser timer.
	key := "web/" + window
	a.clientMu.Lock()
	grant := a.folderGrants[key]["private"]
	grant.LastActivity = time.Now().Add(-6 * time.Minute)
	a.folderGrants[key]["private"] = grant
	a.clientMu.Unlock()
	requireStatus(t, windowRequest(h, window, "GET", path, nil), 403)
	requireStatus(t, windowRequest(h, window, "POST", "/api/folders/private/touch", nil), 403)
	requireStatus(t, windowRequest(h, window, "POST", "/api/folders/private/unlock", map[string]string{"password": "secret"}), 204)
	requireStatus(t, windowRequest(h, window, "POST", "/api/folder-window/lock", nil), 204)
	requireStatus(t, windowRequest(h, window, "GET", path, nil), 403)
}
func TestSidebarOrderingPersistsAndChecksFolderAccess(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	h := a.routes()
	window := strings.Repeat("a", 32)
	first, _ := a.newNote("first", "")
	second, _ := a.newNote("second", "")
	third, _ := a.newNote("third", "")
	for _, name := range []string{"A", "B"} {
		requireStatus(t, windowRequest(h, window, "POST", "/api/folders", map[string]any{"name": name}), 201)
	}
	requireStatus(t, windowRequest(h, window, "PUT", "/api/order", map[string]string{"kind": "note", "id": first.ID, "before": third.ID}), 204)
	requireStatus(t, windowRequest(h, window, "PUT", "/api/order", map[string]string{"kind": "folder", "id": "B", "before": "A"}), 204)
	restarted := &app{dataDir: a.dataDir}
	rh := restarted.routes()
	list := windowRequest(rh, window, "GET", "/api/notes", nil)
	var notes []noteSummary
	_ = json.Unmarshal(list.Body.Bytes(), &notes)
	if len(notes) != 3 || notes[0].ID != first.ID || notes[1].ID != third.ID || notes[2].ID != second.ID {
		t.Fatal("note order lost", list.Body.String())
	}
	folders := windowRequest(rh, window, "GET", "/api/folders", nil)
	var items []folderSummary
	_ = json.Unmarshal(folders.Body.Bytes(), &items)
	if items[0].Name != "B" {
		t.Fatal("folder order lost", folders.Body.String())
	}
	requireStatus(t, windowRequest(rh, window, "PUT", "/api/folders/B", map[string]any{"name": "Renamed"}), 200)
	folders = windowRequest(rh, window, "GET", "/api/folders", nil)
	_ = json.Unmarshal(folders.Body.Bytes(), &items)
	if items[0].Name != "Renamed" {
		t.Fatal("renaming lost order")
	}
	requireStatus(t, windowRequest(rh, window, "PUT", "/api/notes/"+first.ID+"/folder", map[string]string{"folder": "A"}), 200)
	requireStatus(t, windowRequest(rh, window, "PUT", "/api/folders/A", map[string]any{"name": "A", "password": "p"}), 200)
	requireStatus(t, windowRequest(rh, window, "PUT", "/api/order", map[string]string{"kind": "note", "id": first.ID, "folder": "A"}), 403)
	requireStatus(t, windowRequest(rh, window, "PUT", "/api/order", map[string]string{"kind": "note", "id": first.ID, "folder": ""}), 400)
	requireStatus(t, windowRequest(rh, window, "GET", "/.sidebar-order.json", nil), 404)
	info, err := os.Stat(filepath.Join(a.dataDir, ".sidebar-order.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("order metadata permission", err)
	}
}
