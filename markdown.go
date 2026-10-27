package main

import (
	"bytes"
	"net/url"
	"path"
	"regexp"
	"strings"

	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/renderer/html"
	nethtml "golang.org/x/net/html"
)

// Raw HTML is rendered only through the same allowlist for preview and sharing.
var markdown = goldmark.New(goldmark.WithExtensions(extension.GFM), goldmark.WithRendererOptions(html.WithUnsafe()))
var noteHTMLPolicy = func() *bluemonday.Policy {
	p := bluemonday.NewPolicy()
	p.AllowElements("p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "del", "s", "strike", "blockquote", "ul", "ol", "li", "pre", "code", "a", "img", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "div", "span", "details", "summary", "sub", "sup", "kbd", "mark", "video", "source", "input")
	p.AllowStandardURLs()
	p.AllowAttrs("title").Globally()
	p.AllowAttrs("href").OnElements("a")
	p.AllowAttrs("src").OnElements("img", "video", "source")
	p.AllowAttrs("poster", "controls", "loop", "muted", "playsinline").OnElements("video")
	p.AllowAttrs("preload").Matching(regexp.MustCompile(`^(none|metadata|auto)$`)).OnElements("video")
	p.AllowAttrs("type").Matching(regexp.MustCompile(`^video/[a-zA-Z0-9.+-]+$`)).OnElements("source")
	p.AllowAttrs("alt").OnElements("img")
	p.AllowAttrs("width", "height").Matching(regexp.MustCompile(`^[1-9][0-9]{0,4}%?$`)).OnElements("img", "video")
	p.AllowStyles("width", "height", "max-width", "max-height").Matching(regexp.MustCompile(`(?i)^(auto|0|[0-9]+(\.[0-9]+)?(px|%|em|rem|vw|vh))$`)).OnElements("img", "video")
	p.AllowAttrs("open").OnElements("details")
	p.AllowAttrs("start").Matching(regexp.MustCompile(`^[0-9]+$`)).OnElements("ol")
	p.AllowAttrs("colspan", "rowspan").Matching(regexp.MustCompile(`^[1-9][0-9]*$`)).OnElements("th", "td")
	p.AllowAttrs("align").Matching(regexp.MustCompile(`^(left|center|right)$`)).OnElements("th", "td")
	p.AllowAttrs("class").Matching(regexp.MustCompile(`^(language-[a-zA-Z0-9_+-]+|contains-task-list|task-list-item|task-list-item-checkbox)$`)).OnElements("code", "ul", "ol", "li", "input")
	p.AllowAttrs("checked", "disabled").OnElements("input")
	p.AllowAttrs("type").Matching(regexp.MustCompile(`^checkbox$`)).OnElements("input")
	return p
}()

func renderNoteHTML(source []byte) ([]byte, error) {
	var output bytes.Buffer
	if err := markdown.Convert(source, &output); err != nil {
		return nil, err
	}
	return transformNoteHTML(noteHTMLPolicy.SanitizeBytes(output.Bytes()), nil), nil
}

// Work on rendered HTML so HTML media and Markdown images have identical asset
// handling, while examples inside code fences never become live references.
func transformNoteHTML(source []byte, destination func(string) string) []byte {
	var output bytes.Buffer
	tokens := nethtml.NewTokenizer(bytes.NewReader(source))
	for {
		typeOfToken := tokens.Next()
		if typeOfToken == nethtml.ErrorToken {
			return output.Bytes()
		}
		if typeOfToken != nethtml.StartTagToken && typeOfToken != nethtml.SelfClosingTagToken {
			output.Write(tokens.Raw())
			continue
		}
		token := tokens.Token()
		if token.Data == "input" {
			// User HTML can never introduce editable form fields into the page.
			attrs := []nethtml.Attribute{{Key: "type", Val: "checkbox"}, {Key: "disabled", Val: ""}}
			for _, attr := range token.Attr {
				if attr.Key == "checked" {
					attrs = append(attrs, attr)
				}
			}
			token.Attr = attrs
		}
		if destination != nil {
			for index := range token.Attr {
				attr := &token.Attr[index]
				if (token.Data == "a" && attr.Key == "href") || (token.Data == "img" && attr.Key == "src") || (token.Data == "video" && (attr.Key == "src" || attr.Key == "poster")) || (token.Data == "source" && attr.Key == "src") {
					attr.Val = destination(attr.Val)
				}
			}
		}
		output.WriteString(token.String())
	}
}

func noteAssetName(noteID, destination string) string {
	parsed, err := url.Parse(destination)
	if err != nil || parsed.Host != "" || parsed.Scheme != "" {
		return ""
	}
	target := path.Clean(parsed.Path)
	name := ""
	if strings.HasPrefix(target, "assets/") {
		name = strings.TrimPrefix(target, "assets/")
	}
	prefix := "/api/notes/" + noteID + "/assets/"
	if strings.HasPrefix(target, prefix) {
		name = strings.TrimPrefix(target, prefix)
	}
	ext := path.Ext(name)
	if validID(strings.TrimSuffix(name, ext)) && imageTypes[ext] != "" {
		return name
	}
	return ""
}
