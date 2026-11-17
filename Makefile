VERSION ?= $(shell v=$$(git describe --tags --always --dirty 2>/dev/null | sed 's/^v//'); echo $${v:-dev})
REPO ?= BhishitDave/mdmargin

.PHONY: build test run dist clean

build:
	go build -ldflags "-X main.version=$(VERSION) -X main.repo=$(REPO)" -o mdmargin .

test:
	go vet ./...
	go test ./...
	npm test

run: build
	./mdmargin .

dist:
	sh scripts/build-all.sh $(VERSION) $(REPO)

clean:
	rm -rf mdmargin dist
