package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLocalProxyRejectsUntrustedRequests(t *testing.T) {
	server := &Server{URL: "http://127.0.0.1:4321", Password: "local-secret"}
	for _, test := range []struct {
		name, host, origin, password, path string
		want                               int
	}{
		{"no credentials", "127.0.0.1:4321", "", "", "/g/a/1/a-1.jar", 401},
		{"DNS rebinding", "evil.example:4321", "", "local-secret", "/g/a/1/a-1.jar", 403},
		{"browser origin", "127.0.0.1:4321", "https://evil.example", "local-secret", "/g/a/1/a-1.jar", 403},
		{"traversal", "127.0.0.1:4321", "", "local-secret", "/g/../a/1/a-1.jar", 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPut, server.URL+test.path, nil)
			r.Host = test.host
			if test.origin != "" {
				r.Header.Set("Origin", test.origin)
			}
			if test.password != "" {
				r.SetBasicAuth("local", test.password)
			}
			w := httptest.NewRecorder()
			server.ServeHTTP(w, r)
			if w.Code != test.want {
				t.Fatalf("got %d, want %d", w.Code, test.want)
			}
		})
	}
}
