package hook

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/xoqiu09/session-steward/internal/event"
)

// Spool 是有界的本地暂存：服务不可用时事件追加到 JSONL 文件，超过上限丢弃最旧的并计数。
// 多个 hook 进程并发访问，用文件锁串行化（Unix flock，Windows LockFileEx）。
type Spool struct {
	Dir string
	Max int
}

func (s *Spool) file() string    { return filepath.Join(s.Dir, "events.jsonl") }
func (s *Spool) dropped() string { return filepath.Join(s.Dir, "dropped") }

func (s *Spool) lock() (func(), error) {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(s.Dir, "lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockFile(f); err != nil {
		f.Close()
		return nil, err
	}
	return func() { unlockFile(f); f.Close() }, nil
}

func (s *Spool) read() []event.Event {
	f, err := os.Open(s.file())
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []event.Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		var e event.Event
		if json.Unmarshal(sc.Bytes(), &e) == nil {
			out = append(out, e)
		}
	}
	return out
}

func (s *Spool) write(list []event.Event) error {
	tmp := s.file() + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	for i := range list {
		b, _ := json.Marshal(&list[i])
		w.Write(b)
		w.WriteByte('\n')
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	f.Close()
	return os.Rename(tmp, s.file())
}

func (s *Spool) Append(e *event.Event) {
	unlock, err := s.lock()
	if err != nil {
		return
	}
	defer unlock()
	max := s.Max
	if max <= 0 {
		max = 2000
	}
	f, err := os.OpenFile(s.file(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	b, _ := json.Marshal(e)
	f.Write(append(b, '\n'))
	f.Close()
	list := s.read()
	if len(list) > max {
		drop := len(list) - max
		s.addDropped(drop)
		s.write(list[drop:])
	}
}

func (s *Spool) addDropped(n int) {
	cur := s.Dropped()
	os.WriteFile(s.dropped(), []byte(strconv.Itoa(cur+n)), 0o600)
}

// Dropped 返回因超出上限被丢弃的事件数。
func (s *Spool) Dropped() int {
	b, _ := os.ReadFile(s.dropped())
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return n
}

func (s *Spool) Len() int {
	unlock, err := s.lock()
	if err != nil {
		return 0
	}
	defer unlock()
	return len(s.read())
}

// drainLock 防止多个 hook 进程同时补发同一批事件；已有进程在补发时直接返回 nil。
func (s *Spool) drainLock() func() {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil
	}
	f, err := os.OpenFile(filepath.Join(s.Dir, "drain.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil
	}
	if err := tryLockFile(f); err != nil {
		f.Close()
		return nil
	}
	return func() { unlockFile(f); f.Close() }
}

const drainBatch = 200

// Drain 分批补发；send 返回被确认的 event_id 集合，nil 表示发送失败并停止。
//
// 网络发送不持有暂存锁：锁内只取出一批，锁外发送，再加锁按 event_id 移除已确认的事件。
// 这样补发期间其他 hook 进程的 Append 不会被网络超时拖住（hook 自身有超时，被 Agent 杀掉会丢事件）。
// 补发期间新追加或因超出上限被丢弃的事件都按 event_id 处理，不会误删或复活。
func (s *Spool) Drain(send func([]event.Event) map[string]bool) {
	if fi, err := os.Stat(s.file()); err != nil || fi.Size() == 0 {
		return
	}
	release := s.drainLock()
	if release == nil {
		return
	}
	defer release()
	tried := map[string]bool{} // 本轮已发送过的事件；未被确认的留在暂存里，本轮不再重发
	for {
		batch := s.nextBatch(tried)
		if len(batch) == 0 {
			return
		}
		for _, e := range batch {
			tried[e.EventID] = true
		}
		acked := send(batch)
		if acked == nil {
			return
		}
		if len(acked) > 0 && s.remove(acked) != nil {
			return
		}
	}
}

func (s *Spool) nextBatch(skip map[string]bool) []event.Event {
	unlock, err := s.lock()
	if err != nil {
		return nil
	}
	defer unlock()
	var out []event.Event
	for _, e := range s.read() {
		if skip[e.EventID] {
			continue
		}
		out = append(out, e)
		if len(out) == drainBatch {
			break
		}
	}
	return out
}

// remove 在锁内重新读取暂存并删除已确认的事件。
func (s *Spool) remove(acked map[string]bool) error {
	unlock, err := s.lock()
	if err != nil {
		return err
	}
	defer unlock()
	list := s.read()
	keep := list[:0]
	for _, e := range list {
		if !acked[e.EventID] {
			keep = append(keep, e)
		}
	}
	if len(keep) == len(list) {
		return nil
	}
	return s.write(keep)
}
