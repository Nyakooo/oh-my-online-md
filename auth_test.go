package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPasswordLogin(t *testing.T) {
	a := &app{dataDir: t.TempDir(), password: "test-password"}
	handler := a.routes()
	request := func(method, path, body string, cookie *http.Cookie, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://notes.example.com"+path, strings.NewReader(body))
		if body != "" {
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
		if cookie != nil {
			r.AddCookie(cookie)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := request("GET", "/", "", nil, ""); w.Code != 303 || w.Header().Get("Location") != "/login" || w.Header().Get("WWW-Authenticate") != "" {
		t.Fatal("must use password login instead of Basic Auth", w.Code)
	}
	if w := request("GET", "/login", "", nil, ""); w.Code != 200 || !strings.Contains(w.Body.String(), `type="password"`) || strings.Contains(w.Body.String(), `name="username"`) {
		t.Fatal("password-only page missing")
	}
	if w := request("POST", "/login", "password=wrong", nil, ""); w.Code != 401 || len(w.Result().Cookies()) != 0 {
		t.Fatal("wrong password accepted")
	}
	if w := request("POST", "/login", "password=test-password", nil, "https://evil.example"); w.Code != 403 {
		t.Fatal("cross-origin login accepted")
	}
	w := request("POST", "/login", "password=test-password", nil, "https://notes.example.com")
	if w.Code != 204 || len(w.Result().Cookies()) != 1 {
		t.Fatalf("login failed: %d", w.Code)
	}
	cookie := w.Result().Cookies()[0]
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" {
		t.Fatal("cookie protections missing")
	}
	if w := request("GET", "/api/notes", "", cookie, ""); w.Code != 200 {
		t.Fatal("session rejected")
	}
	if w := request("GET", "/login", "", cookie, ""); w.Code != 303 {
		t.Fatal("logged-in user still sees login page")
	}
	if w := request("POST", "/api/notes", "{}", cookie, "https://evil.example"); w.Code != 403 {
		t.Fatal("cross-origin write accepted")
	}
	for _, value := range []string{cookie.Value + "x", a.sessionValue(time.Now().Add(-time.Hour)), "invalid"} {
		bad := *cookie
		bad.Value = value
		if w := request("GET", "/api/notes", "", &bad, ""); w.Code != 401 {
			t.Fatal("invalid session accepted")
		}
	}
	a.password = "changed-password"
	if w := request("GET", "/api/notes", "", cookie, ""); w.Code != 401 {
		t.Fatal("old password session accepted")
	}
	a.password = ""
	if w := request("GET", "/api/notes", "", nil, ""); w.Code != 200 {
		t.Fatal("password-free mode blocked")
	}
	if w := request("GET", "/login", "", nil, ""); w.Code != 303 {
		t.Fatal("password-free mode shows login")
	}
}
