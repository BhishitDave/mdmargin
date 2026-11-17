VERSION ?= $(shell v=$$(git describe --tags --always --dirty 2>/dev/null | sed 's/^v//'); echo $${v:-dev})
REPO ?= BhishitDave/mdmargin

.PHONY: build test run dist clean site

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

site:
	rm -rf _site && mkdir _site && cp -R site/. _site/ && cp -R docs/images _site/images && cp -R web _site/app
	@echo "Preview: python3 -m http.server -d _site 8000"

clean:
	rm -rf mdmargin dist _site
