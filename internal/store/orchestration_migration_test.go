package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOrchestrationDatabaseAndSidecarsArePrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "synthetic.sqlite")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for _, file := range []string{path, path + "-wal", path + "-shm"} {
		info, e := os.Stat(file)
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			t.Fatal(e)
		}
		if info.Mode().Perm()&0077 != 0 {
			t.Fatalf("database is not private: %s %o", filepath.Base(file), info.Mode().Perm())
		}
	}
}
