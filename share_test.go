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

func shareRequest(a *app, method, target, body string, owner bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	if owner {
		r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: a.sessionValue(time.Now().Add(time.Hour))})
	}
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}
func createTestShare(t *testing.T, a *app, id string, days int) shareRecord {
	t.Helper()
	payload, _ := json.Marshal(map[string]int{"days": days})
	w := shareRequest(a, "POST", "/api/notes/"+id+"/share", string(payload), true)
	if w.Code != 201 {
		t.Fatalf("share creation: %d %s", w.Code, w.Body.String())
	}
	var result shareRecord
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestShareReadOnlySnapshotAndRevocation(t *testing.T) {
	a := &app{dataDir: t.TempDir(), password: "test-password"}
	name := strings.Repeat("a", 32) + ".png"
	n, err := a.newNote("<私密标题>", "## 分享内容\n\n![图片](assets/"+name+")\n\n<script>alert(1)</script>")
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(a.dataDir, n.DirName, "assets")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	png := append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, make([]byte, 64)...)
	if err := os.WriteFile(filepath.Join(dir, name), png, 0644); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"/", "/api/notes", "/api/notes/" + n.ID, "/api/notes/" + n.ID + "/share", "/api/notes/" + n.ID + "/assets/" + name} {
		if w := shareRequest(a, "GET", target, "", false); w.Code != 401 && !(target == "/" && w.Code == 303) {
			t.Fatalf("private path accessible: %s %d", target, w.Code)
		}
	}
	if w := shareRequest(a, "POST", "/api/notes/"+n.ID+"/share", `{"days":1}`, false); w.Code != 401 {
		t.Fatal("unauthenticated share creation allowed")
	}
	shared := createTestShare(t, a, n.ID, 7)
	if d := time.Until(shared.ExpiresAt); d > 7*24*time.Hour || d < 7*24*time.Hour-time.Minute {
		t.Fatal("incorrect expiry", d)
	}
	public := "/s/" + shared.Token + "/"
	// Restarting the app must retain the persisted link.
	restarted := &app{dataDir: a.dataDir, password: a.password}
	page := shareRequest(restarted, "GET", public, "", false)
	if page.Code != 200 || !strings.Contains(page.Body.String(), "<h2>分享内容</h2>") || strings.Contains(page.Body.String(), "<script>alert") || !strings.Contains(page.Body.String(), "&lt;私密标题&gt;") {
		t.Fatalf("public page: %d %s", page.Code, page.Body.String())
	}
	if page.Header().Get("Cache-Control") != "no-store" || page.Header().Get("WWW-Authenticate") != "" {
		t.Fatal("public page incorrectly cached or requires login")
	}
	// Deleting the original image after saving must not break the shared snapshot.
	payload, _ := json.Marshal(map[string]string{"title": "后来的私密修改", "content": "新的私密内容"})
	saved := shareRequest(a, "PUT", "/api/notes/"+n.ID, string(payload), true)
	if saved.Code != 200 {
		t.Fatal(saved.Body.String())
	}
	image := shareRequest(a, "GET", public+"assets/"+name, "", false)
	if image.Code != 200 || !bytes.Equal(image.Body.Bytes(), png) {
		t.Fatalf("snapshot image: %d", image.Code)
	}
	page = shareRequest(a, "GET", public, "", false)
	if strings.Contains(page.Body.String(), "新的私密内容") {
		t.Fatal("later private edits leaked into snapshot")
	}
	if w := shareRequest(a, "POST", public, `{"content":"changed"}`, false); w.Code == 200 {
		t.Fatal("public share is writable")
	}
	revoked := shareRequest(a, "DELETE", "/api/notes/"+n.ID+"/share", "", true)
	if revoked.Code != 204 {
		t.Fatal(revoked.Code, revoked.Body.String())
	}
	for _, target := range []string{public, public + "assets/" + name} {
		if w := shareRequest(a, "GET", target, "", false); w.Code != 404 {
			t.Fatal("revoked link remains accessible", w.Code)
		}
	}
	if _, err := a.readNote(n.ID); err != nil {
		t.Fatal("revoking share deleted original note", err)
	}
}

func TestShareDaysExpiryAndReplacement(t *testing.T) {
	a := &app{dataDir: t.TempDir(), password: "test-password"}
	n, err := a.newNote("时效测试", "正文")
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{"days":0}`, `{"days":8}`, `{"days":-1}`, `{"days":1.5}`, `{}`} {
		if w := shareRequest(a, "POST", "/api/notes/"+n.ID+"/share", body, true); w.Code != 400 {
			t.Fatalf("invalid days accepted: %s %d", body, w.Code)
		}
	}
	first := createTestShare(t, a, n.ID, 1)
	second := createTestShare(t, a, n.ID, 7)
	if first.Token == second.Token {
		t.Fatal("share token reused")
	}
	if w := shareRequest(a, "GET", "/s/"+first.Token+"/", "", false); w.Code != 404 {
		t.Fatal("replaced token remains accessible")
	}
	second.ExpiresAt = time.Now().Add(-time.Second)
	data, _ := json.Marshal(second)
	if err := os.WriteFile(filepath.Join(a.dataDir, n.DirName, "share.json"), data, 0644); err != nil {
		t.Fatal(err)
	}
	if w := shareRequest(a, "GET", "/s/"+second.Token+"/", "", false); w.Code != 404 {
		t.Fatal("expired token remains accessible")
	}
	if w := shareRequest(a, "GET", "/s/"+second.Token+"/assets/"+strings.Repeat("a", 32)+".png", "", false); w.Code != 404 {
		t.Fatal("expired image accessible")
	}
	if w := shareRequest(a, "GET", "/api/notes/"+n.ID+"/share", "", true); w.Code != 200 || strings.TrimSpace(w.Body.String()) != "null" {
		t.Fatal("expired share still reported as active", w.Body.String())
	}
	active := createTestShare(t, a, n.ID, 1)
	if w := shareRequest(a, "DELETE", "/api/notes/"+n.ID, "", true); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := shareRequest(a, "GET", "/s/"+active.Token+"/", "", false); w.Code != 404 {
		t.Fatal("deleting a note did not revoke its link")
	}
}

func TestFailedShareReplacementKeepsOldLink(t *testing.T) {
	a := &app{dataDir: t.TempDir(), password: "test-password"}
	n, err := a.newNote("旧分享", "已分享的内容")
	if err != nil {
		t.Fatal(err)
	}
	first := createTestShare(t, a, n.ID, 1)
	n.Content = "![缺失图片](assets/" + strings.Repeat("f", 32) + ".png)"
	if err := a.writeNote(n); err != nil {
		t.Fatal(err)
	}
	failed := shareRequest(a, "POST", "/api/notes/"+n.ID+"/share", `{"days":7}`, true)
	if failed.Code != 400 {
		t.Fatal("missing image should fail replacement", failed.Code)
	}
	original := shareRequest(a, "GET", first.Path, "", false)
	if original.Code != 200 || !strings.Contains(original.Body.String(), "已分享的内容") {
		t.Fatal("failed replacement invalidated old link")
	}
	for _, name := range []string{"meta.json", "../meta.json", strings.Repeat("a", 32) + ".png"} {
		if w := shareRequest(a, "GET", first.Path+"assets/"+name, "", false); w.Code == 200 {
			t.Fatal("unshared asset accessible", name)
		}
	}
}
