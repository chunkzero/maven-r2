package proxy

import (
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/chunkzero/maven-r2/internal/api"
	"github.com/chunkzero/maven-r2/internal/client"
)

type Server struct {
	Client       *client.Client
	Session      string
	MaxFileBytes int64
	Log          *log.Logger
	URL          string
	Password     string
	http         *http.Server
	slots        chan struct{}
	mu           sync.Mutex
	failure      error
	failedPaths  map[string]error
}

func (s *Server) Start() error {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	s.Password = rand.Text()
	s.URL = "http://" + listener.Addr().String()
	if s.MaxFileBytes == 0 {
		s.MaxFileBytes = 2 << 30
	}
	s.slots = make(chan struct{}, 4)
	s.failedPaths = make(map[string]error)
	s.http = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	go func() {
		err := s.http.Serve(listener)
		if err != nil && err != http.ErrServerClosed {
			s.mu.Lock()
			s.failure = err
			s.mu.Unlock()
		}
	}()
	return nil
}

func (s *Server) Close(ctx context.Context) error {
	if s.http == nil {
		return nil
	}
	if err := s.http.Shutdown(ctx); err != nil {
		s.http.Close()
		return err
	}
	return nil
}

func (s *Server) Failure() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failure != nil {
		return s.failure
	}
	for path, err := range s.failedPaths {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

var segment = regexp.MustCompile(`^[A-Za-z0-9_+.-]+$`)

func artifactPath(path string) (string, error) {
	path = strings.TrimPrefix(path, "/")
	if len(path) > 1024 {
		return "", fmt.Errorf("repository path too long")
	}
	for _, part := range strings.Split(path, "/") {
		if part == "." || part == ".." || !segment.MatchString(part) {
			return "", fmt.Errorf("invalid repository path")
		}
	}
	return path, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Host != strings.TrimPrefix(s.URL, "http://") || r.Header.Get("Origin") != "" {
		http.Error(w, "invalid local request", http.StatusForbidden)
		return
	}
	_, password, ok := r.BasicAuth()
	if !ok || subtle.ConstantTimeCompare([]byte(password), []byte(s.Password)) != 1 {
		w.Header().Set("WWW-Authenticate", `Basic realm="Maven R2 local proxy"`)
		http.Error(w, "local session credential required", http.StatusUnauthorized)
		return
	}
	path, err := artifactPath(r.URL.Path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		response, err := s.Client.Read(r.Context(), s.Session, path, r.Method)
		if err != nil {
			http.Error(w, "upstream request failed", http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		for _, header := range []string{"Content-Type", "Content-Length", "ETag", "Last-Modified"} {
			if value := response.Header.Get(header); value != "" {
				w.Header().Set(header, value)
			}
		}
		w.WriteHeader(response.StatusCode)
		if r.Method != http.MethodHead {
			io.Copy(w, response.Body)
		}
	case http.MethodPut:
		select {
		case s.slots <- struct{}{}:
			defer func() { <-s.slots }()
		case <-r.Context().Done():
			return
		}
		if err = s.upload(r.Context(), path, r.Body, r.ContentLength); err != nil {
			s.mu.Lock()
			s.failedPaths[path] = err
			s.mu.Unlock()
			status := http.StatusBadGateway
			var upstream *client.HTTPError
			if errors.As(err, &upstream) {
				status = upstream.Status
			}
			if s.Log != nil {
				s.Log.Printf("upload failed: %s: %v", path, err)
			}
			http.Error(w, err.Error(), status)
			return
		}
		s.mu.Lock()
		delete(s.failedPaths, path)
		s.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	default:
		w.Header().Set("Allow", "GET, HEAD, PUT")
		http.Error(w, "unsupported publishing method", http.StatusMethodNotAllowed)
	}
}

func (s *Server) upload(ctx context.Context, path string, body io.Reader, length int64) error {
	if length > s.MaxFileBytes {
		return &client.HTTPError{Status: 413, Message: "artifact exceeds local file limit"}
	}
	file, err := os.CreateTemp("", "maven-r2-upload-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	md5Hash, sha1Hash, sha256Hash, sha512Hash := md5.New(), sha1.New(), sha256.New(), sha512.New()
	size, err := io.Copy(io.MultiWriter(file, md5Hash, sha1Hash, sha256Hash, sha512Hash), io.LimitReader(body, s.MaxFileBytes+1))
	if err != nil {
		return err
	}
	if size > s.MaxFileBytes {
		return &client.HTTPError{Status: 413, Message: "artifact exceeds local file limit"}
	}
	if length >= 0 && size != length {
		return fmt.Errorf("incomplete upload body")
	}
	checksums := api.Checksums{
		Md5:    hex.EncodeToString(md5Hash.Sum(nil)),
		Sha1:   hex.EncodeToString(sha1Hash.Sum(nil)),
		Sha256: hex.EncodeToString(sha256Hash.Sum(nil)),
		Sha512: hex.EncodeToString(sha512Hash.Sum(nil)),
	}
	if err = s.Client.Upload(ctx, s.Session, path, file, size, checksums); err != nil {
		return err
	}
	if s.Log != nil {
		s.Log.Printf("staged %s (%d bytes)", path, size)
	}
	return nil
}
