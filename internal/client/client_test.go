package client

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/chunkzero/maven-r2/internal/api"
)

func TestUploadResumesPartsAndRetriesTransientFailures(t *testing.T) {
	var mu sync.Mutex
	attempts := map[string]int{}
	bodies := map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer mr2_test" {
			t.Error("missing token")
		}
		attempts[r.URL.Path]++
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/uploads"):
			json.NewEncoder(w).Encode(map[string]any{"id": "upload", "path": "x", "size": 9, "sha256": "digest", "status": "pending", "partSize": 4, "parts": []map[string]any{{"number": 1, "etag": "already-staged"}}})
		case strings.HasSuffix(r.URL.Path, "/parts/2") && attempts[r.URL.Path] == 1:
			w.WriteHeader(503)
			io.WriteString(w, `{"error":"retry"}`)
		case strings.Contains(r.URL.Path, "/parts/"):
			b, _ := io.ReadAll(r.Body)
			bodies[r.URL.Path] = string(b)
			io.WriteString(w, `{}`)
		case strings.HasSuffix(r.URL.Path, "/complete"):
			json.NewEncoder(w).Encode(api.Upload{Id: "upload", Status: api.Complete})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	c, err := New(server.URL, "mr2_test")
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.CreateTemp(t.TempDir(), "artifact")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	file.WriteString("123456789")
	if err = c.Upload(context.Background(), "session", "x", file, 9, "digest"); err != nil {
		t.Fatal(err)
	}
	if attempts["/api/publications/session/uploads/upload/parts/1"] != 0 {
		t.Fatal("re-uploaded an acknowledged part")
	}
	if attempts["/api/publications/session/uploads/upload/parts/2"] != 2 {
		t.Fatal("did not retry transient failure")
	}
	if bodies["/api/publications/session/uploads/upload/parts/2"] != "5678" || bodies["/api/publications/session/uploads/upload/parts/3"] != "9" {
		t.Fatal("incorrect part boundaries")
	}
}

func TestDoesNotFollowCredentialRedirect(t *testing.T) {
	leaked := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer source.Close()
	c, err := New(source.URL, "mr2_test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.Status(context.Background(), "session"); err == nil {
		t.Fatal("redirect should fail")
	}
	if leaked {
		t.Fatal("followed an authenticated redirect")
	}
}
