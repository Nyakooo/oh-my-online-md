package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

const (
	maxNoteContentBytes = 16 << 20
	maxNoteRequestBytes = 32 << 20
	noteContentTooLarge = "笔记正文超过 16 MiB 上限（按 UTF-8 字节计算），请拆分后保存"
	noteRequestTooLarge = "笔记保存请求超过 32 MiB 上限，请缩减内容或拆分笔记"
)

func decodeNoteInput(w http.ResponseWriter, r *http.Request, input any) bool {
	if r.ContentLength > maxNoteRequestBytes {
		writeError(w, http.StatusRequestEntityTooLarge, noteRequestTooLarge)
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxNoteRequestBytes))
	err := decoder.Decode(input)
	if err == nil {
		var trailing any
		err = decoder.Decode(&trailing)
		if err == io.EOF {
			return true
		}
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, noteRequestTooLarge)
	} else {
		writeError(w, http.StatusBadRequest, "invalid note data")
	}
	return false
}
