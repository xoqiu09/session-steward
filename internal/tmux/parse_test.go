package tmux

import "testing"

func TestParsePanes(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want map[string]Pane
	}{
		{"running", "steward-a\t0\t\n", map[string]Pane{"steward-a": {Name: "steward-a"}}},
		{"dead with code", "steward-a\t1\t4\n", map[string]Pane{"steward-a": {Name: "steward-a", Dead: true, ExitCode: 4, HasExitCode: true}}},
		{"dead without code (tmux 3.4)", "steward-a\t1\t\n", map[string]Pane{"steward-a": {Name: "steward-a", Dead: true}}},
		{"last line dead without code", "steward-b\t0\t\nsteward-a\t1\t", map[string]Pane{"steward-a": {Name: "steward-a", Dead: true}, "steward-b": {Name: "steward-b"}}},
		{"other prefix ignored", "user\t1\t0\nsteward-a\t1\t0\n", map[string]Pane{"steward-a": {Name: "steward-a", Dead: true, HasExitCode: true}}},
		{"first pane wins", "steward-a\t1\t2\nsteward-a\t0\t\n", map[string]Pane{"steward-a": {Name: "steward-a", Dead: true, ExitCode: 2, HasExitCode: true}}},
		{"empty", "", map[string]Pane{}},
	}
	for _, tc := range cases {
		got := parsePanes(tc.out, "steward-")
		if len(got) != len(tc.want) {
			t.Errorf("%s: got %+v, want %+v", tc.name, got, tc.want)
			continue
		}
		for k, w := range tc.want {
			if got[k] != w {
				t.Errorf("%s: %s got %+v, want %+v", tc.name, k, got[k], w)
			}
		}
	}
}
