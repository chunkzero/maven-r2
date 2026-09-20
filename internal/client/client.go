package client

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/chunkzero/maven-r2/internal/api"
	"github.com/chunkzero/maven-r2/internal/config"
)

type Client struct {
	API    *api.Client
	HTTP   *http.Client
	Server string
	token  string
}

type HTTPError struct {
	Status     int
	Message    string
	RetryAfter time.Duration
}

func (e *HTTPError) Error() string { return fmt.Sprintf("server returned %d: %s", e.Status, e.Message) }

func New(server, token string) (*Client, error) {
	server, err := config.ValidateServer(server)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(token, "mr2_") {
		return nil, fmt.Errorf("set MAVEN_R2_TOKEN or run maven-r2 login")
	}
	httpClient := &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	c := &Client{HTTP: httpClient, Server: server, token: token}
	c.API, err = api.NewClient(server, api.WithHTTPClient(httpClient), api.WithRequestEditorFn(func(_ context.Context, req *http.Request) error {
		req.Header.Set("Authorization", "Bearer "+token)
		return nil
	}))
	return c, err
}

func decode[T any](response *http.Response, err error) (T, error) {
	var result T
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return result, responseError(response)
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&result)
	return result, err
}

func responseError(response *http.Response) error {
	data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	var detail api.Error
	var wait time.Duration
	if seconds, err := strconv.Atoi(response.Header.Get("Retry-After")); err == nil {
		wait = time.Duration(seconds) * time.Second
	} else if until, err := http.ParseTime(response.Header.Get("Retry-After")); err == nil {
		wait = time.Until(until)
	}
	wait = max(0, min(wait, 2*time.Minute))
	if json.Unmarshal(data, &detail) == nil && detail.Error != "" {
		return &HTTPError{response.StatusCode, detail.Error, wait}
	}
	return &HTTPError{response.StatusCode, http.StatusText(response.StatusCode), wait}
}

func (c *Client) Begin(ctx context.Context, account, repository, label string) (api.Publication, error) {
	response, err := c.API.CreatePublication(ctx, api.CreatePublication{Account: account, Repository: repository, Label: &label})
	return decode[api.Publication](response, err)
}

func (c *Client) Status(ctx context.Context, id string) (api.Publication, error) {
	response, err := c.API.GetPublication(ctx, id)
	return decode[api.Publication](response, err)
}

func (c *Client) Commit(ctx context.Context, id string) (api.Publication, error) {
	return retry(ctx, func() (api.Publication, error) {
		response, err := c.API.CommitPublication(ctx, id)
		return decode[api.Publication](response, err)
	})
}

func (c *Client) Abort(ctx context.Context, id string) error {
	_, err := retry(ctx, func() (api.Publication, error) {
		response, err := c.API.AbortPublication(ctx, id)
		return decode[api.Publication](response, err)
	})
	return err
}

func (c *Client) Upload(ctx context.Context, session, path string, file *os.File, size int64, digest string) error {
	upload, err := retry(ctx, func() (api.Upload, error) {
		response, err := c.API.CreateUpload(ctx, session, api.CreateUpload{Path: path, Size: int(size), Sha256: digest})
		return decode[api.Upload](response, err)
	})
	if err != nil {
		return err
	}
	if upload.Status == api.Complete {
		return nil
	}
	partSize := int64(upload.PartSize)
	if partSize < 1 || partSize > 64<<20 {
		return fmt.Errorf("server returned an invalid part size")
	}
	completed := map[int]bool{}
	for _, part := range upload.Parts {
		completed[int(part.Number)] = true
	}
	for offset, part := int64(0), 1; offset < size || part == 1; offset, part = offset+partSize, part+1 {
		if completed[part] {
			continue
		}
		length := min(partSize, size-offset)
		_, err = retry(ctx, func() (bool, error) {
			endpoint := fmt.Sprintf("%s/api/publications/%s/uploads/%s/parts/%d", c.Server, url.PathEscape(session), url.PathEscape(upload.Id), part)
			request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, io.NewSectionReader(file, offset, length))
			if err != nil {
				return false, err
			}
			request.ContentLength = length
			if length == 0 {
				request.Body = http.NoBody
			}
			request.Header.Set("Authorization", "Bearer "+c.token)
			request.Header.Set("Content-Type", "application/octet-stream")
			response, err := c.HTTP.Do(request)
			if err != nil {
				return false, err
			}
			defer response.Body.Close()
			if response.StatusCode < 200 || response.StatusCode >= 300 {
				return false, responseError(response)
			}
			_, err = io.Copy(io.Discard, response.Body)
			return true, err
		})
		if err != nil {
			return fmt.Errorf("upload part %d: %w", part, err)
		}
	}
	_, err = retry(ctx, func() (api.Upload, error) {
		response, err := c.API.CompleteUpload(ctx, session, upload.Id)
		return decode[api.Upload](response, err)
	})
	return err
}

func (c *Client) Read(ctx context.Context, session, path, method string) (*http.Response, error) {
	endpoint := c.Server + "/api/publications/" + url.PathEscape(session) + "/files?path=" + url.QueryEscape(path)
	request, err := http.NewRequestWithContext(ctx, method, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	return c.HTTP.Do(request)
}

func retry[T any](ctx context.Context, operation func() (T, error)) (T, error) {
	var result T
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		result, err = operation()
		if err == nil {
			return result, nil
		}
		if status, ok := err.(*HTTPError); ok && status.Status != 429 && status.Status < 500 {
			return result, err
		}
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		if attempt == 3 {
			break
		}
		delay := time.Duration(1<<attempt) * 250 * time.Millisecond
		if status, ok := err.(*HTTPError); ok {
			delay = max(delay, status.RetryAfter)
		}
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case <-time.After(delay):
		}
	}
	return result, err
}
