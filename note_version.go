package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
)

func noteVersion(item note) string {
	sum := sha256.Sum256([]byte(item.ID + "\x00" + item.Title + "\x00" + item.Content + "\x00" + item.UpdatedAt.String()))
	return hex.EncodeToString(sum[:])
}
func matchNoteVersion(w http.ResponseWriter, r *http.Request, item note) bool {
	supplied := r.Header.Get("If-Match")
	if supplied != "" && strings.Trim(supplied, "\"") != noteVersion(item) {
		writeError(w, http.StatusPreconditionFailed, "这篇笔记已在其他窗口修改。当前内容已保留，请重新加载服务器版本后再编辑。")
		return false
	}
	return true
}
