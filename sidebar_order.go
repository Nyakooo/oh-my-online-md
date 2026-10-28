package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
)

type sidebarOrder struct {
	Folders []string            `json:"folders"`
	Notes   map[string][]string `json:"notes"`
}

func (a *app) readSidebarOrder() (sidebarOrder, error) {
	order := sidebarOrder{Folders: []string{}, Notes: map[string][]string{}}
	data, err := os.ReadFile(filepath.Join(a.dataDir, ".sidebar-order.json"))
	if os.IsNotExist(err) {
		return order, nil
	}
	if err != nil {
		return order, err
	}
	err = json.Unmarshal(data, &order)
	if order.Notes == nil {
		order.Notes = map[string][]string{}
	}
	return order, err
}
func (a *app) writeSidebarOrder(order sidebarOrder) error {
	data, err := json.Marshal(order)
	if err != nil {
		return err
	}
	return atomicWriteMode(filepath.Join(a.dataDir, ".sidebar-order.json"), data, 0600)
}
func orderRanks(values []string) map[string]int {
	ranks := map[string]int{}
	for i, value := range values {
		ranks[value] = i
	}
	return ranks
}
func sortFolderSummaries(items []folderSummary, order sidebarOrder) {
	ranks := orderRanks(order.Folders)
	sort.SliceStable(items, func(i, j int) bool {
		left, lok := ranks[items[i].Name]
		right, rok := ranks[items[j].Name]
		if lok != rok {
			return lok
		}
		if lok {
			return left < right
		}
		return items[i].Name < items[j].Name
	})
}
func sortNoteSummaries(items []noteSummary, order sidebarOrder) {
	ranks := map[string]map[string]int{}
	for folder, ids := range order.Notes {
		ranks[folder] = orderRanks(ids)
	}
	sort.SliceStable(items, func(i, j int) bool {
		l, r := items[i], items[j]
		if l.Folder != r.Folder {
			return l.Folder < r.Folder
		}
		left, lok := ranks[l.Folder][l.ID]
		right, rok := ranks[r.Folder][r.ID]
		// New notes precede a saved manual order; editing existing notes preserves it.
		if lok != rok {
			return !lok
		}
		if lok {
			return left < right
		}
		if !l.UpdatedAt.Equal(r.UpdatedAt) {
			return l.UpdatedAt.After(r.UpdatedAt)
		}
		return l.ID < r.ID
	})
}
func repositionOrder(values []string, id, before string) ([]string, bool) {
	found := false
	target := before == ""
	for _, value := range values {
		if value == id {
			found = true
		}
		if value == before {
			target = true
		}
	}
	if !found || !target {
		return nil, false
	}
	if id == before {
		return values, true
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != id {
			result = append(result, value)
		}
	}
	for i, value := range result {
		if value == before {
			return append(result[:i], append([]string{id}, result[i:]...)...), true
		}
	}
	return append(result, id), true
}
func (a *app) reorderSidebar(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	var input struct {
		Kind   string `json:"kind"`
		ID     string `json:"id"`
		Before string `json:"before"`
		Folder string `json:"folder"`
	}
	if !decodeFolderInput(w, r, &input) {
		return
	}
	order, err := a.readSidebarOrder()
	if err != nil {
		writeError(w, 500, "无法读取排序设置")
		return
	}
	values := []string{}
	switch input.Kind {
	case "folder":
		entries, err := os.ReadDir(a.dataDir)
		if err != nil {
			writeError(w, 500, "无法读取文件夹")
			return
		}
		folders := []folderSummary{}
		for _, entry := range entries {
			if entry.IsDir() && a.folderExists(entry.Name()) {
				folders = append(folders, folderSummary{Name: entry.Name()})
			}
		}
		sortFolderSummaries(folders, order)
		for _, folder := range folders {
			values = append(values, folder.Name)
		}
	case "note":
		if input.Folder != "" && !a.folderExists(input.Folder) {
			writeError(w, 404, "文件夹不存在")
			return
		}
		if !a.requireFolder(w, r, input.Folder) {
			return
		}
		dirs, err := a.noteDirectories()
		if err != nil {
			writeError(w, 500, "无法读取笔记")
			return
		}
		notes := []noteSummary{}
		for _, dir := range dirs {
			parent := filepath.Dir(dir)
			if parent == "." {
				parent = ""
			}
			if parent != input.Folder {
				continue
			}
			item, err := a.readNoteFromDir(dir)
			if err == nil {
				notes = append(notes, noteSummary{ID: item.ID, Folder: parent, UpdatedAt: item.UpdatedAt})
			}
		}
		sortNoteSummaries(notes, order)
		for _, note := range notes {
			values = append(values, note.ID)
		}
	default:
		writeError(w, 400, "无效的排序范围")
		return
	}
	next, ok := repositionOrder(values, input.ID, input.Before)
	if !ok {
		writeError(w, 400, "排序项目不存在或不属于当前目录")
		return
	}
	if input.Kind == "folder" {
		order.Folders = next
	} else {
		order.Notes[input.Folder] = next
	}
	if err = a.writeSidebarOrder(order); err != nil {
		writeError(w, 500, "无法保存排序")
		return
	}
	w.WriteHeader(204)
}
func (a *app) renameSidebarOrder(old, name string) error {
	if old == name {
		return nil
	}
	if _, err := os.Stat(filepath.Join(a.dataDir, ".sidebar-order.json")); os.IsNotExist(err) {
		return nil
	}
	order, err := a.readSidebarOrder()
	if err != nil {
		return err
	}
	for i, value := range order.Folders {
		if value == old {
			order.Folders[i] = name
		}
	}
	if ids, ok := order.Notes[old]; ok {
		order.Notes[name] = ids
		delete(order.Notes, old)
	}
	return a.writeSidebarOrder(order)
}
func (a *app) removeNoteOrder(id string) error {
	if _, err := os.Stat(filepath.Join(a.dataDir, ".sidebar-order.json")); os.IsNotExist(err) {
		return nil
	}
	order, err := a.readSidebarOrder()
	if err != nil {
		return err
	}
	for folder, ids := range order.Notes {
		filtered := []string{}
		for _, value := range ids {
			if value != id {
				filtered = append(filtered, value)
			}
		}
		order.Notes[folder] = filtered
	}
	return a.writeSidebarOrder(order)
}
