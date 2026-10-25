package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const sessionCookieName = "online_md_session"

func (a *app) sessionValue(expires time.Time) string {
	value := strconv.FormatInt(expires.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(a.password))
	mac.Write([]byte("online-md-session:" + value))
	return value + "." + hex.EncodeToString(mac.Sum(nil))
}

func (a *app) authenticated(r *http.Request) bool {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return false
	}
	timestamp, _, ok := strings.Cut(cookie.Value, ".")
	expires, err := strconv.ParseInt(timestamp, 10, 64)
	if !ok || err != nil || time.Now().Unix() >= expires {
		return false
	}
	return hmac.Equal([]byte(cookie.Value), []byte(a.sessionValue(time.Unix(expires, 0))))
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return r.Header.Get("Sec-Fetch-Site") != "cross-site"
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host == r.Host && (u.Scheme == "http" || u.Scheme == "https")
}

func (a *app) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.password != "" && !a.authenticated(r) {
			w.Header().Set("Cache-Control", "no-store")
			if r.Method == http.MethodGet && r.URL.Path == "/" {
				http.Redirect(w, r, "/login", http.StatusSeeOther)
			} else {
				http.Error(w, "authentication required", http.StatusUnauthorized)
			}
			return
		}
		if a.password != "" && r.Method != http.MethodGet && r.Method != http.MethodHead && !sameOrigin(r) {
			http.Error(w, "invalid origin", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *app) serveLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if a.password == "" || a.authenticated(r) {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	page, err := webFiles.ReadFile("web/login.html")
	if err != nil {
		http.Error(w, "cannot load login page", 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(page)
}

func (a *app) login(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !sameOrigin(r) {
		http.Error(w, "invalid origin", http.StatusForbidden)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	supplied := sha256.Sum256([]byte(r.PostForm.Get("password")))
	expected := sha256.Sum256([]byte(a.password))
	if a.password != "" && subtle.ConstantTimeCompare(supplied[:], expected[:]) != 1 {
		writeError(w, http.StatusUnauthorized, "密码错误")
		return
	}
	if a.password != "" {
		expires := time.Now().Add(30 * 24 * time.Hour)
		http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: a.sessionValue(expires), Path: "/", Expires: expires, MaxAge: 30 * 24 * 60 * 60, HttpOnly: true, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", SameSite: http.SameSiteStrictMode})
	}
	w.WriteHeader(http.StatusNoContent)
}
