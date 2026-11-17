#!/bin/sh
# Installs the latest mdmargin release for this machine.
#   curl -fsSL https://raw.githubusercontent.com/BhishitDave/mdmargin/main/install.sh | sh
# Environment: MDMARGIN_INSTALL_DIR (default ~/.local/bin), MDMARGIN_VERSION (default latest).
set -eu

REPO="${MDMARGIN_REPO:-BhishitDave/mdmargin}"
DIR="${MDMARGIN_INSTALL_DIR:-$HOME/.local/bin}"

fail() { echo "mdmargin install: $1" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail "curl is required"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported system $(uname -s); download a binary from https://github.com/$REPO/releases" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "unsupported processor $(uname -m)" ;;
esac

version="${MDMARGIN_VERSION:-}"
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$version" ] || fail "could not find the latest release of $REPO"
fi
tag="v${version#v}"
file="mdmargin-${version#v}-$os-$arch"
base="https://github.com/$REPO/releases/download/$tag"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading mdmargin $tag ($os/$arch)…"
curl -fsSL "$base/$file" -o "$tmp/$file" || fail "no build for $os/$arch in release $tag"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" || fail "release $tag has no checksums"

expected=$(awk -v f="$file" '$2 == f || $2 == "*" f { print $1 }' "$tmp/checksums.txt")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$file" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$tmp/$file" | awk '{ print $1 }')
fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "checksum mismatch; nothing was installed"

mkdir -p "$DIR"
chmod +x "$tmp/$file"
mv "$tmp/$file" "$DIR/mdmargin"
echo "Installed $DIR/mdmargin"

case ":$PATH:" in
  *":$DIR:"*) echo "Run: mdmargin notes.md" ;;
  *) echo "Add $DIR to your PATH, then run: mdmargin notes.md"
     echo "  echo 'export PATH=\"$DIR:\$PATH\"' >> ~/.zshrc" ;;
esac
