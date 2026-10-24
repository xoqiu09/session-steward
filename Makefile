.PHONY: build web go test notifier

build: web go notifier

notifier:
	@if [ "$$(uname)" = Darwin ]; then sh scripts/build-notifier.sh; fi

web:
	cd web && npm ci && npm run build && touch dist/.keep

go:
	go build -o bin/ ./cmd/...

test:
	go test -race ./...
	cd web && npx vitest run
