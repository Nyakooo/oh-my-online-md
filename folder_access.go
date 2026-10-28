package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"net/http"
	"strings"
	"time"
)

const folderIdleTimeout = 5 * time.Minute

type folderGrant struct {
	PasswordHash [32]byte
	LastActivity time.Time
}

func folderWindowKey(r *http.Request) string {
	window := r.Header.Get("X-Note-Window")
	if !validID(window) {
		return ""
	}
	if client := clientIdentity(r); client != "" {
		return "client:" + client + "/" + window
	}
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		return "web:" + clientHash(cookie.Value) + "/" + window
	}
	return "web/" + window
}
func (a *app) pruneFolderGrants() {
	for key, grants := range a.folderGrants {
		for name, grant := range grants {
			if time.Since(grant.LastActivity) >= folderIdleTimeout {
				delete(grants, name)
			}
		}
		if len(grants) == 0 {
			delete(a.folderGrants, key)
		}
	}
}
func (a *app) windowFolderAllowed(r *http.Request, name string, password []byte) bool {
	key := folderWindowKey(r)
	if key == "" {
		return false
	}
	a.clientMu.Lock()
	defer a.clientMu.Unlock()
	a.pruneFolderGrants()
	grant, ok := a.folderGrants[key][name]
	if !ok {
		return false
	}
	expected := sha256.Sum256(password)
	return hmac.Equal(expected[:], grant.PasswordHash[:])
}
func (a *app) grantFolder(w http.ResponseWriter, r *http.Request, name string, password []byte) bool {
	key := folderWindowKey(r)
	if key == "" {
		writeError(w, 400, "请刷新页面或更新扩展后重新解锁")
		return false
	}
	a.clientMu.Lock()
	defer a.clientMu.Unlock()
	a.pruneFolderGrants()
	if a.folderGrants == nil {
		a.folderGrants = map[string]map[string]folderGrant{}
	}
	if a.folderGrants[key] == nil {
		a.folderGrants[key] = map[string]folderGrant{}
	}
	a.folderGrants[key][name] = folderGrant{PasswordHash: sha256.Sum256(password), LastActivity: time.Now()}
	return true
}
func (a *app) revokeFolderAccess(name string) {
	a.clientMu.Lock()
	defer a.clientMu.Unlock()
	for key, grants := range a.folderGrants {
		delete(grants, name)
		if len(grants) == 0 {
			delete(a.folderGrants, key)
		}
	}
}
func (a *app) lockWindow(w http.ResponseWriter, r *http.Request) {
	if !authorizedMutation(r) {
		writeError(w, 403, "invalid origin")
		return
	}
	a.clientMu.Lock()
	delete(a.folderGrants, folderWindowKey(r))
	a.clientMu.Unlock()
	w.WriteHeader(204)
}
func (a *app) touchFolder(w http.ResponseWriter, r *http.Request) {
	if !authorizedMutation(r) {
		writeError(w, 403, "invalid origin")
		return
	}
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	name := r.PathValue("name")
	if !a.folderExists(name) {
		writeError(w, 404, "文件夹不存在")
		return
	}
	if !a.requireFolder(w, r, name) {
		return
	}
	a.clientMu.Lock()
	defer a.clientMu.Unlock()
	key := folderWindowKey(r)
	grant, ok := a.folderGrants[key][name]
	if ok {
		grant.LastActivity = time.Now()
		a.folderGrants[key][name] = grant
	}
	w.WriteHeader(204)
}
func (a *app) revokeClientFolderAccessLocked(client string) {
	for key := range a.folderGrants {
		if strings.HasPrefix(key, "client:"+client+"/") {
			delete(a.folderGrants, key)
		}
	}
}
