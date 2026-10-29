package updater

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Each replacement is prepared on the destination volume before anything stops.
// Backup is retained until a later user-controlled cleanup, including on success.
type Replacement struct {
	Target, Staged, Backup, OldDigest, NewDigest string
	Existed                                      bool
}
type Plan struct {
	App, Home, Mode, Plist, Listen, Commit, OldCommit, Work string
	Parent                                                  int
	Items                                                   []Replacement
	Guards                                                  map[string]string
	State                                                   string
}
type Host interface {
	Stop(*Plan) error
	Start(*Plan, bool) error
	Healthy(*Plan) error
}

func Save(p *Plan) error {
	b, e := json.MarshalIndent(p, "", "  ")
	if e != nil {
		return e
	}
	file := filepath.Join(p.Work, "transaction.json")
	f, e := os.OpenFile(file+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	if ce != nil {
		return ce
	}
	if e = os.Rename(file+".tmp", file); e != nil {
		return e
	}
	return syncDir(p.Work)
}
func syncDir(path string) error {
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}
func rename(a, b string) error {
	if e := os.Rename(a, b); e != nil {
		return e
	}
	return syncDir(filepath.Dir(b))
}
func Apply(p *Plan, h Host) error {
	if p.State != "prepared" {
		return errors.New("更新事务已使用或需要恢复，请检查更新记录")
	}
	if e := unchanged(p); e != nil {
		return e
	}
	p.State = "installing"
	if e := Save(p); e != nil {
		return e
	}
	if e := h.Stop(p); e != nil {
		// A failed stop can leave launchd unloaded. Attempt to restart the old
		// installation; keep the journal recoverable if that also fails.
		if restart := h.Start(p, true); restart != nil {
			return fmt.Errorf("停止失败：%v；请恢复旧版：%w", e, restart)
		}
		p.State = "prepared"
		_ = Save(p)
		return e
	}
	fail := func(cause error) error {
		recovery := Recover(p, h)
		if recovery != nil {
			return fmt.Errorf("安装失败：%v；恢复未完成：%v。保留恢复记录：%s", cause, recovery, p.Work)
		}
		return fmt.Errorf("安装失败，旧版已恢复并请求重启：%v。记录：%s", cause, p.Work)
	}
	for _, r := range p.Items {
		if r.Existed {
			if e := rename(r.Target, r.Backup); e != nil {
				return fail(e)
			}
		}
		if e := rename(r.Staged, r.Target); e != nil {
			return fail(e)
		}
	}
	if e := h.Start(p, false); e != nil {
		return fail(e)
	}
	if e := h.Healthy(p); e != nil {
		return fail(e)
	}
	p.State = "installed"
	return Save(p)
}

// Recover is idempotent, and also handles termination between the two renames.
// The DB is never restored over newer hook events: automatic updates require an
// identical schema, so the old backend can reopen the live database safely.
func Recover(p *Plan, h Host) error {
	if p.State == "installed" || p.State == "rolled_back" {
		return errors.New("此事务已结束，不允许回退正在使用的新版本")
	}
	if e := h.Stop(p); e != nil {
		return e
	}
	for i := len(p.Items) - 1; i >= 0; i-- {
		r := p.Items[i]
		if _, e := os.Lstat(r.Backup); e == nil {
			if _, e = os.Lstat(r.Target); e == nil {
				// Keep failed payload for diagnosis; don't delete potential user content.
				if e = rename(r.Target, r.Staged+".failed"); e != nil {
					return e
				}
			}
			if e = rename(r.Backup, r.Target); e != nil {
				return e
			}
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		} else if !r.Existed {
			if _, e = os.Lstat(r.Target); e == nil {
				if e = rename(r.Target, r.Staged+".failed"); e != nil {
					return e
				}
			}
		}
	}
	if e := h.Start(p, true); e != nil {
		return e
	}
	old := *p
	old.Commit = p.OldCommit
	if e := h.Healthy(&old); e != nil {
		return fmt.Errorf("旧文件已恢复，但后台仍未通过健康检查：%w", e)
	}
	p.State = "rolled_back"
	return Save(p)
}
