package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHTMLMediaRenderingAndSafety(t *testing.T) {
	source := `<img src="https://example.com/image.png" width="320" height="180" onerror="alert(1)">

<video src="https://example.com/movie.mp4" controls poster="assets/preview.png" style="width: 50%; height: auto; position: fixed; background-image: url(https://evil.invalid)"><source src="https://example.com/movie.webm" type="video/webm"></video>

<details open><summary>更多</summary><p>正文</p></details>

<script>alert(1)</script><iframe src="https://evil.invalid"></iframe><a href="javascript:alert(1)">链接</a><svg onload="alert(1)"></svg>

<img src="javascript:alert(1)" style="width: expression(alert(1))"><input type="text" autofocus><input type="checkbox" checked>
`
	rendered, err := renderNoteHTML([]byte(source))
	if err != nil {
		t.Fatal(err)
	}
	output := string(rendered)
	for _, expected := range []string{`width="320"`, `height="180"`, `<video`, `controls`, `width: 50%`, `height: auto`, `<source`, `<details`, `<summary>更多</summary>`, `type="checkbox" disabled=""`} {
		if !strings.Contains(output, expected) {
			t.Fatalf("missing %s in %s", expected, output)
		}
	}
	for _, forbidden := range []string{"<script", "<iframe", "<svg", "onerror", "onload", "javascript:", "expression(", "position:", "background-image", "autofocus", `type="text"`} {
		if strings.Contains(output, forbidden) {
			t.Fatalf("unsafe %s in %s", forbidden, output)
		}
	}
}

func TestHTMLAssetReferences(t *testing.T) {
	name := strings.Repeat("a", 32) + ".png"
	other := strings.Repeat("b", 32) + ".png"
	item := note{ID: strings.Repeat("c", 32)}
	for _, source := range []string{`<img src="assets/` + name + `" width="320">`, `<video poster="/api/notes/` + item.ID + `/assets/` + name + `" controls></video>`, `[图片](assets/` + name + `)`} {
		refs := imageReferences(item, source)
		if !refs[name] {
			t.Fatalf("lost HTML/Markdown asset: %s", source)
		}
	}
	source := "```html\n<img src=\"assets/" + other + "\">\n```\n\n<img src=\"https://other.invalid/api/notes/" + item.ID + "/assets/" + other + "\">"
	if refs := imageReferences(item, source); len(refs) != 0 {
		t.Fatalf("code or external image treated as local: %v", refs)
	}
}

func TestHTMLMediaShareAndCleanup(t *testing.T) {
	a := &app{dataDir: t.TempDir(), password: "test-password"}
	name := strings.Repeat("a", 32) + ".png"
	n, err := a.newNote("HTML 媒体", `![图片](assets/`+name+`)`)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(a.dataDir, n.DirName, "assets")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte("image"), 0644); err != nil {
		t.Fatal(err)
	}
	previous := n.Content
	n.Content = `<img src="/api/notes/` + n.ID + `/assets/` + name + `" style="width: 50%; height: auto"><video poster="assets/` + name + `" controls src="https://example.com/movie.mp4" width="480"></video>`
	if err := a.writeNote(n); err != nil {
		t.Fatal(err)
	}
	if err := a.removeDeletedImages(n, previous, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
		t.Fatal("Markdown to HTML conversion deleted the image", err)
	}
	record := createTestShare(t, a, n.ID, 1)
	page := shareRequest(a, "GET", record.Path, "", false)
	output := page.Body.String()
	if page.Code != 200 || !strings.Contains(output, `src="assets/`+name+`"`) || !strings.Contains(output, `width: 50%`) || !strings.Contains(output, `<video`) || strings.Contains(output, "/api/notes/") {
		t.Fatal("HTML share rendering:", output)
	}
	if !strings.Contains(page.Header().Get("Content-Security-Policy"), "media-src 'self' https: http:") {
		t.Fatal("shared video blocked by CSP")
	}
	previous = n.Content
	n.Content = "图片已删除"
	if err := a.removeDeletedImages(n, previous, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
		t.Fatal("removed HTML asset was not deleted", err)
	}
	if image := shareRequest(a, "GET", record.Path+"assets/"+name, "", false); image.Code != 200 {
		t.Fatalf("HTML snapshot image lost: %d", image.Code)
	}
}
