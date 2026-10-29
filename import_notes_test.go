package main

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func importRequest(t *testing.T, a *app, id string, input importNoteInput, assets map[string][]byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormField("note")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(part).Encode(input); err != nil {
		t.Fatal(err)
	}
	contentPart, err := writer.CreateFormField("content")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := contentPart.Write([]byte(input.Content)); err != nil {
		t.Fatal(err)
	}
	for name, data := range assets {
		part, err := writer.CreateFormFile(name, name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/api/import/notes/"+id, &body)
	r.SetPathValue("id", id)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()
	a.importNote(w, r)
	return w
}
func TestImportAtomicRetryAndIdentity(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	identity, err := a.serverID()
	if err != nil {
		t.Fatal(err)
	}
	restarted := &app{dataDir: a.dataDir}
	again, err := restarted.serverID()
	if err != nil || again != identity {
		t.Fatal("identity changed", err)
	}
	id := strings.Repeat("a", 32)
	name := strings.Repeat("b", 32) + ".png"
	png := append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, make([]byte, 64)...)
	input := importNoteInput{ServerID: identity, Title: "导入", Content: "![image](assets/" + name + ")", Folder: "本地文件夹"}
	if w := importRequest(t, a, id, input, nil); w.Code != 400 {
		t.Fatalf("missing image: %d %s", w.Code, w.Body.String())
	}
	if _, err := a.readNote(id); !os.IsNotExist(err) {
		t.Fatal("partial note exposed", err)
	}
	assets := map[string][]byte{name: png}
	if w := importRequest(t, a, id, input, assets); w.Code != 201 {
		t.Fatalf("import: %d %s", w.Code, w.Body.String())
	}
	item, err := a.readNote(id)
	if err != nil || item.Content != input.Content || item.Folder != input.Folder {
		t.Fatal("wrong imported note", err, item)
	}
	image, err := os.ReadFile(filepath.Join(a.dataDir, item.DirName, "assets", name))
	if err != nil || !bytes.Equal(image, png) {
		t.Fatal("wrong asset", err)
	}
	// Simulate a lost response and a restart. Replaying does not create a copy.
	if w := importRequest(t, restarted, id, input, assets); w.Code != 200 {
		t.Fatalf("retry: %d %s", w.Code, w.Body.String())
	}
	dirs, err := a.noteDirectories()
	if err != nil || len(dirs) != 1 {
		t.Fatal("duplicate note", dirs, err)
	}
	// Server-side edits must never be overwritten by a retried import.
	item.Content = "remote edit"
	if err := a.writeNote(item); err != nil {
		t.Fatal(err)
	}
	if w := importRequest(t, a, id, input, assets); w.Code != 200 {
		t.Fatalf("edited retry: %d", w.Code)
	}
	current, _ := a.readNote(id)
	if current.Content != "remote edit" {
		t.Fatal("remote edit overwritten")
	}
	input.Title = "changed request"
	if w := importRequest(t, a, id, input, assets); w.Code != 409 {
		t.Fatalf("id reuse: %d", w.Code)
	}
	input.ServerID = strings.Repeat("c", 32)
	if w := importRequest(t, a, strings.Repeat("d", 32), input, assets); w.Code != 409 {
		t.Fatalf("wrong instance: %d", w.Code)
	}
	entries, _ := os.ReadDir(a.dataDir)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".import-") {
			t.Fatal("staging leaked", entry.Name())
		}
	}
}
func TestImportRejectsUnsafeAndProtectedTargets(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	identity, _ := a.serverID()
	id := strings.Repeat("e", 32)
	input := importNoteInput{ServerID: identity, Title: "safe", Content: "body", Folder: "../escape"}
	if w := importRequest(t, a, id, input, nil); w.Code != 400 {
		t.Fatalf("path traversal: %d", w.Code)
	}
	input.Folder = "private"
	if err := os.Mkdir(filepath.Join(a.dataDir, "private"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a.dataDir, "private", ".pwd"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if w := importRequest(t, a, id, input, nil); w.Code != 403 {
		t.Fatalf("protected target: %d", w.Code)
	}
	input.Folder = ""
	input.Content = "plain"
	if w := importRequest(t, a, id, input, map[string][]byte{strings.Repeat("f", 32) + ".png": []byte("not png")}); w.Code != 400 {
		t.Fatalf("invalid image: %d", w.Code)
	}
	// The public router must still enforce ordinary server authentication.
	a.password = "password"
	r := httptest.NewRequest("GET", "/api/import/info", nil)
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("import auth: %d", w.Code)
	}
}

func TestImportStagesCleanupAndLimits(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	stage := filepath.Join(a.dataDir, ".import-12345678")
	keep := filepath.Join(a.dataDir, ".import-user-files")
	if err := os.Mkdir(stage, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(keep, 0700); err != nil {
		t.Fatal(err)
	}
	if err := cleanupImportStages(a.dataDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Fatal("stale staging not cleaned", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatal("unrelated hidden directory removed", err)
	}
	id := strings.Repeat("a", 32)
	r := httptest.NewRequest("POST", "/api/import/notes/"+id, nil)
	r.SetPathValue("id", id)
	r.ContentLength = maxImportBytes + 1
	w := httptest.NewRecorder()
	a.importNote(w, r)
	if w.Code != 413 {
		t.Fatalf("request limit: %d", w.Code)
	}
	identity, _ := a.serverID()
	input := importNoteInput{ServerID: identity, Title: "too large", Content: strings.Repeat("x", maxNoteContentBytes+1)}
	if w := importRequest(t, a, id, input, nil); w.Code != 400 {
		t.Fatalf("content limit: %d", w.Code)
	}
	input.Content = "body"
	input.Title = strings.Repeat("长", 201)
	if w := importRequest(t, a, id, input, nil); w.Code != 400 {
		t.Fatalf("title limit: %d", w.Code)
	}
	dirs, err := a.noteDirectories()
	if err != nil || len(dirs) != 0 {
		t.Fatal("invalid import exposed notes", dirs, err)
	}
}

func TestImportEscapingHeavyContent(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	identity, _ := a.serverID()
	// JSON encoding expands this valid 6 MiB body beyond the old 32 MiB cap.
	content := strings.Repeat("\x01", 6<<20)
	input := importNoteInput{ServerID: identity, Title: "raw content", Content: content}
	id := strings.Repeat("a", 32)
	if w := importRequest(t, a, id, input, nil); w.Code != 201 {
		t.Fatalf("raw import: %d %s", w.Code, w.Body.String())
	}
	current, err := a.readNote(id)
	if err != nil || current.Content != content {
		t.Fatal("raw content changed", err)
	}
}

func TestImportConcurrentRetry(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	identity, _ := a.serverID()
	input := importNoteInput{ServerID: identity, Title: "same request", Content: "unchanged"}
	id := strings.Repeat("a", 32)
	results := make(chan int, 4)
	for i := 0; i < 4; i++ {
		go func() { results <- importRequest(t, a, id, input, nil).Code }()
	}
	created := 0
	for i := 0; i < 4; i++ {
		code := <-results
		if code == 201 {
			created++
		} else if code != 200 {
			t.Fatalf("parallel retry: %d", code)
		}
	}
	dirs, err := a.noteDirectories()
	if err != nil || len(dirs) != 1 || created != 1 {
		t.Fatal("parallel duplicate", created, dirs, err)
	}
}
