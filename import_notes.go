package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const maxImportBytes = 232 << 20

type importNoteInput struct {
	ServerID string `json:"serverID"`
	Title    string `json:"title"`
	Content  string `json:"-"`
	Folder   string `json:"folder"`
}

// The instance identity lives with the data, independent of URL and login token.
// Caller holds writeMu.
func (a *app) serverID() (string, error) {
	path := filepath.Join(a.dataDir, ".server-id")
	data, err := os.ReadFile(path)
	if err == nil {
		value := strings.TrimSpace(string(data))
		if !validID(value) {
			return "", errors.New("invalid server identity")
		}
		return value, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	value, err := newID()
	if err != nil {
		return "", err
	}
	if err := atomicWriteMode(path, []byte(value), 0600); err != nil {
		return "", err
	}
	return value, nil
}
func (a *app) importInfo(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	value, err := a.serverID()
	if err != nil {
		writeError(w, 500, "无法读取服务器身份")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"serverID": value, "importAPI": 1})
}

// Each request is a complete immutable revision. Assets are staged before the
// note directory is atomically published. A lost response can safely be retried.
func (a *app) importNote(w http.ResponseWriter, r *http.Request) {
	if !authorizedMutation(r) {
		writeError(w, 403, "invalid origin")
		return
	}
	importID := r.PathValue("id")
	if !validID(importID) {
		writeError(w, 400, "导入标识无效")
		return
	}
	if r.ContentLength > maxImportBytes {
		writeError(w, 413, "单篇导入请求超过 232 MiB")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxImportBytes)
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, 400, "导入数据无效")
		return
	}
	// Staging directories are hidden from note discovery, even after a crash.
	stage, err := os.MkdirTemp(a.dataDir, ".import-")
	if err != nil {
		writeError(w, 500, "无法创建导入暂存目录")
		return
	}
	defer os.RemoveAll(stage)
	input, digest, err := readImport(reader, stage, importID)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	serverID, err := a.serverID()
	if err != nil {
		writeError(w, 500, "无法读取服务器身份")
		return
	}
	if input.ServerID != serverID {
		writeError(w, 409, "目标服务器已变化，请重新选择导入目标")
		return
	}
	if previous, err := a.readNote(importID); err == nil {
		receipt, err := os.ReadFile(filepath.Join(a.dataDir, previous.DirName, ".import-digest"))
		if err != nil || string(receipt) != digest {
			writeError(w, 409, "导入标识已被使用，未覆盖服务器笔记")
			return
		}
		// Never return protected contents, even when this is an idempotent retry.
		writeJSON(w, 200, map[string]string{"id": previous.ID})
		return
	} else if !os.IsNotExist(err) {
		writeError(w, 500, "无法检查已导入笔记")
		return
	}
	parent := ""
	if input.Folder != "" {
		parent = input.Folder
		if a.folderExists(parent) {
			_, protected, err := a.folderPassword(parent)
			if err != nil || protected {
				writeError(w, 403, "目标同名文件夹受保护，请重命名本地文件夹后再导入")
				return
			}
		} else if err := os.Mkdir(filepath.Join(a.dataDir, parent), 0755); err != nil {
			writeError(w, 409, "无法创建目标文件夹，请检查是否存在同名笔记目录")
			return
		}
	}
	now := time.Now().UTC()
	name := safeFolderName(input.Title) + "_" + now.Format("20060102-150405") + "_" + importID
	item := note{ID: importID, Title: normalizeTitle(input.Title), Content: input.Content, UpdatedAt: now}
	metadata, err := json.Marshal(noteMetadata{item.ID, item.Title, item.UpdatedAt})
	if err != nil {
		writeError(w, 500, "无法保存导入笔记")
		return
	}
	for name, data := range map[string][]byte{"meta.json": metadata, "note.md": []byte(item.Content), ".import-digest": []byte(digest)} {
		if err := os.WriteFile(filepath.Join(stage, name), data, 0600); err != nil {
			writeError(w, 500, "无法保存导入笔记")
			return
		}
	}
	if err := os.Rename(stage, filepath.Join(a.dataDir, parent, name)); err != nil {
		writeError(w, 500, "无法提交导入笔记")
		return
	}
	writeJSON(w, 201, map[string]string{"id": importID})
}

func readImport(reader *multipart.Reader, stage, importID string) (importNoteInput, string, error) {
	var input importNoteInput
	first, err := reader.NextPart()
	if err != nil || first.FormName() != "note" {
		return input, "", errors.New("缺少导入笔记信息")
	}
	data, err := io.ReadAll(io.LimitReader(first, (1<<20)+1))
	if err != nil || len(data) > 1<<20 || json.Unmarshal(data, &input) != nil {
		return input, "", errors.New("导入笔记信息无效或超过 1 MiB")
	}

	contentPart, err := reader.NextPart()
	if err != nil || contentPart.FormName() != "content" {
		return input, "", errors.New("缺少导入正文")
	}
	content, err := io.ReadAll(io.LimitReader(contentPart, maxNoteContentBytes+1))
	if err != nil || len(content) > maxNoteContentBytes {
		return input, "", errors.New("导入正文超过 16 MiB 或传输未完成")
	}
	input.Content = string(content)
	if !validID(input.ServerID) || len(input.Content) > maxNoteContentBytes || !utf8.ValidString(input.Content) || utf8.RuneCountInString(input.Title) > 200 || (input.Folder != "" && !validFolderName(input.Folder)) {
		return input, "", errors.New("导入笔记内容、标题或文件夹无效")
	}
	hashes := map[string]string{}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return input, "", errors.New("附件传输未完成或导入超过 232 MiB")
		}
		name := part.FormName()
		ext := filepath.Ext(name)
		if !validID(strings.TrimSuffix(name, ext)) || imageTypes[ext] == "" || part.FileName() != name {
			return input, "", errors.New("导入附件名称无效")
		}
		if _, exists := hashes[name]; exists {
			return input, "", errors.New("导入附件重复")
		}
		image, err := io.ReadAll(io.LimitReader(part, (10<<20)+1))
		if err != nil || len(image) > 10<<20 || http.DetectContentType(image) != imageTypes[ext] {
			return input, "", errors.New("导入图片类型无效或超过 10 MiB")
		}
		if err := os.MkdirAll(filepath.Join(stage, "assets"), 0700); err != nil {
			return input, "", err
		}
		if err := os.WriteFile(filepath.Join(stage, "assets", name), image, 0600); err != nil {
			return input, "", err
		}
		sum := sha256.Sum256(image)
		hashes[name] = hex.EncodeToString(sum[:])
	}
	for name := range imageReferences(note{ID: importID}, input.Content) {
		if _, ok := hashes[name]; !ok {
			return input, "", errors.New("导入正文缺少对应图片")
		}
	}
	canonical, _ := json.Marshal(input)
	hash := sha256.New()
	hash.Write(canonical)
	contentSum := sha256.Sum256([]byte(input.Content))
	hash.Write(contentSum[:])
	names := make([]string, 0, len(hashes))
	for name := range hashes {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		hash.Write([]byte("\x00" + name + "\x00" + hashes[name]))
	}
	return input, hex.EncodeToString(hash.Sum(nil)), nil
}

// Only our numeric MkdirTemp names are reserved for incomplete imports.
func cleanupImportStages(dataDir string) error {
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		suffix, ok := strings.CutPrefix(entry.Name(), ".import-")
		if ok && entry.IsDir() && len(suffix) >= 6 && strings.Trim(suffix, "0123456789") == "" {
			if err := os.RemoveAll(filepath.Join(dataDir, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}
