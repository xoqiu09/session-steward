.PHONY: build web go test notifier

# 注入 steward version、steward-hook version 与 /api/version 输出的版本标识。两个 cmd 都是 package main，
# 同一个 -X main.BuildCommit 对二者都生效。
BUILD_COMMIT ?= $(shell git describe --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X main.BuildCommit=$(BUILD_COMMIT)

build: web go notifier

notifier:
	@if [ "$$(uname)" = Darwin ]; then sh scripts/build-notifier.sh; fi

web:
	cd web && npm ci && npm run build

go:
	go build -ldflags "$(LDFLAGS)" -o bin/ ./cmd/...

test:
	go test -race ./...
	cd web && npm test
