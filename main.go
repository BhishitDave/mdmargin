// mdmargin serves the Margin Markdown reader from a single binary and gives it
// direct read/write access to one folder on disk.
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

//go:embed web
var webFS embed.FS

// Set at build time with -ldflags "-X main.version=... -X main.repo=owner/name".
var (
	version = "dev"
	repo    = "BhishitDave/mdmargin"
)

const (
	defaultPort = 4747
	maxFileSize = 20 << 20
	maxFiles    = 5000
	maxDepth    = 8
)

var mdExt = map[string]bool{".md": true, ".markdown": true, ".mdx": true, ".txt": true}

var imgExt = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".bmp": "image/bmp",
}

type server struct {
	root     *os.Root
	rootName string
	initial  string // file to open on start, relative to root
	anyHost  bool   // set when the user binds to a non-loopback address
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/info", s.info)
	mux.HandleFunc("GET /api/list", s.list)
	mux.HandleFunc("GET /api/file", s.read)
	mux.HandleFunc("PUT /api/file", s.write)
	mux.HandleFunc("GET /api/raw", s.raw)
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	mux.Handle("/", http.FileServerFS(sub))
	return s.guard(mux)
}

// guard keeps other websites away from the file API. The Host check stops DNS
// rebinding; the custom header can't be sent cross-origin without a CORS
// preflight, which this server never approves.
func (s *server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.anyHost && !isLoopbackHost(r.Host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/raw" && r.Header.Get("X-Mdmargin") != "1" {
			http.Error(w, "missing X-Mdmargin header", http.StatusForbidden)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

func isLoopbackHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// relPath validates the ?path= parameter. os.Root already refuses to leave the
// folder; this additionally hides dotfiles and gives clean error messages.
func relPath(r *http.Request) (string, error) {
	p := r.URL.Query().Get("path")
	if p == "" || p == "." || !fs.ValidPath(p) {
		return "", errors.New("invalid path")
	}
	for _, part := range strings.Split(p, "/") {
		if strings.HasPrefix(part, ".") {
			return "", errors.New("hidden files are not served")
		}
	}
	return p, nil
}

func (s *server) info(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"app": "mdmargin", "version": version, "root": s.rootName, "file": s.initial})
}

func (s *server) list(w http.ResponseWriter, r *http.Request) {
	files := []string{}
	err := fs.WalkDir(s.root.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir // unreadable folder
			}
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if p != "." && (strings.HasPrefix(name, ".") || name == "node_modules" || strings.Count(p, "/") >= maxDepth) {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasPrefix(name, ".") && mdExt[strings.ToLower(path.Ext(name))] {
			files = append(files, p)
			if len(files) >= maxFiles {
				return fs.SkipAll
			}
		}
		return nil
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, files)
}

func (s *server) read(w http.ResponseWriter, r *http.Request) {
	p, err := relPath(r)
	if err != nil || !mdExt[strings.ToLower(path.Ext(p))] {
		http.Error(w, "not a Markdown file", http.StatusBadRequest)
		return
	}
	s.serveFile(w, p, "text/plain; charset=utf-8")
}

func (s *server) raw(w http.ResponseWriter, r *http.Request) {
	p, err := relPath(r)
	ctype := imgExt[strings.ToLower(path.Ext(p))]
	if err != nil || ctype == "" {
		http.Error(w, "not an image", http.StatusBadRequest)
		return
	}
	// SVGs can carry scripts; sandboxing keeps them inert if opened directly.
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
	s.serveFile(w, p, ctype)
}

func (s *server) serveFile(w http.ResponseWriter, p, ctype string) {
	f, err := s.root.Open(filepath.FromSlash(p))
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if st.Size() > maxFileSize {
		http.Error(w, "file is too large", http.StatusRequestEntityTooLarge)
		return
	}
	w.Header().Set("Content-Type", ctype)
	io.Copy(w, f)
}

func (s *server) write(w http.ResponseWriter, r *http.Request) {
	p, err := relPath(r)
	if err != nil || !mdExt[strings.ToLower(path.Ext(p))] {
		http.Error(w, "not a Markdown file", http.StatusBadRequest)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxFileSize))
	if err != nil {
		http.Error(w, "file is too large", http.StatusRequestEntityTooLarge)
		return
	}
	name := filepath.FromSlash(p)
	st, statErr := s.root.Lstat(name)
	create := r.URL.Query().Get("create") == "1"
	switch {
	case create && statErr == nil:
		http.Error(w, "file already exists", http.StatusConflict)
		return
	case !create && statErr != nil:
		http.Error(w, "not found", http.StatusNotFound)
		return
	case statErr == nil && st.IsDir():
		http.Error(w, "is a folder", http.StatusBadRequest)
		return
	}

	// Write to a temporary file and rename it into place so a crash can't leave
	// a half-written document. Symlinks are written through instead of replaced.
	perm := fs.FileMode(0o644)
	if statErr == nil {
		perm = st.Mode().Perm()
	}
	if statErr == nil && st.Mode()&fs.ModeSymlink != 0 {
		err = s.root.WriteFile(name, data, perm)
	} else {
		tmp := filepath.Join(filepath.Dir(name), "."+filepath.Base(name)+".mdmargin-tmp")
		if err = s.root.WriteFile(tmp, data, perm); err == nil {
			if err = s.root.Rename(tmp, name); err != nil {
				s.root.Remove(tmp)
			}
		}
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err == nil {
		go cmd.Wait()
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `mdmargin %s — read, annotate and edit Markdown in your browser

Usage:
  mdmargin [flags] [file-or-folder]

Examples:
  mdmargin                 open the current folder
  mdmargin notes.md        open one file (its folder becomes the library)
  mdmargin ~/Documents     open a folder
  mdmargin --update        update to the latest release

Flags:
`, version)
	flag.PrintDefaults()
}

func main() {
	port := flag.Int("port", defaultPort, "port to listen on (a free one is picked if the default is busy)")
	host := flag.String("host", "127.0.0.1", "address to listen on")
	noOpen := flag.Bool("no-open", false, "don't open the browser")
	showVersion := flag.Bool("version", false, "print the version and exit")
	update := flag.Bool("update", false, "update to the latest release and exit")
	flag.Usage = usage
	flag.Parse()

	if *showVersion {
		fmt.Println("mdmargin", version)
		return
	}
	if *update {
		if err := selfUpdate(); err != nil {
			fatal("update failed: %v", err)
		}
		return
	}

	target := "."
	if flag.NArg() > 0 {
		target = flag.Arg(0)
	}
	dir, err := filepath.Abs(target)
	if err != nil {
		fatal("%v", err)
	}
	st, err := os.Stat(dir)
	if err != nil {
		fatal("%v", err)
	}
	initial := ""
	if !st.IsDir() {
		if !mdExt[strings.ToLower(filepath.Ext(dir))] {
			fatal("%s is not a Markdown file (.md, .markdown, .mdx or .txt)", target)
		}
		initial = filepath.Base(dir)
		dir = filepath.Dir(dir)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		fatal("%v", err)
	}
	defer root.Close()

	ln, err := net.Listen("tcp", net.JoinHostPort(*host, strconv.Itoa(*port)))
	if err != nil && *port == defaultPort {
		ln, err = net.Listen("tcp", net.JoinHostPort(*host, "0"))
	}
	if err != nil {
		fatal("%v", err)
	}

	loopback := isLoopbackHost(*host)
	srv := &server{root: root, rootName: filepath.Base(dir), initial: initial, anyHost: !loopback}
	url := "http://" + ln.Addr().String()
	fmt.Printf("mdmargin %s\n  folder  %s\n  open    %s\n\nPress Ctrl+C to stop.\n", version, dir, url)
	if !loopback {
		fmt.Println("\nWarning: listening on a non-local address. Anyone who can reach it can read and edit the Markdown files in this folder.")
	}
	if !*noOpen {
		openBrowser(url)
	}
	if err := http.Serve(ln, srv.handler()); err != nil {
		fatal("%v", err)
	}
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "mdmargin: "+format+"\n", args...)
	os.Exit(1)
}
