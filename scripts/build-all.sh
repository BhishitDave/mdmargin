#!/bin/sh
# Cross-compiles every release binary into dist/ and writes dist/checksums.txt.
# Usage: scripts/build-all.sh <version> [owner/repo]
set -eu

VERSION="${1:?usage: build-all.sh <version> [owner/repo]}"
VERSION="${VERSION#v}"
REPO="${2:-BhishitDave/mdmargin}"

rm -rf dist
mkdir -p dist
for target in darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64; do
  os="${target%/*}"
  arch="${target#*/}"
  out="dist/mdmargin-$VERSION-$os-$arch"
  if [ "$os" = windows ]; then out="$out.exe"; fi
  echo "building $out"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION -X main.repo=$REPO" -o "$out" .
done

cd dist
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum mdmargin-* > checksums.txt
else
  shasum -a 256 mdmargin-* > checksums.txt
fi
