// Package nativecontrol implements an opt-in, single-workspace Codex prototype.
// It does not relax the normal panel's remote read-only policy.
package nativecontrol

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

type Message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type Transport interface {
	Call(context.Context, string, any, any) error
	Notify(string, any) error
	Reply(json.RawMessage, any) error
	Reject(json.RawMessage) error
	Events() <-chan Message
	Close() error
}
type Factory func(context.Context) (Transport, error)

type RPC struct {
	cmd     *exec.Cmd
	in      io.WriteCloser
	writeMu sync.Mutex
	mu      sync.Mutex
	next    uint64
	pending map[string]chan Message
	events  chan Message
	done    chan struct{}
	once    sync.Once
}

// Start uses stdio and command-local overrides only; credentials/config stay native.
func Start(ctx context.Context, binary, dir string) (Transport, error) {
	cmd := exec.CommandContext(ctx, binary, "--disable", "hooks", "--disable", "plugins", "--disable", "apps", "--disable", "chronicle", "app-server", "--stdio")
	cmd.Dir, cmd.Stderr, cmd.WaitDelay = dir, io.Discard, time.Second
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		in.Close()
		return nil, err
	}
	r := &RPC{cmd: cmd, in: in, pending: map[string]chan Message{}, events: make(chan Message, 256), done: make(chan struct{})}
	go r.read(out)
	return r, nil
}

func (r *RPC) read(out io.Reader) {
	defer func() { r.once.Do(func() { close(r.done) }); close(r.events); r.cmd.Wait() }()
	s := bufio.NewScanner(out)
	s.Buffer(make([]byte, 65536), 8<<20)
	for s.Scan() {
		var m Message
		if json.Unmarshal(s.Bytes(), &m) != nil {
			continue
		}
		if m.Method != "" {
			select {
			case r.events <- m:
			case <-r.done:
				return
			}
		} else if len(m.ID) > 0 {
			r.mu.Lock()
			ch := r.pending[string(m.ID)]
			r.mu.Unlock()
			if ch != nil {
				select {
				case ch <- m:
				default:
				}
			}
		}
	}
}
func (r *RPC) send(v any) error {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	return json.NewEncoder(r.in).Encode(v)
}
func (r *RPC) Call(ctx context.Context, method string, params, result any) error {
	r.mu.Lock()
	r.next++
	id := r.next
	key := fmt.Sprint(id)
	ch := make(chan Message, 1)
	r.pending[key] = ch
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.pending, key); r.mu.Unlock() }()
	if err := r.send(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return err
	}
	select {
	case m := <-ch:
		if m.Error != nil {
			return fmt.Errorf("Codex RPC %s: %s", method, m.Error.Message)
		}
		if result != nil {
			return json.Unmarshal(m.Result, result)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-r.done:
		return errors.New("Codex app-server disconnected")
	}
}
func (r *RPC) Reply(id json.RawMessage, result any) error {
	return r.send(map[string]any{"id": id, "result": result})
}
func (r *RPC) Notify(method string, params any) error {
	return r.send(map[string]any{"method": method, "params": params})
}
func (r *RPC) Reject(id json.RawMessage) error {
	return r.send(map[string]any{"id": id, "error": map[string]any{"code": -32601, "message": "Unsupported native request; no authorization granted"}})
}
func (r *RPC) Events() <-chan Message { return r.events }
func (r *RPC) Close() error {
	r.once.Do(func() { close(r.done) })
	r.in.Close()
	return r.cmd.Process.Kill()
}
