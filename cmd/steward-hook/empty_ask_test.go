package main

import (
	"context"
	"testing"
)

func TestEmptyAskRejectedBeforeClientCall(t *testing.T) {
	if code := agentAction(context.Background(), nil, []string{"ask"}); code != 2 {
		t.Fatalf("empty CLI ask exit code: %d", code)
	}
}
