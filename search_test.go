package main

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestGlobalSearch(t *testing.T) {
	a := &app{dataDir: t.TempDir()}
	for _, n := range []struct{ title, body string }{{"发布记录", "支持跨端搜索，Project Alpha"}, {"Alpha 标题", "其他正文"}, {"无关笔记", "不匹配"}, {"长文", strings.Repeat("前文", 100) + "搜索目标" + strings.Repeat("后文", 100)}, {"符号", "a+b [test] <script>alert(1)</script>"}} {
		if _, err := a.newNote(n.title, n.body); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		query string
		count int
	}{{"ALPHA", 2}, {"跨端", 1}, {"搜索目标", 1}, {"a+b [test]", 1}, {"不存在", 0}, {"   ", 5}} {
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, httptest.NewRequest("GET", "/api/notes?q="+url.QueryEscape(tc.query), nil))
		var results []noteSummary
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &results) != nil || len(results) != tc.count {
			t.Fatalf("query %q: %d %s", tc.query, w.Code, w.Body.String())
		}
		if tc.query == "搜索目标" && (!strings.Contains(results[0].Snippet, "搜索目标") || !utf8.ValidString(results[0].Snippet) || utf8.RuneCountInString(results[0].Snippet) > 102) {
			t.Fatal("body excerpt missing or invalid", results)
		}
	}
	a.password = "secret"
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, httptest.NewRequest("GET", "/api/notes?q=Alpha", nil))
	if w.Code != 401 {
		t.Fatal("search exposed private notes")
	}
}
