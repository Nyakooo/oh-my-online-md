package main

import (
	"strings"
	"unicode/utf8"
)

// Keep results small while showing the text around the first body match.
func searchSnippet(content, query string) string {
	content = strings.Join(strings.Fields(content), " ")
	lower := strings.ToLower(content)
	index := strings.Index(lower, query)
	start := 0
	if index >= 0 {
		start = max(0, utf8.RuneCountInString(lower[:index])-24)
	}
	runes := []rune(content)
	end := min(len(runes), start+max(100, utf8.RuneCountInString(query)+48))
	snippet := string(runes[start:end])
	if start > 0 {
		snippet = "…" + snippet
	}
	if end < len(runes) {
		snippet += "…"
	}
	return snippet
}
