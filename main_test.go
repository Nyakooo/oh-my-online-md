package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMarkdownPreview(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	r := httptest.NewRequest("POST", "/api/preview", strings.NewReader("## 测试\n\n**加粗**\n\n<script>alert(1)</script>\n\n![截图](assets/test.png)"))
	w := httptest.NewRecorder()
	a.preview(w, r)
	body := w.Body.String()
	if w.Code != 200 || !strings.Contains(body, "<h2>测试</h2>") || !strings.Contains(body, "<strong>加粗</strong>") || !strings.Contains(body, `src="assets/test.png"`) || strings.Contains(body, "<script>") {
		t.Fatalf("preview: %d %s", w.Code, body)
	}
}

func TestImageRoundTrip(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	n, err := a.newNote("图片测试", "")
	if err != nil {
		t.Fatal(err)
	}
	// Minimal PNG signature, sufficient for HTTP MIME detection.
	png := append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, make([]byte, 64)...)
	r := httptest.NewRequest("POST", "/", bytes.NewReader(png))
	r.SetPathValue("id", n.ID)
	w := httptest.NewRecorder()
	a.uploadImage(w, r)
	if w.Code != 201 {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	var result struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	n.Content = "![截图](" + result.Path + ")"
	if err := a.writeNote(n); err != nil {
		t.Fatal(err)
	}
	saved, err := a.readNote(n.ID)
	if err != nil || saved.Content != n.Content {
		t.Fatal("image reference not persisted", err)
	}
	get := httptest.NewRequest("GET", "/", nil)
	get.SetPathValue("id", n.ID)
	get.SetPathValue("name", strings.TrimPrefix(result.Path, "assets/"))
	out := httptest.NewRecorder()
	a.getImage(out, get)
	if out.Code != 200 || !bytes.Equal(out.Body.Bytes(), png) || out.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("image retrieval: %d", out.Code)
	}
	bad := httptest.NewRequest("POST", "/", strings.NewReader("<svg onload=alert(1)>"))
	bad.SetPathValue("id", n.ID)
	rejected := httptest.NewRecorder()
	a.uploadImage(rejected, bad)
	if rejected.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("unsafe upload accepted: %d", rejected.Code)
	}
	get.SetPathValue("name", "../note.md")
	traversal := httptest.NewRecorder()
	a.getImage(traversal, get)
	if traversal.Code != 404 {
		t.Fatal("invalid asset path accepted")
	}
}

func TestSaveCleansOnlyUnreferencedImages(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	keep := strings.Repeat("a", 32) + ".png"
	remove := strings.Repeat("b", 32) + ".png"
	linked := strings.Repeat("c", 32) + ".png"
	n, err := a.newNote("清理测试", "![旧图片](assets/"+remove+")")
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(a.dataDir, n.DirName, "assets")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{keep, remove, linked, "manual.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("fixture"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	// Editing or a failed save must not delete any assets.
	bad := httptest.NewRequest("PUT", "/", strings.NewReader("{"))
	bad.SetPathValue("id", n.ID)
	a.updateNote(httptest.NewRecorder(), bad)
	if _, err := os.Stat(filepath.Join(dir, remove)); err != nil {
		t.Fatal("failed save deleted an image")
	}
	source := "![保留][pic]\n\n[pic]: ./assets/" + keep + "\n\n[下载](/api/notes/" + n.ID + "/assets/" + linked + ")"
	payload, _ := json.Marshal(map[string]string{"title": n.Title, "content": source})
	r := httptest.NewRequest("PUT", "/", bytes.NewReader(payload))
	r.SetPathValue("id", n.ID)
	w := httptest.NewRecorder()
	a.updateNote(w, r)
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(dir, remove)); !os.IsNotExist(err) {
		t.Fatal("unreferenced image remains after save")
	}
	for _, name := range []string{keep, linked, "manual.txt"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("referenced or unmanaged file removed: %s", name)
		}
	}
}

func TestImageUploadSizeBoundary(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	n, err := a.newNote("上传上限", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{10 << 20, (10 << 20) + 1} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			data := make([]byte, size)
			copy(data, []byte{137, 80, 78, 71, 13, 10, 26, 10})
			r := httptest.NewRequest("POST", "/", bytes.NewReader(data))
			r.SetPathValue("id", n.ID)
			w := httptest.NewRecorder()
			a.uploadImage(w, r)
			expected := http.StatusCreated
			if size > 10<<20 {
				expected = http.StatusRequestEntityTooLarge
			}
			if w.Code != expected {
				t.Fatalf("size %d: got %d, expected %d", size, w.Code, expected)
			}
		})
	}
	entries, err := os.ReadDir(filepath.Join(a.dataDir, n.DirName, "assets"))
	if err != nil || len(entries) != 1 {
		t.Fatal("rejected image must not be stored", err)
	}
}

func TestSaveCleansFailedAttemptButPreservesOtherUploads(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	n, err := a.newNote("重试清理", "")
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(a.dataDir, n.DirName, "assets")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	own := strings.Repeat("d", 32) + ".png"
	other := strings.Repeat("e", 32) + ".png"
	for _, name := range []string{own, other} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("fixture"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	payload, _ := json.Marshal(map[string]any{"title": n.Title, "content": "已删除待保存图片", "uploadedAssets": []string{"assets/" + own, "../meta.json"}})
	r := httptest.NewRequest("PUT", "/", bytes.NewReader(payload))
	r.SetPathValue("id", n.ID)
	w := httptest.NewRecorder()
	a.updateNote(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(dir, own)); !os.IsNotExist(err) {
		t.Fatal("failed attempt's removed image was not cleaned")
	}
	if _, err := os.Stat(filepath.Join(dir, other)); err != nil {
		t.Fatal("another editor's upload was deleted")
	}
	if _, err := a.readNote(n.ID); err != nil {
		t.Fatal("invalid candidate escaped assets directory", err)
	}
}
