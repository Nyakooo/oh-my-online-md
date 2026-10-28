package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
)

type folderSummary struct {
	Name      string `json:"name"`
	Protected bool   `json:"protected"`
	Locked    bool   `json:"locked"`
}

// User folders occupy the first level; note directories occupy the root or a folder.
// Never follow directory symlinks, including ones created outside the editor.
func (a *app) safeDirectory(relative string) bool {
	if relative == "" || filepath.IsAbs(relative) || filepath.Clean(relative) != relative {
		return false
	}
	parts := strings.Split(relative, string(filepath.Separator))
	if len(parts) > 2 {
		return false
	}
	current := a.dataDir
	for _, part := range parts {
		if !validFolderName(part) {
			return false
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return false
		}
	}
	return true
}
func validFolderName(name string) bool {
	if name == "" || strings.TrimSpace(name) != name || strings.HasPrefix(name, ".") || len(name) > 255 || strings.ContainsAny(name, "/\\") {
		return false
	}
	return !strings.ContainsFunc(name, unicode.IsControl)
}
func (a *app) isNoteDirectory(dir string) bool {
	for _, name := range []string{"meta.json", "note.md"} {
		if _, err := os.Lstat(filepath.Join(a.dataDir, dir, name)); !os.IsNotExist(err) {
			return true
		}
	}
	return false
}
func (a *app) folderExists(name string) bool {
	return validFolderName(name) && a.safeDirectory(name) && !a.isNoteDirectory(name)
}
func (a *app) noteDirectories() ([]string, error) {
	entries, err := os.ReadDir(a.dataDir)
	if err != nil {
		return nil, err
	}
	dirs := []string{}
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() || !a.safeDirectory(name) {
			continue
		}
		if a.isNoteDirectory(name) {
			dirs = append(dirs, name)
			continue
		}
		children, err := os.ReadDir(filepath.Join(a.dataDir, name))
		if err != nil {
			return nil, err
		}
		for _, child := range children {
			dir := filepath.Join(name, child.Name())
			if child.IsDir() && a.safeDirectory(dir) && a.isNoteDirectory(dir) {
				dirs = append(dirs, dir)
			}
		}
	}
	return dirs, nil
}
func noteFolder(item note) string {
	parent := filepath.Dir(item.DirName)
	if parent == "." {
		return ""
	}
	return parent
}
func (a *app) folderPassword(name string) ([]byte, bool, error) {
	filename := filepath.Join(a.dataDir, name, ".pwd")
	info, err := os.Lstat(filename)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, true, err
	}
	if !info.Mode().IsRegular() {
		return nil, true, errors.New("invalid password file")
	}
	password, err := os.ReadFile(filename)
	return password, true, err
}
func folderCookieName(name string) string {
	sum := sha256.Sum256([]byte(name))
	return "online_md_folder_" + hex.EncodeToString(sum[:12])
}
func (a *app) folderToken(name string, password []byte, expires string) string {
	a.folderKeyOnce.Do(func() {
		a.folderKey = make([]byte, 32)
		if _, err := rand.Read(a.folderKey); err != nil {
			panic(err)
		}
	})
	mac := hmac.New(sha256.New, a.folderKey)
	mac.Write([]byte(name))
	mac.Write([]byte{0})
	mac.Write(password)
	mac.Write([]byte{0})
	mac.Write([]byte(expires))
	return expires + "." + hex.EncodeToString(mac.Sum(nil))
}
func (a *app) folderAllowed(r *http.Request, name string) bool {
	if name == "" {
		return true
	}
	password, protected, err := a.folderPassword(name)
	if err != nil {
		return false
	}
	if !protected {
		return true
	}
	value := ""
	if clientIdentity(r) != "" {
		value = a.clientGrant(r, name)
	} else {
		cookie, err := r.Cookie(folderCookieName(name))
		if err != nil {
			return false
		}
		value = cookie.Value
	}
	expires, _, ok := strings.Cut(value, ".")
	timestamp, err := strconv.ParseInt(expires, 10, 64)
	return ok && err == nil && timestamp > time.Now().Unix() && hmac.Equal([]byte(value), []byte(a.folderToken(name, password, expires)))
}
func (a *app) requireFolder(w http.ResponseWriter, r *http.Request, name string) bool {
	if a.folderAllowed(r, name) {
		return true
	}
	writeError(w, http.StatusForbidden, "请先解锁文件夹")
	return false
}
func (a *app) requestNote(w http.ResponseWriter, r *http.Request) (note, bool) {
	item, err := a.readNote(r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "笔记不存在")
		return note{}, false
	}
	if !a.requireFolder(w, r, noteFolder(item)) {
		return note{}, false
	}
	w.Header().Set("Cache-Control", "no-store")
	return item, true
}
func (a *app) listFolders(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	entries, err := os.ReadDir(a.dataDir)
	if err != nil {
		writeError(w, 500, "无法读取文件夹")
		return
	}
	folders := []folderSummary{}
	for _, entry := range entries {
		if !entry.IsDir() || !a.folderExists(entry.Name()) {
			continue
		}
		_, protected, err := a.folderPassword(entry.Name())
		if err != nil {
			protected = true
		}
		folders = append(folders, folderSummary{Name: entry.Name(), Protected: protected, Locked: !a.folderAllowed(r, entry.Name())})
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, folders)
}
func decodeFolderInput(w http.ResponseWriter, r *http.Request, input any) bool {
	if !authorizedMutation(r) {
		writeError(w, 403, "invalid origin")
		return false
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxNoteRequestBytes)).Decode(input); err != nil {
		writeError(w, 400, "无效的文件夹参数")
		return false
	}
	return true
}
func (a *app) saveFolder(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	var input struct {
		Name         string  `json:"name"`
		Password     *string `json:"password"`
		KeepPassword bool    `json:"keepPassword"`
	}
	if !decodeFolderInput(w, r, &input) {
		return
	}
	if !validFolderName(input.Name) {
		writeError(w, 400, "名称不能以点开头，不能包含路径分隔符或控制字符")
		return
	}
	old := r.PathValue("name")
	creating := r.Method == http.MethodPost
	if !creating {
		if !a.folderExists(old) {
			writeError(w, 404, "文件夹不存在")
			return
		}
		if !a.requireFolder(w, r, old) {
			return
		}
	}
	if creating || old != input.Name {
		if _, err := os.Lstat(filepath.Join(a.dataDir, input.Name)); !os.IsNotExist(err) {
			writeError(w, 409, "已存在同名目录")
			return
		}
	}
	if input.KeepPassword {
		if creating {
			writeError(w, 400, "新文件夹需要提供密码")
			return
		}
		password, protected, err := a.folderPassword(old)
		if err != nil || !protected {
			writeError(w, 400, "无法保留原密码")
			return
		}
		value := string(password)
		input.Password = &value
	}
	dir := filepath.Join(a.dataDir, input.Name)
	if creating {
		if err := os.Mkdir(dir, 0755); err != nil {
			writeError(w, 500, "无法创建文件夹")
			return
		}
	} else if old != input.Name {
		if err := os.Rename(filepath.Join(a.dataDir, old), dir); err != nil {
			writeError(w, 500, "无法重命名文件夹")
			return
		}
	}
	var err error
	if input.Password != nil {
		err = atomicWriteMode(filepath.Join(dir, ".pwd"), []byte(*input.Password), 0600)
	} else {
		err = os.Remove(filepath.Join(dir, ".pwd"))
		if os.IsNotExist(err) {
			err = nil
		}
	}
	if err != nil {
		if creating {
			_ = os.Remove(dir)
		} else if old != input.Name {
			_ = os.Rename(dir, filepath.Join(a.dataDir, old))
		}
		writeError(w, 500, "无法更新 .pwd 文件，修改未完成")
		return
	}
	if input.Password != nil {
		a.setFolderCookie(w, r, input.Name, []byte(*input.Password))
	}
	w.Header().Set("Cache-Control", "no-store")
	status := 200
	if creating {
		status = 201
	}
	writeJSON(w, status, folderSummary{Name: input.Name, Protected: input.Password != nil, Locked: false})
}
func (a *app) setFolderCookie(w http.ResponseWriter, r *http.Request, name string, password []byte) {
	expires := strconv.FormatInt(time.Now().Add(12*time.Hour).Unix(), 10)
	if clientIdentity(r) != "" {
		a.setClientGrant(r, name, a.folderToken(name, password, expires))
		return
	}
	http.SetCookie(w, &http.Cookie{Name: folderCookieName(name), Value: a.folderToken(name, password, expires), Path: "/", HttpOnly: true, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", SameSite: http.SameSiteStrictMode})
}
func (a *app) unlockFolder(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	var input struct {
		Password string `json:"password"`
	}
	if !decodeFolderInput(w, r, &input) {
		return
	}
	name := r.PathValue("name")
	if !a.folderExists(name) {
		writeError(w, 404, "文件夹不存在")
		return
	}
	password, protected, err := a.folderPassword(name)
	if err != nil {
		writeError(w, 500, "无法读取 .pwd 文件")
		return
	}
	if protected && !hmac.Equal(password, []byte(input.Password)) {
		writeError(w, 403, "密码不正确，请重试")
		return
	}
	if protected {
		a.setFolderCookie(w, r, name, password)
	}
	w.WriteHeader(204)
}
func (a *app) lockFolder(w http.ResponseWriter, r *http.Request) {
	if !authorizedMutation(r) {
		writeError(w, 403, "invalid origin")
		return
	}
	name := r.PathValue("name")
	if !validFolderName(name) {
		writeError(w, 400, "无效的文件夹名称")
		return
	}
	if clientIdentity(r) != "" {
		a.setClientGrant(r, name, "")
		w.WriteHeader(204)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: folderCookieName(name), Value: "", Path: "/", HttpOnly: true, MaxAge: -1, SameSite: http.SameSiteStrictMode})
	w.WriteHeader(204)
}
func (a *app) moveNote(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	var input struct {
		Folder string `json:"folder"`
	}
	if !decodeFolderInput(w, r, &input) {
		return
	}
	item, ok := a.requestNote(w, r)
	if !ok {
		return
	}
	if input.Folder != "" {
		if !a.folderExists(input.Folder) {
			writeError(w, 404, "目标文件夹不存在")
			return
		}
		if !a.requireFolder(w, r, input.Folder) {
			return
		}
	}
	target := filepath.Join(input.Folder, filepath.Base(item.DirName))
	if target != item.DirName {
		if _, err := os.Lstat(filepath.Join(a.dataDir, target)); !os.IsNotExist(err) {
			writeError(w, 409, "目标位置存在同名笔记目录")
			return
		}
		if err := os.Rename(filepath.Join(a.dataDir, item.DirName), filepath.Join(a.dataDir, target)); err != nil {
			writeError(w, 500, "无法移动笔记目录")
			return
		}
	}
	item.DirName = target
	item.Folder = input.Folder
	writeJSON(w, 200, item)
}
