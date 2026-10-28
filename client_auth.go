package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type clientContextKey struct{}
type clientSession struct {
	ExpiresAt time.Time `json:"expiresAt"`
}

func clientIdentity(r *http.Request) string {
	value, _ := r.Context().Value(clientContextKey{}).(string)
	return value
}
func authorizedMutation(r *http.Request) bool { return clientIdentity(r) != "" || sameOrigin(r) }
func extensionOrigin(r *http.Request) bool {
	u, err := url.Parse(r.Header.Get("Origin"))
	if err != nil || u.Scheme != "chrome-extension" || len(u.Host) != 32 || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return false
	}
	return strings.Trim(u.Host, "abcdefghijklmnop") == ""
}
func clientHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Call with clientMu held. Only token digests are stored on disk.
func (a *app) readClientSessions() (map[string]clientSession, error) {
	sessions := map[string]clientSession{}
	data, err := os.ReadFile(filepath.Join(a.dataDir, ".client-sessions.json"))
	if os.IsNotExist(err) {
		return sessions, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(data, &sessions); err != nil {
		return nil, err
	}
	if sessions == nil {
		sessions = map[string]clientSession{}
	}
	return sessions, nil
}
func (a *app) writeClientSessions(sessions map[string]clientSession) error {
	for key, value := range sessions {
		if !value.ExpiresAt.After(time.Now()) {
			delete(sessions, key)
		}
	}
	data, err := json.Marshal(sessions)
	if err != nil {
		return err
	}
	return atomicWriteMode(filepath.Join(a.dataDir, ".client-sessions.json"), data, 0600)
}

// Client signatures use a separate domain and include the random identifier, so a
// client token cannot be converted into a website login cookie after revocation.
func (a *app) clientToken(random string, expires time.Time) string {
	value := strconv.FormatInt(expires.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(a.password))
	mac.Write([]byte("online-md-client:" + random + ":" + value))
	return random + "." + value + "." + hex.EncodeToString(mac.Sum(nil))
}
func (a *app) clientAuthenticated(r *http.Request) string {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	random, value, ok := strings.Cut(token, ".")
	if !ok || !validID(random) {
		return ""
	}
	expires, _, ok := strings.Cut(value, ".")
	timestamp, err := strconv.ParseInt(expires, 10, 64)
	if !ok || err != nil || timestamp <= time.Now().Unix() || !hmac.Equal([]byte(token), []byte(a.clientToken(random, time.Unix(timestamp, 0)))) {
		return ""
	}
	a.clientMu.Lock()
	defer a.clientMu.Unlock()
	sessions, err := a.readClientSessions()
	if err != nil {
		return ""
	}
	key := clientHash(token)
	session, ok := sessions[key]
	if !ok || !session.ExpiresAt.After(time.Now()) {
		return ""
	}
	return key
}
func (a *app) clientInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"clientAPI": 1, "passwordRequired": a.password != "", "features": []string{"folders", "bearerAuth", "noteVersions"}})
}
func (a *app) createClientSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" || (!sameOrigin(r) && !extensionOrigin(r)) {
		writeError(w, 403, "不允许的客户端登录请求")
		return
	}
	var input struct {
		Password string `json:"password"`
	}
	if err = json.NewDecoder(http.MaxBytesReader(w, r.Body, maxNoteRequestBytes)).Decode(&input); err != nil {
		writeError(w, 400, "无效的登录参数")
		return
	}
	supplied := sha256.Sum256([]byte(input.Password))
	expected := sha256.Sum256([]byte(a.password))
	if a.password != "" && !hmac.Equal(supplied[:], expected[:]) {
		writeError(w, 401, "密码错误")
		return
	}
	random, err := newID()
	if err != nil {
		writeError(w, 500, "无法创建客户端会话")
		return
	}
	expires := time.Now().Add(30 * 24 * time.Hour).UTC()
	token := a.clientToken(random, expires)
	a.clientMu.Lock()
	defer a.clientMu.Unlock()
	sessions, err := a.readClientSessions()
	if err != nil {
		writeError(w, 500, "无法读取客户端会话")
		return
	}
	sessions[clientHash(token)] = clientSession{ExpiresAt: expires}
	if err = a.writeClientSessions(sessions); err != nil {
		writeError(w, 500, "无法保存客户端会话")
		return
	}
	writeJSON(w, 201, map[string]any{"token": token, "expiresAt": expires})
}
func (a *app) deleteClientSession(w http.ResponseWriter, r *http.Request) {
	key := clientIdentity(r)
	if key == "" {
		writeError(w, 401, "客户端登录已失效")
		return
	}
	a.clientMu.Lock()
	defer a.clientMu.Unlock()
	sessions, err := a.readClientSessions()
	if err != nil {
		writeError(w, 500, "无法读取客户端会话")
		return
	}
	delete(sessions, key)
	if err = a.writeClientSessions(sessions); err != nil {
		writeError(w, 500, "无法撤销客户端会话")
		return
	}
	delete(a.clientGrants, key)
	w.WriteHeader(204)
}
func (a *app) clientGrant(r *http.Request, name string) string {
	a.clientMu.Lock()
	defer a.clientMu.Unlock()
	return a.clientGrants[clientIdentity(r)][name]
}
func (a *app) setClientGrant(r *http.Request, name, value string) {
	a.clientMu.Lock()
	defer a.clientMu.Unlock()
	if a.clientGrants == nil {
		a.clientGrants = map[string]map[string]string{}
	}
	key := clientIdentity(r)
	if value == "" {
		delete(a.clientGrants[key], name)
		return
	}
	if a.clientGrants[key] == nil {
		a.clientGrants[key] = map[string]string{}
	}
	a.clientGrants[key][name] = value
}
