package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	parent := t.TempDir()
	dir := filepath.Join(parent, "notes")
	must(t, os.MkdirAll(filepath.Join(dir, "sub"), 0o755))
	must(t, os.MkdirAll(filepath.Join(dir, ".git"), 0o755))
	must(t, os.MkdirAll(filepath.Join(dir, "node_modules"), 0o755))
	must(t, os.WriteFile(filepath.Join(dir, "a.md"), []byte("# A\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(dir, "sub", "b.markdown"), []byte("B\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(dir, "sub", "pic.png"), []byte("png"), 0o644))
	must(t, os.WriteFile(filepath.Join(dir, "code.go"), []byte("package x\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(dir, ".git", "hidden.md"), []byte("x"), 0o644))
	must(t, os.WriteFile(filepath.Join(dir, "node_modules", "dep.md"), []byte("x"), 0o644))
	must(t, os.WriteFile(filepath.Join(parent, "secret.md"), []byte("secret"), 0o644))
	root, err := os.OpenRoot(dir)
	must(t, err)
	t.Cleanup(func() { root.Close() })
	ts := httptest.NewServer((&server{root: root, rootName: "notes"}).handler())
	t.Cleanup(ts.Close)
	return ts, dir
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func do(t *testing.T, method, url, body string, headers map[string]string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	must(t, err)
	req.Header.Set("X-Mdmargin", "1")
	for k, v := range headers {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	if h := headers["Host"]; h != "" {
		req.Host = h
	}
	resp, err := http.DefaultClient.Do(req)
	must(t, err)
	defer resp.Body.Close()
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return resp.StatusCode, sb.String()
}

func TestListSkipsHiddenAndNonMarkdown(t *testing.T) {
	ts, _ := newTestServer(t)
	code, body := do(t, "GET", ts.URL+"/api/list", "", nil)
	if code != 200 {
		t.Fatalf("status %d: %s", code, body)
	}
	var files []string
	must(t, json.Unmarshal([]byte(body), &files))
	if got := strings.Join(files, ","); got != "a.md,sub/b.markdown" {
		t.Fatalf("unexpected list: %s", got)
	}
}

func TestReadAndWrite(t *testing.T) {
	ts, dir := newTestServer(t)
	if code, body := do(t, "GET", ts.URL+"/api/file?path=sub/b.markdown", "", nil); code != 200 || body != "B\n" {
		t.Fatalf("read: %d %q", code, body)
	}
	if code, body := do(t, "PUT", ts.URL+"/api/file?path=a.md", "# Changed\n", nil); code != 204 {
		t.Fatalf("write: %d %s", code, body)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "a.md")); string(got) != "# Changed\n" {
		t.Fatalf("file on disk: %q", got)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 5 {
		t.Fatalf("temporary file left behind: %v", entries)
	}
	if code, _ := do(t, "PUT", ts.URL+"/api/file?path=missing.md", "x", nil); code != 404 {
		t.Fatalf("writing a missing file without create: %d", code)
	}
	if code, _ := do(t, "PUT", ts.URL+"/api/file?path=new.md&create=1", "# New\n", nil); code != 204 {
		t.Fatalf("create: %d", code)
	}
	if code, _ := do(t, "PUT", ts.URL+"/api/file?path=new.md&create=1", "again", nil); code != 409 {
		t.Fatalf("create over existing: %d", code)
	}
}

func TestCannotEscapeFolder(t *testing.T) {
	ts, dir := newTestServer(t)
	must(t, os.Symlink(filepath.Join(filepath.Dir(dir), "secret.md"), filepath.Join(dir, "link.md")))
	for _, p := range []string{"../secret.md", "sub/../../secret.md", "/etc/hosts.md", "..%2Fsecret.md", "link.md", ".git/hidden.md", "code.go"} {
		if code, body := do(t, "GET", ts.URL+"/api/file?path="+p, "", nil); code == 200 {
			t.Errorf("read %q succeeded: %q", p, body)
		}
		if code, _ := do(t, "PUT", ts.URL+"/api/file?path="+p, "pwned", nil); code == 204 {
			t.Errorf("write %q succeeded", p)
		}
	}
	if got, _ := os.ReadFile(filepath.Join(filepath.Dir(dir), "secret.md")); string(got) != "secret" {
		t.Fatalf("file outside the folder was modified: %q", got)
	}
}

func TestGuards(t *testing.T) {
	ts, _ := newTestServer(t)
	if code, _ := do(t, "GET", ts.URL+"/api/list", "", map[string]string{"X-Mdmargin": ""}); code != 403 {
		t.Errorf("request without the custom header: %d", code)
	}
	if code, _ := do(t, "GET", ts.URL+"/api/list", "", map[string]string{"Host": "evil.example:4747"}); code != 403 {
		t.Errorf("request with a foreign Host: %d", code)
	}
	if code, _ := do(t, "PUT", ts.URL+"/api/file?path=a.md", "x", map[string]string{"Origin": "https://evil.example"}); code != 403 {
		t.Errorf("request with a foreign Origin: %d", code)
	}
	if code, _ := do(t, "GET", ts.URL+"/api/raw?path=sub/pic.png", "", map[string]string{"X-Mdmargin": ""}); code != 200 {
		t.Errorf("image: %d", code)
	}
	if code, _ := do(t, "GET", ts.URL+"/api/raw?path=a.md", "", nil); code != 400 {
		t.Errorf("raw should only serve images: %d", code)
	}
}

func TestStaticAssetsAreEmbedded(t *testing.T) {
	ts, _ := newTestServer(t)
	for _, p := range []string{"/", "/app.js", "/styles.css", "/vendor/marked.min.js"} {
		if code, body := do(t, "GET", ts.URL+p, "", nil); code != 200 || len(body) == 0 {
			t.Errorf("%s: %d", p, code)
		}
	}
}

func TestChecksumFor(t *testing.T) {
	sums := "abc123  mdmargin-1.0.0-linux-amd64\nDEF456 *mdmargin-1.0.0-darwin-arm64\n"
	if got, ok := checksumFor(sums, "mdmargin-1.0.0-darwin-arm64"); !ok || got != "def456" {
		t.Errorf("got %q %v", got, ok)
	}
	if _, ok := checksumFor(sums, "mdmargin-1.0.0-windows-amd64.exe"); ok {
		t.Error("found a checksum that isn't there")
	}
	if got := assetName("1.0.0", "windows", "amd64"); got != "mdmargin-1.0.0-windows-amd64.exe" {
		t.Errorf("asset name: %s", got)
	}
}
