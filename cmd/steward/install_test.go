package main

import "testing"

func TestClaudeVersionArg(t *testing.T) {
	for _, args := range [][]string{{"claude", "--claude-version", "2.1.83"}, {"--project", "/synthetic/repo", "--claude-version=2.1.83"}} {
		if got, err := claudeVersionArg(args); err != nil || got != "2.1.83" {
			t.Fatalf("%v: %q %v", args, got, err)
		}
	}
	for _, args := range [][]string{{"--claude-version"}, {"--claude-version="}, {"--claude-version", "--project"}, {"--claude-version", "invalid"}, {"--claude-version", "2.1.83", "--claude-version", "2.1.310"}} {
		if _, err := claudeVersionArg(args); err == nil {
			t.Fatalf("应拒绝参数 %v", args)
		}
	}
}
