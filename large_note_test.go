package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestLargeNoteSaveRoundTrip(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	content := strings.Repeat("大文本 Markdown 内容\n", 150000)
	payload, _ := json.Marshal(map[string]string{"title": "大文本", "content": content})
	if len(payload) <= 2<<20 {
		t.Fatal("fixture must exceed the old 2 MiB limit")
	}
	w := httptest.NewRecorder()
	a.createNote(w, httptest.NewRequest("POST", "/api/notes", strings.NewReader(string(payload))))
	if w.Code != 201 {
		t.Fatalf("large create: %d %s", w.Code, w.Body.String())
	}
	var saved note
	if err := json.Unmarshal(w.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Content != content {
		t.Fatal("large create truncated content")
	}
	content += "\n追加内容"
	payload, _ = json.Marshal(map[string]string{"title": "大文本修改", "content": content})
	r := httptest.NewRequest("PUT", "/api/notes/"+saved.ID, strings.NewReader(string(payload)))
	r.SetPathValue("id", saved.ID)
	w = httptest.NewRecorder()
	a.updateNote(w, r)
	if w.Code != 200 {
		t.Fatalf("large update: %d %s", w.Code, w.Body.String())
	}
	disk, err := a.readNote(saved.ID)
	if err != nil || disk.Content != content {
		t.Fatal("large note was not fully persisted", err)
	}
}

func TestNoteSizeBoundariesAndErrors(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	original, err := a.newNote("保留原文", "原始内容")
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"POST", "PUT"} {
		t.Run(method, func(t *testing.T) {
			// Unicode limits are bytes, not rune counts.
			content := strings.Repeat("中", maxNoteContentBytes/3+1)
			payload, _ := json.Marshal(map[string]string{"content": content})
			r := httptest.NewRequest(method, "/api/notes", strings.NewReader(string(payload)))
			r.SetPathValue("id", original.ID)
			w := httptest.NewRecorder()
			if method == "POST" {
				a.createNote(w, r)
			} else {
				a.updateNote(w, r)
			}
			if w.Code != 413 || !strings.Contains(w.Body.String(), "16 MiB") {
				t.Fatalf("content limit: %d %s", w.Code, w.Body.String())
			}
		})
	}
	for _, lengthKnown := range []bool{true, false} {
		payload := `{}` + strings.Repeat(" ", maxNoteRequestBytes)
		r := httptest.NewRequest("POST", "/api/notes", strings.NewReader(payload))
		if !lengthKnown {
			r.ContentLength = -1
		}
		w := httptest.NewRecorder()
		a.createNote(w, r)
		if w.Code != 413 || !strings.Contains(w.Body.String(), "32 MiB") {
			t.Fatalf("request limit: %d %s", w.Code, w.Body.String())
		}
	}
	for _, payload := range []string{`{"content":`, `{} {}`} {
		w := httptest.NewRecorder()
		a.createNote(w, httptest.NewRequest("POST", "/api/notes", strings.NewReader(payload)))
		if w.Code != 400 {
			t.Fatalf("invalid JSON returned %d", w.Code)
		}
	}
	saved, err := a.readNote(original.ID)
	if err != nil || saved.Content != "原始内容" {
		t.Fatal("rejected save changed original content", err)
	}
	entries, err := os.ReadDir(a.dataDir)
	if err != nil || len(entries) != 1 {
		t.Fatal("rejected saves created notes", err)
	}
}

func TestNoteContentAtLimit(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	content := strings.Repeat("a", maxNoteContentBytes)
	payload, _ := json.Marshal(map[string]string{"content": content})
	w := httptest.NewRecorder()
	a.createNote(w, httptest.NewRequest("POST", "/api/notes", strings.NewReader(string(payload))))
	if w.Code != 201 {
		t.Fatalf("exact limit must save: %d", w.Code)
	}
}
