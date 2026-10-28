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

const testExtensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func clientRequest(handler http.Handler, method, path, token string, input any) *httptest.ResponseRecorder {
	var body bytes.Buffer
	if input != nil {
		_ = json.NewEncoder(&body).Encode(input)
	}
	r := httptest.NewRequest(method, path, &body)
	r.Header.Set("Origin", testExtensionOrigin)
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}
func issueClient(t *testing.T, handler http.Handler, password string) string {
	t.Helper()
	w := clientRequest(handler, "POST", "/api/client/session", "", map[string]string{"password": password})
	requireStatus(t, w, 201)
	var result struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.Token == "" {
		t.Fatal("missing token", err)
	}
	return result.Token
}
func TestClientSessionsAndFolderIsolation(t *testing.T) {
	a := &app{dataDir: t.TempDir(), password: "server-secret"}
	h := a.routes()
	requireStatus(t, clientRequest(h, "POST", "/api/client/session", "", map[string]string{"password": "wrong"}), 401)
	first := issueClient(t, h, a.password)
	second := issueClient(t, h, a.password)
	requireStatus(t, clientRequest(h, "GET", "/api/notes", "", nil), 401)
	requireStatus(t, clientRequest(h, "GET", "/api/notes", first, nil), 200)
	stored, err := os.ReadFile(filepath.Join(a.dataDir, ".client-sessions.json"))
	if err != nil || bytes.Contains(stored, []byte(first)) || bytes.Contains(stored, []byte(a.password)) {
		t.Fatal("raw credential stored", err)
	}
	info, err := os.Stat(filepath.Join(a.dataDir, ".client-sessions.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("session permissions", err)
	}
	requireStatus(t, clientRequest(h, "POST", "/api/folders", first, map[string]any{"name": "private", "password": "folder-secret"}), 201)
	n, err := a.newNote("private-title", "private body")
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, clientRequest(h, "PUT", "/api/notes/"+n.ID+"/folder", first, map[string]any{"folder": "private"}), 200)
	requireStatus(t, clientRequest(h, "GET", "/api/notes/"+n.ID, second, nil), 403)
	requireStatus(t, clientRequest(h, "POST", "/api/folders/private/unlock", second, map[string]string{"password": "folder-secret"}), 204)
	requireStatus(t, clientRequest(h, "GET", "/api/notes/"+n.ID, second, nil), 200)
	requireStatus(t, clientRequest(h, "POST", "/api/folders/private/lock", first, nil), 204)
	requireStatus(t, clientRequest(h, "GET", "/api/notes/"+n.ID, first, nil), 403)
	requireStatus(t, clientRequest(h, "GET", "/api/notes/"+n.ID, second, nil), 200)
	restarted := &app{dataDir: a.dataDir, password: a.password}
	rh := restarted.routes()
	requireStatus(t, clientRequest(rh, "GET", "/api/notes", second, nil), 200)
	requireStatus(t, clientRequest(rh, "GET", "/api/notes/"+n.ID, second, nil), 403)
	requireStatus(t, clientRequest(rh, "DELETE", "/api/client/session", second, nil), 204)
	requireStatus(t, clientRequest(rh, "GET", "/api/notes", second, nil), 401)
	_, suffix, _ := strings.Cut(second, ".")
	cookieRequest := httptest.NewRequest("GET", "/api/notes", nil)
	cookieRequest.AddCookie(&http.Cookie{Name: sessionCookieName, Value: suffix})
	cookieResult := httptest.NewRecorder()
	rh.ServeHTTP(cookieResult, cookieRequest)
	requireStatus(t, cookieResult, 401)

	changed := &app{dataDir: a.dataDir, password: "changed"}
	requireStatus(t, clientRequest(changed.routes(), "GET", "/api/notes", first, nil), 401)
	// Cookie-authenticated websites keep their existing CSRF boundary.
	r := httptest.NewRequest("POST", "/api/folders", strings.NewReader(`{"name":"forged"}`))
	r.Header.Set("Origin", testExtensionOrigin)
	r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: a.sessionValue(info.ModTime().AddDate(1, 0, 0))})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	requireStatus(t, w, 403)
	// A website folder cookie must not grant access to a bearer client.
	cookieGrantRequest := httptest.NewRequest("GET", "/api/notes/"+n.ID, nil)
	cookieGrantRequest.Header.Set("Authorization", "Bearer "+first)
	cookieGrantRequest.AddCookie(&http.Cookie{Name: folderCookieName("private"), Value: a.folderToken("private", []byte("folder-secret"), "4102444800")})
	cookieGrantResult := httptest.NewRecorder()
	h.ServeHTTP(cookieGrantResult, cookieGrantRequest)
	requireStatus(t, cookieGrantResult, 403)
}
func TestClientLoginOriginAndFormat(t *testing.T) {
	a := &app{dataDir: t.TempDir(), password: "p"}
	h := a.routes()
	for _, origin := range []string{"https://evil.example", "chrome-extension://short", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.evil", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/path"} {
		r := httptest.NewRequest("POST", "/api/client/session", strings.NewReader(`{"password":"p"}`))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		requireStatus(t, w, 403)
	}
	r := httptest.NewRequest("POST", "/api/client/session", strings.NewReader(`{"password":"p"}`))
	r.Header.Set("Origin", testExtensionOrigin)
	r.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	requireStatus(t, w, 403)
	public := &app{dataDir: t.TempDir()}
	token := issueClient(t, public.routes(), "")
	requireStatus(t, clientRequest(public.routes(), "GET", "/api/notes", token+"x", nil), 401)
	requireStatus(t, clientRequest(public.routes(), "DELETE", "/api/client/session", token, nil), 204)
	requireStatus(t, clientRequest(public.routes(), "GET", "/api/notes", token, nil), 401)
}
func TestNoteSaveVersionConflict(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	h := a.routes()
	n, err := a.newNote("original", "first")
	if err != nil {
		t.Fatal(err)
	}
	save := func(version, content string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"title": "title", "content": content})
		r := httptest.NewRequest("PUT", "/api/notes/"+n.ID, bytes.NewReader(body))
		r.Header.Set("If-Match", "\""+version+"\"")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	requireStatus(t, save(n.Version, "second"), 200)
	requireStatus(t, save(n.Version, "would overwrite"), 412)
	current, err := a.readNote(n.ID)
	if err != nil || current.Content != "second" {
		t.Fatal("conflict overwrote current", err)
	}
	requireStatus(t, save(current.Version, "third"), 200)
}
