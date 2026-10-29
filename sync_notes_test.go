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
	"time"
)

func syncPut(t *testing.T, a *app, id, operation, base string, input importNoteInput) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormField("note")
	json.NewEncoder(part).Encode(input)
	part, _ = writer.CreateFormField("content")
	part.Write([]byte(input.Content))
	writer.Close()
	r := httptest.NewRequest("PUT", "/api/sync/notes/"+id, &body)
	r.SetPathValue("id", id)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.Header.Set("X-Sync-Operation", operation)
	r.Header.Set("If-Match", "\""+base+"\"")
	w := httptest.NewRecorder()
	a.syncWriteNote(w, r)
	return w
}
func TestSyncVersionsReceiptsAndExtras(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	identity, _ := a.serverID()
	id := strings.Repeat("a", 32)
	operation := strings.Repeat("b", 32)
	input := importNoteInput{ServerID: identity, Title: "sync", Content: "first"}
	w := syncPut(t, a, id, operation, "none", input)
	if w.Code != 200 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	original, _ := a.readNote(id)
	base := a.syncVersion(original)
	if err := os.Mkdir(filepath.Join(a.dataDir, original.DirName, "shares"), 0700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(a.dataDir, original.DirName, "shares", "snapshot"), []byte("immutable share"), 0600)
	os.WriteFile(filepath.Join(a.dataDir, original.DirName, "share.json"), []byte("share record"), 0600)
	os.WriteFile(filepath.Join(a.dataDir, original.DirName, "custom.txt"), []byte("user file"), 0600)
	// An ordinary web edit after the successful sync must survive a lost-response retry.
	original.Content = "web edit"
	if err := a.writeNote(original); err != nil {
		t.Fatal(err)
	}
	w = syncPut(t, a, id, operation, "none", input)
	if w.Code != 200 {
		t.Fatalf("retry: %d %s", w.Code, w.Body.String())
	}
	current, _ := a.readNote(id)
	if current.Content != "web edit" {
		t.Fatal("retry overwrote web edit")
	}
	input.Content = "stale write"
	w = syncPut(t, a, id, strings.Repeat("c", 32), base, input)
	if w.Code != 412 {
		t.Fatalf("stale write: %d", w.Code)
	}
	input.Content = "updated"
	input.Folder = "moved"
	w = syncPut(t, a, id, strings.Repeat("d", 32), a.syncVersion(current), input)
	if w.Code != 200 {
		t.Fatalf("update/move: %d %s", w.Code, w.Body.String())
	}
	current, _ = a.readNote(id)
	if current.Content != "updated" || current.Folder != "moved" {
		t.Fatal("update failed", current)
	}
	for name, value := range map[string]string{"shares/snapshot": "immutable share", "share.json": "share record", "custom.txt": "user file"} {
		data, err := os.ReadFile(filepath.Join(a.dataDir, current.DirName, name))
		if err != nil || string(data) != value {
			t.Fatalf("lost extra %s: %v", name, err)
		}
	}
	// A folder move changes sync revisions even when the body did not change.
	before := a.syncVersion(current)
	current.DirName = filepath.Base(current.DirName)
	if before == a.syncVersion(current) {
		t.Fatal("folder missing from sync revision")
	}
}
func TestSyncDeleteAndProtectedExclusion(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	identity, _ := a.serverID()
	note, err := a.newNote("private", "secret")
	if err != nil {
		t.Fatal(err)
	}
	os.Mkdir(filepath.Join(a.dataDir, "private"), 0700)
	os.WriteFile(filepath.Join(a.dataDir, "private", ".pwd"), []byte("password"), 0600)
	os.Rename(filepath.Join(a.dataDir, note.DirName), filepath.Join(a.dataDir, "private", note.DirName))
	notes, excluded, structure, err := a.syncInventory()
	if err != nil || len(notes) != 0 || len(excluded) != 1 || len(structure.Folders) != 0 {
		t.Fatal("protected data exposed", notes, excluded, structure, err)
	}
	w := syncPut(t, a, note.ID, strings.Repeat("a", 32), note.Version, importNoteInput{ServerID: identity, Title: "overwrite", Content: "bad"})
	if w.Code != 403 {
		t.Fatalf("protected mutation: %d", w.Code)
	}
	public, _ := a.newNote("public", "keep")
	remove := func(operation, base string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("DELETE", "/", nil)
		r.SetPathValue("id", public.ID)
		r.Header.Set("X-Sync-Operation", operation)
		r.Header.Set("If-Match", base)
		r.Header.Set("X-Server-ID", identity)
		w := httptest.NewRecorder()
		a.syncWriteNote(w, r)
		return w
	}
	if w := remove(strings.Repeat("b", 32), "stale"); w.Code != 412 {
		t.Fatalf("stale delete: %d", w.Code)
	}
	operation := strings.Repeat("c", 32)
	if w := remove(operation, a.syncVersion(public)); w.Code != 200 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	if w := remove(operation, a.syncVersion(public)); w.Code != 200 {
		t.Fatalf("delete retry: %d", w.Code)
	}
	if _, err := a.readNote(public.ID); !os.IsNotExist(err) {
		t.Fatal("delete failed", err)
	}
}
func TestSyncJournalRecovery(t *testing.T) {
	for _, phase := range []string{"prepared", "old-moved", "published"} {
		t.Run(phase, func(t *testing.T) {
			a := &app{dataDir: t.TempDir()}
			item, _ := a.newNote("before", "old")
			operation := strings.Repeat("a", 32)
			directory := filepath.Join(a.dataDir, ".sync-journal-"+operation)
			os.Mkdir(directory, 0700)
			staged := filepath.Join(directory, "new")
			os.Mkdir(staged, 0700)
			metadata, _ := json.Marshal(noteMetadata{item.ID, "after", item.UpdatedAt})
			os.WriteFile(filepath.Join(staged, "meta.json"), metadata, 0600)
			os.WriteFile(filepath.Join(staged, "note.md"), []byte("new"), 0600)
			record := syncJournal{Receipt: syncReceipt{ID: item.ID, Hash: "request", Version: "result"}, OldPath: item.DirName, NewPath: item.DirName}
			data, _ := json.Marshal(record)
			os.WriteFile(filepath.Join(directory, "intent.json"), data, 0600)
			if phase != "prepared" {
				os.Rename(filepath.Join(a.dataDir, item.DirName), filepath.Join(directory, "old"))
			}
			if phase == "published" {
				os.Rename(staged, filepath.Join(a.dataDir, item.DirName))
			}
			if err := a.recoverSyncJournals(); err != nil {
				t.Fatal(err)
			}
			current, err := a.readNote(item.ID)
			if err != nil || current.Content != "new" {
				t.Fatal("recovery lost note", current, err)
			}
			if _, err := os.Stat(directory); !os.IsNotExist(err) {
				t.Fatal("journal not cleaned", err)
			}
			if _, err := os.Stat(filepath.Join(a.dataDir, ".sync-receipts", operation+".json")); err != nil {
				t.Fatal("missing durable receipt", err)
			}
		})
	}
	a := &app{dataDir: t.TempDir()}
	directory := filepath.Join(a.dataDir, ".sync-journal-"+strings.Repeat("f", 32))
	os.Mkdir(directory, 0700)
	if err := a.recoverSyncJournals(); err != nil {
		t.Fatal("empty prepared journal blocked restart", err)
	}
}
func TestSyncIdentityAndAuth(t *testing.T) {
	a := &app{dataDir: t.TempDir(), password: "secret"}
	r := httptest.NewRequest("GET", "/api/sync", nil)
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("manifest auth: %d", w.Code)
	}
	w = syncPut(t, a, strings.Repeat("a", 32), strings.Repeat("b", 32), "none", importNoteInput{ServerID: strings.Repeat("c", 32), Title: "bad", Content: "no"})
	if w.Code != 409 {
		t.Fatalf("identity: %d", w.Code)
	}
}

func TestSyncAssetRevisionRead(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	item, _ := a.newNote("image", "body")
	name := strings.Repeat("a", 32) + ".png"
	os.Mkdir(filepath.Join(a.dataDir, item.DirName, "assets"), 0700)
	data := append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, make([]byte, 64)...)
	os.WriteFile(filepath.Join(a.dataDir, item.DirName, "assets", name), data, 0600)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		r := httptest.NewRequest("GET", "/", nil)
		r.SetPathValue("id", item.ID)
		r.SetPathValue("name", name)
		r.Header.Set("If-Match", "\""+a.syncVersion(item)+"\"")
		w := httptest.NewRecorder()
		a.syncReadAsset(w, r)
		done <- w
	}()
	select {
	case w := <-done:
		if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) {
			t.Fatalf("image read: %d %s", w.Code, w.Body.String())
		}
	case <-time.After(time.Second):
		t.Fatal("sync image read deadlocked")
	}
}

func TestSyncPreservesUnmanagedAndPendingAssets(t *testing.T) {
	source, destination := t.TempDir(), t.TempDir()
	os.MkdirAll(filepath.Join(source, "assets", "nested"), 0700)
	os.WriteFile(filepath.Join(source, "assets", "manual.pdf"), []byte("manual"), 0600)
	os.WriteFile(filepath.Join(source, "assets", "nested", "file"), []byte("nested"), 0600)
	pending, removed := strings.Repeat("a", 32)+".png", strings.Repeat("b", 32)+".png"
	os.WriteFile(filepath.Join(source, "assets", pending), []byte("pending upload"), 0600)
	os.WriteFile(filepath.Join(source, "assets", removed), []byte("old image"), 0600)
	previous := note{Content: "![old](assets/" + removed + ")"}
	if err := copySyncExtras(source, destination, previous); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"manual.pdf", "nested/file", pending} {
		if _, err := os.Stat(filepath.Join(destination, "assets", name)); err != nil {
			t.Fatal(name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(destination, "assets", removed)); !os.IsNotExist(err) {
		t.Fatal("removed image retained", err)
	}
	before := syncVersionAt(previous, filepath.Join(source, "assets"))
	os.WriteFile(filepath.Join(source, "assets", pending), []byte("changed attachment bytes"), 0600)
	if before == syncVersionAt(previous, filepath.Join(source, "assets")) {
		t.Fatal("asset change did not invalidate revision")
	}
	if err := copySyncExtras(source, t.TempDir(), previous); err != nil {
		t.Fatal(err)
	}
}
