package main

import "testing"

func TestBrowserCommand(t *testing.T) {
	cases := map[string]string{"darwin": "open", "linux": "xdg-open", "freebsd": "xdg-open", "windows": "rundll32"}
	for goos, want := range cases {
		if got, _ := browserCommand(goos); got != want {
			t.Errorf("%s: got %q, want %q", goos, got, want)
		}
	}
}
