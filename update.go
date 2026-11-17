package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type release struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

// assetName is the naming scheme shared with scripts/build-all.sh and install.sh.
func assetName(ver, goos, goarch string) string {
	name := fmt.Sprintf("mdmargin-%s-%s-%s", ver, goos, goarch)
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

func httpGet(url string, limit int64) ([]byte, error) {
	client := &http.Client{Timeout: 2 * time.Minute}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "mdmargin/"+version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s returned %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

// checksumFor finds a file's hash in sha256sum-style output ("<hex>  <name>").
func checksumFor(sums, name string) (string, bool) {
	for _, line := range strings.Split(sums, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			return strings.ToLower(fields[0]), true
		}
	}
	return "", false
}

func selfUpdate() error {
	if version == "dev" {
		return errors.New("this is a development build; install a release to use --update")
	}
	body, err := httpGet("https://api.github.com/repos/"+repo+"/releases/latest", 4<<20)
	if err != nil {
		return err
	}
	var rel release
	if err := json.Unmarshal(body, &rel); err != nil {
		return err
	}
	latest := strings.TrimPrefix(rel.TagName, "v")
	if latest == "" {
		return errors.New("no published release found")
	}
	if latest == strings.TrimPrefix(version, "v") {
		fmt.Printf("mdmargin %s is already the latest version.\n", version)
		return nil
	}

	want := assetName(latest, runtime.GOOS, runtime.GOARCH)
	var binURL, sumURL string
	for _, a := range rel.Assets {
		switch a.Name {
		case want:
			binURL = a.URL
		case "checksums.txt":
			sumURL = a.URL
		}
	}
	if binURL == "" || sumURL == "" {
		return fmt.Errorf("release %s has no build for %s/%s", rel.TagName, runtime.GOOS, runtime.GOARCH)
	}

	fmt.Printf("Updating mdmargin %s → %s…\n", version, latest)
	sums, err := httpGet(sumURL, 1<<20)
	if err != nil {
		return err
	}
	expected, ok := checksumFor(string(sums), want)
	if !ok {
		return errors.New("checksum for this build is missing from the release")
	}
	bin, err := httpGet(binURL, 200<<20)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(bin)
	if hex.EncodeToString(sum[:]) != expected {
		return errors.New("downloaded file failed its checksum; nothing was changed")
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	tmp := exe + ".new"
	if err := os.WriteFile(tmp, bin, 0o755); err != nil {
		return fmt.Errorf("%w (try running with the permissions used to install it)", err)
	}
	// A running program can't be overwritten on Windows, but it can be renamed aside.
	if runtime.GOOS == "windows" {
		old := exe + ".old"
		os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			os.Remove(tmp)
			return err
		}
	}
	if err := os.Rename(tmp, exe); err != nil {
		os.Remove(tmp)
		return err
	}
	fmt.Printf("Updated to %s.\n", latest)
	return nil
}
