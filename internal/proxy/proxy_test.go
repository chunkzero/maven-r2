package proxy

import (
	"context"
	"encoding/json"
	"github.com/chunkzero/maven-r2/internal/api"
	"github.com/chunkzero/maven-r2/internal/client"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestUploadComputesAllChecksumsWhileSpooling(t *testing.T) {
	expected := api.Checksums{
		Md5:    "900150983cd24fb0d6963f7d28e17f72",
		Sha1:   "a9993e364706816aba3e25717850c26c9cd0d89d",
		Sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		Sha512: "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/uploads"):
			var input api.CreateUpload
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
			}
			if input.Checksums != expected || input.Size != 3 {
				t.Errorf("unexpected declaration: %+v", input)
			}
			json.NewEncoder(w).Encode(api.Upload{Id: "upload", PartSize: 16, Status: api.Pending})
		case strings.HasSuffix(r.URL.Path, "/parts/1"):
			body, _ := io.ReadAll(r.Body)
			if string(body) != "abc" {
				t.Errorf("unexpected body: %q", body)
			}
			io.WriteString(w, "{}")
		case strings.HasSuffix(r.URL.Path, "/complete"):
			json.NewEncoder(w).Encode(api.Upload{Id: "upload", Status: api.Complete})
		default:
			t.Errorf("unexpected request: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	c, err := client.New(upstream.URL, "mr2_test")
	if err != nil {
		t.Fatal(err)
	}
	server := Server{Client: c, Session: "session", MaxFileBytes: 1024}
	if err := server.upload(context.Background(), "g/a/1/a-1.jar", strings.NewReader("abc"), 3); err != nil {
		t.Fatal(err)
	}
}
