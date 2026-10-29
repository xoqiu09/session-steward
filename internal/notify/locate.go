package notify

import (
	"os"
	"path/filepath"
)

// NativeApp finds the notification helper beside an App-owned backend or inside
// the installed App when launchd runs a separate copy of steward in ~/.steward/bin.
func NativeApp(executable string, applicationDirs []string) string {
	candidates := []string{filepath.Join(filepath.Dir(executable), "Session Steward.app")}
	for _, dir := range applicationDirs {
		candidates = append(candidates, filepath.Join(dir, "Session Steward.app", "Contents", "MacOS", "Session Steward.app"))
	}
	for _, app := range candidates {
		binary := filepath.Join(app, "Contents", "MacOS", "StewardNotifications")
		if info, err := os.Stat(binary); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
			return app
		}
	}
	return ""
}
