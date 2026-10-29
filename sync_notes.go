package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type syncSummary struct {
	ID      string `json:"id"`
	Version string `json:"version"`
}
type syncStructure struct {
	Folders []string     `json:"folders"`
	Order   sidebarOrder `json:"order"`
}

func (a *app) syncVersion(item note) string {
	return syncVersionAt(item, filepath.Join(a.dataDir, item.DirName, "assets"))
}
func syncVersionAt(item note, assetsPath string) string {
	value := noteVersion(item) + "\x00" + noteFolder(item)
	entries, _ := os.ReadDir(assetsPath)
	for _, entry := range entries {
		info, err := entry.Info()
		if err == nil {
			value += "\x00" + entry.Name() + ":" + fmt.Sprint(info.Size(), ":", info.ModTime().UnixNano())
		}
	}
	return clientHash(value)
}
func structureVersion(value syncStructure) string {
	data, _ := json.Marshal(value)
	return clientHash(string(data))
}
func (a *app) syncInventory() ([]syncSummary, []string, syncStructure, error) {
	dirs, err := a.noteDirectories()
	if err != nil {
		return nil, nil, syncStructure{}, err
	}
	notes := []syncSummary{}
	excluded := []string{}
	folders := []string{}
	entries, err := os.ReadDir(a.dataDir)
	if err != nil {
		return nil, nil, syncStructure{}, err
	}
	protected := map[string]bool{}
	for _, entry := range entries {
		if a.folderExists(entry.Name()) {
			_, locked, err := a.folderPassword(entry.Name())
			if err != nil {
				return nil, nil, syncStructure{}, err
			}
			protected[entry.Name()] = locked
			if !locked {
				folders = append(folders, entry.Name())
			}
		}
	}
	for _, dir := range dirs {
		item, err := a.readNoteFromDir(dir)
		if err != nil {
			return nil, nil, syncStructure{}, err
		}
		if protected[noteFolder(item)] {
			excluded = append(excluded, item.ID)
		} else {
			notes = append(notes, syncSummary{item.ID, a.syncVersion(item)})
		}
	}
	order, err := a.readSidebarOrder()
	if err != nil {
		return nil, nil, syncStructure{}, err
	}
	// A sync client must never receive ordering metadata for protected notes.
	allowed := map[string]bool{}
	for _, n := range notes {
		allowed[n.ID] = true
	}
	clean := sidebarOrder{Folders: []string{}, Notes: map[string][]string{}}
	for _, name := range order.Folders {
		if !protected[name] {
			clean.Folders = append(clean.Folders, name)
		}
	}
	for folder, ids := range order.Notes {
		if protected[folder] {
			continue
		}
		for _, id := range ids {
			if allowed[id] {
				clean.Notes[folder] = append(clean.Notes[folder], id)
			}
		}
	}
	sort.Strings(folders)
	return notes, excluded, syncStructure{folders, clean}, nil
}
func (a *app) syncManifest(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	identity, err := a.serverID()
	if err != nil {
		writeError(w, 500, "无法读取服务器身份")
		return
	}
	notes, excluded, structure, err := a.syncInventory()
	if err != nil {
		writeError(w, 500, "无法读取同步清单")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"syncAPI": 1, "serverID": identity, "notes": notes, "excluded": excluded, "structure": structure, "structureVersion": structureVersion(structure)})
}
func (a *app) syncReadNote(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	item, ok := a.requestNote(w, r)
	if !ok {
		return
	}
	if _, protected, err := a.folderPassword(noteFolder(item)); noteFolder(item) != "" && (err != nil || protected) {
		writeError(w, 403, "密码文件夹不参与离线同步")
		return
	}
	assets := []string{}
	entries, err := os.ReadDir(filepath.Join(a.dataDir, item.DirName, "assets"))
	if err != nil && !os.IsNotExist(err) {
		writeError(w, 500, "无法读取图片清单")
		return
	}
	for _, entry := range entries {
		ext := filepath.Ext(entry.Name())
		if entry.Type().IsRegular() && imageTypes[ext] != "" && validID(strings.TrimSuffix(entry.Name(), ext)) {
			assets = append(assets, entry.Name())
		}
	}
	item.Version = a.syncVersion(item)
	writeJSON(w, 200, map[string]any{"note": item, "assets": assets})
}
func (a *app) syncReadAsset(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	ext := filepath.Ext(name)
	if imageTypes[ext] == "" || !validID(strings.TrimSuffix(name, ext)) {
		http.NotFound(w, r)
		return
	}
	a.writeMu.Lock()
	item, ok := a.requestNote(w, r)
	if !ok {
		a.writeMu.Unlock()
		return
	}
	if folder := noteFolder(item); folder != "" {
		_, protected, err := a.folderPassword(folder)
		if err != nil || protected {
			a.writeMu.Unlock()
			writeError(w, 403, "密码文件夹不参与离线同步")
			return
		}
	}
	if strings.Trim(r.Header.Get("If-Match"), "\"") != a.syncVersion(item) {
		a.writeMu.Unlock()
		writeError(w, 412, "笔记已变化，请重新同步")
		return
	}
	file, err := os.Open(filepath.Join(a.dataDir, item.DirName, "assets", name))
	a.writeMu.Unlock()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", imageTypes[ext])
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("ETag", "\""+a.syncVersion(item)+"\"")
	http.ServeContent(w, r, name, info.ModTime(), file)
}

type syncReceipt struct {
	ID      string `json:"id"`
	Hash    string `json:"hash"`
	Version string `json:"version"`
	Deleted bool   `json:"deleted"`
}
type syncJournal struct {
	Receipt syncReceipt `json:"receipt"`
	OldPath string      `json:"oldPath"`
	NewPath string      `json:"newPath"`
}

func validSyncPath(path string) bool {
	parts := strings.Split(path, string(filepath.Separator))
	if len(parts) > 2 {
		return false
	}
	for _, part := range parts {
		if !validFolderName(part) {
			return false
		}
	}
	return true
}
func (a *app) finishSyncJournal(directory, operation string, record syncJournal) error {
	if !validID(operation) || !validID(record.Receipt.ID) || (record.OldPath != "" && !validSyncPath(record.OldPath)) || (!record.Receipt.Deleted && !validSyncPath(record.NewPath)) {
		return errors.New("invalid sync journal")
	}
	receipts := filepath.Join(a.dataDir, ".sync-receipts")
	receiptPath := filepath.Join(receipts, operation+".json")
	if _, err := os.Stat(receiptPath); err == nil {
		return os.RemoveAll(directory)
	}
	backup := filepath.Join(directory, "old")
	staged := filepath.Join(directory, "new")
	if record.OldPath != "" {
		if _, err := os.Stat(backup); os.IsNotExist(err) {
			if err := os.Rename(filepath.Join(a.dataDir, record.OldPath), backup); err != nil {
				return err
			}
		}
	}
	if !record.Receipt.Deleted {
		if _, err := os.Stat(staged); err == nil {
			if err := os.Rename(staged, filepath.Join(a.dataDir, record.NewPath)); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	if err := os.MkdirAll(receipts, 0700); err != nil {
		return err
	}
	data, err := json.Marshal(record.Receipt)
	if err != nil {
		return err
	}
	if err := atomicWriteMode(receiptPath, data, 0600); err != nil {
		return err
	}
	return os.RemoveAll(directory)
}
func (a *app) recoverSyncJournals() error {
	entries, err := os.ReadDir(a.dataDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		operation, ok := strings.CutPrefix(entry.Name(), ".sync-journal-")
		if !ok || !validID(operation) || !entry.IsDir() {
			continue
		}
		directory := filepath.Join(a.dataDir, entry.Name())
		data, err := os.ReadFile(filepath.Join(directory, "intent.json"))
		if os.IsNotExist(err) {
			if _, backupErr := os.Lstat(filepath.Join(directory, "old")); os.IsNotExist(backupErr) {
				if err := os.RemoveAll(directory); err != nil {
					return err
				}
				continue
			}
		}
		if err != nil {
			return err
		}
		var record syncJournal
		if err := json.Unmarshal(data, &record); err != nil {
			return err
		}
		if err := a.finishSyncJournal(directory, operation, record); err != nil {
			return err
		}
	}
	return nil
}
func (a *app) syncWriteNote(w http.ResponseWriter, r *http.Request) {
	if !authorizedMutation(r) {
		writeError(w, 403, "invalid origin")
		return
	}
	id, operation := r.PathValue("id"), r.Header.Get("X-Sync-Operation")
	if !validID(id) || !validID(operation) {
		writeError(w, 400, "同步标识无效")
		return
	}
	base := strings.Trim(r.Header.Get("If-Match"), "\"")
	deleting := r.Method == http.MethodDelete
	var input importNoteInput
	digest := "delete"
	stage := ""
	if !deleting {
		if r.ContentLength > maxImportBytes {
			writeError(w, 413, "同步请求超过 232 MiB")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxImportBytes)
		reader, err := r.MultipartReader()
		if err != nil {
			writeError(w, 400, "同步数据无效")
			return
		}
		stage, err = os.MkdirTemp(a.dataDir, ".import-")
		if err != nil {
			writeError(w, 500, "无法暂存同步数据")
			return
		}
		defer os.RemoveAll(stage)
		input, digest, err = readImport(reader, stage, id)
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
	} else {
		input.ServerID = r.Header.Get("X-Server-ID")
	}
	digest = clientHash(id + "\x00" + base + "\x00" + input.ServerID + "\x00" + digest)
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	// Recover a prior interrupted commit before accepting another operation.
	if err := a.recoverSyncJournals(); err != nil {
		writeError(w, 500, "同步提交待恢复，请检查数据目录后重试")
		return
	}
	identity, err := a.serverID()
	if err != nil {
		writeError(w, 500, "无法读取服务器身份")
		return
	}
	if identity != input.ServerID {
		writeError(w, 409, "目标服务器身份已变化")
		return
	}
	receiptPath := filepath.Join(a.dataDir, ".sync-receipts", operation+".json")
	if data, err := os.ReadFile(receiptPath); err == nil {
		var receipt syncReceipt
		if json.Unmarshal(data, &receipt) != nil || receipt.Hash != digest {
			writeError(w, 409, "同步操作标识已被使用")
			return
		}
		writeJSON(w, 200, receipt)
		return
	} else if !os.IsNotExist(err) {
		writeError(w, 500, "无法读取同步回执")
		return
	}
	previous, readErr := a.readNote(id)
	exists := readErr == nil
	if readErr != nil && !os.IsNotExist(readErr) {
		writeError(w, 500, "无法读取同步笔记")
		return
	}
	if exists {
		folder := noteFolder(previous)
		if folder != "" {
			_, protected, err := a.folderPassword(folder)
			if err != nil || protected {
				writeError(w, 403, "密码文件夹不参与离线同步")
				return
			}
		}
		if base != a.syncVersion(previous) {
			writeError(w, 412, "服务器版本已变化")
			return
		}
	} else if !deleting && base != "none" {
		writeError(w, 404, "服务器笔记已删除")
		return
	}
	receipt := syncReceipt{ID: id, Hash: digest, Deleted: deleting}
	record := syncJournal{Receipt: receipt}
	if exists {
		record.OldPath = previous.DirName
	}
	if !deleting {
		parent := input.Folder
		if parent != "" {
			if a.folderExists(parent) {
				_, protected, err := a.folderPassword(parent)
				if err != nil || protected {
					writeError(w, 403, "目标文件夹受保护")
					return
				}
			} else if err := os.Mkdir(filepath.Join(a.dataDir, parent), 0755); err != nil {
				writeError(w, 409, "无法创建目标文件夹")
				return
			}
		}
		leaf := safeFolderName(input.Title) + "_" + id
		if exists {
			leaf = filepath.Base(previous.DirName)
		}
		record.NewPath = filepath.Join(parent, leaf)
		now := time.Now().UTC()
		item := note{ID: id, Title: normalizeTitle(input.Title), Content: input.Content, UpdatedAt: now, DirName: record.NewPath}
		metadata, _ := json.Marshal(noteMetadata{item.ID, item.Title, item.UpdatedAt})
		for name, data := range map[string][]byte{"meta.json": metadata, "note.md": []byte(item.Content)} {
			if err := os.WriteFile(filepath.Join(stage, name), data, 0600); err != nil {
				writeError(w, 500, "无法暂存同步正文")
				return
			}
		}
		if exists {
			if err := copySyncExtras(filepath.Join(a.dataDir, previous.DirName), stage, previous); err != nil {
				if errors.Is(err, errSyncAssetChanged) {
					writeError(w, 412, "服务器图片已变化")
					return
				}
				writeError(w, 500, "无法保留笔记的分享或其他文件，原笔记未修改")
				return
			}
		}
		if record.NewPath != record.OldPath {
			if _, err := os.Lstat(filepath.Join(a.dataDir, record.NewPath)); err == nil || !os.IsNotExist(err) {
				writeError(w, 409, "同步目标目录已存在，未覆盖原数据")
				return
			}
		}
		record.Receipt.Version = syncVersionAt(item, filepath.Join(stage, "assets"))
	}
	// Deleting an already absent note is idempotent too.
	directory := filepath.Join(a.dataDir, ".sync-journal-"+operation)
	if err := os.Mkdir(directory, 0700); err != nil {
		writeError(w, 500, "无法创建同步事务")
		return
	}
	if !deleting {
		if err := os.Rename(stage, filepath.Join(directory, "new")); err != nil {
			os.RemoveAll(directory)
			writeError(w, 500, "无法暂存同步事务")
			return
		}
	}
	data, _ := json.Marshal(record)
	if err := atomicWriteMode(filepath.Join(directory, "intent.json"), data, 0600); err != nil {
		os.RemoveAll(directory)
		writeError(w, 500, "无法保存同步事务")
		return
	}
	if err := a.finishSyncJournal(directory, operation, record); err != nil {
		writeError(w, 500, "同步提交待恢复，请重试")
		return
	}
	writeJSON(w, 200, record.Receipt)
}

func (a *app) syncWriteStructure(w http.ResponseWriter, r *http.Request) {
	if !authorizedMutation(r) {
		writeError(w, 403, "invalid origin")
		return
	}
	var input struct {
		ServerID  string        `json:"serverID"`
		Structure syncStructure `json:"structure"`
	}
	if !decodeNoteInput(w, r, &input) {
		return
	}
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	identity, err := a.serverID()
	if err != nil || identity != input.ServerID {
		writeError(w, 409, "目标服务器身份已变化")
		return
	}
	_, _, current, err := a.syncInventory()
	if err != nil {
		writeError(w, 500, "无法读取目录顺序")
		return
	}
	if strings.Trim(r.Header.Get("If-Match"), "\"") != structureVersion(current) {
		writeError(w, 412, "目录或排序已变化")
		return
	}
	desired := map[string]bool{}
	for _, folder := range input.Structure.Folders {
		if !validFolderName(folder) {
			writeError(w, 400, "文件夹名称无效")
			return
		}
		desired[folder] = true
		if a.folderExists(folder) {
			_, protected, err := a.folderPassword(folder)
			if err != nil || protected {
				writeError(w, 403, "密码文件夹不参与离线同步")
				return
			}
		} else if err := os.Mkdir(filepath.Join(a.dataDir, folder), 0755); err != nil {
			writeError(w, 409, "无法创建同步文件夹")
			return
		}
	}
	// Only empty ordinary folders may disappear during a rename. Never delete notes.
	for _, folder := range current.Folders {
		if !desired[folder] {
			if err := os.Remove(filepath.Join(a.dataDir, folder)); err != nil && !os.IsNotExist(err) {
				desired[folder] = true
			}
		}
	}
	order, err := a.readSidebarOrder()
	if err != nil {
		writeError(w, 500, "无法读取顺序")
		return
	}
	protectedOrder := sidebarOrder{Folders: []string{}, Notes: map[string][]string{}}
	for _, folder := range order.Folders {
		if !desired[folder] && a.folderExists(folder) {
			protectedOrder.Folders = append(protectedOrder.Folders, folder)
		}
	}
	for folder, ids := range order.Notes {
		if folder != "" {
			_, protected, _ := a.folderPassword(folder)
			if protected {
				protectedOrder.Notes[folder] = ids
			}
		}
	}
	seen := map[string]bool{}
	for _, folder := range input.Structure.Order.Folders {
		if desired[folder] && !seen[folder] {
			protectedOrder.Folders = append(protectedOrder.Folders, folder)
			seen[folder] = true
		}
	}
	for folder, ids := range input.Structure.Order.Notes {
		if folder != "" && !desired[folder] {
			continue
		}
		list := []string{}
		seen := map[string]bool{}
		for _, id := range ids {
			item, err := a.readNote(id)
			if err == nil && noteFolder(item) == folder && !seen[id] {
				list = append(list, id)
				seen[id] = true
			}
		}
		protectedOrder.Notes[folder] = list
	}
	if err := a.writeSidebarOrder(protectedOrder); err != nil {
		writeError(w, 500, "无法保存顺序")
		return
	}
	_, _, result, err := a.syncInventory()
	if err != nil {
		writeError(w, 500, "无法读取同步结果")
		return
	}
	writeJSON(w, 200, map[string]any{"structure": result, "structureVersion": structureVersion(result)})
}

func copySyncExtras(source, destination string, previous note) error {
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == "meta.json" || entry.Name() == "note.md" {
			continue
		}
		if entry.Name() == "assets" {
			assets, err := os.ReadDir(filepath.Join(source, "assets"))
			if err != nil {
				return err
			}
			referenced := imageReferences(previous, previous.Content)
			if err := os.MkdirAll(filepath.Join(destination, "assets"), 0700); err != nil {
				return err
			}
			for _, asset := range assets {
				name := asset.Name()
				ext := filepath.Ext(name)
				managed := asset.Type().IsRegular() && imageTypes[ext] != "" && validID(strings.TrimSuffix(name, ext))
				target := filepath.Join(destination, "assets", name)
				if _, err := os.Lstat(target); err == nil {
					if !managed {
						return errors.New("sync attachment collides with a user file")
					}
					before, err := syncFileHash(filepath.Join(source, "assets", name))
					if err != nil {
						return err
					}
					incoming, err := syncFileHash(target)
					if err != nil {
						return err
					}
					if before != incoming {
						return errSyncAssetChanged
					}
					continue
				} else if !os.IsNotExist(err) {
					return err
				}
				// Only previously referenced managed images may be intentionally
				// removed. Preserve user files and another window's new uploads.
				if managed && referenced[name] {
					continue
				}
				if err := copySyncPath(filepath.Join(source, "assets", name), target); err != nil {
					return err
				}
			}
			continue
		}
		if err := copySyncPath(filepath.Join(source, entry.Name()), filepath.Join(destination, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}
func copySyncPath(source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if info.IsDir() {
		if err := os.Mkdir(destination, 0700); err != nil {
			return err
		}
		entries, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copySyncPath(filepath.Join(source, entry.Name()), filepath.Join(destination, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return errors.New("unsupported file in note directory")
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

var errSyncAssetChanged = errors.New("server attachment changed")

func syncFileHash(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
