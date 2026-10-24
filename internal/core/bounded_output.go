package core

// tailBuffer 只保留最后 64 KiB，防止项目检查的无界输出耗尽服务内存。
type tailBuffer struct{ b []byte }

const outputLimit = 64 << 10

func (b *tailBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if len(p) >= outputLimit {
		b.b = append(b.b[:0], p[len(p)-outputLimit:]...)
		return n, nil
	}
	if extra := len(b.b) + len(p) - outputLimit; extra > 0 {
		copy(b.b, b.b[extra:])
		b.b = b.b[:len(b.b)-extra]
	}
	b.b = append(b.b, p...)
	return n, nil
}
func (b *tailBuffer) WriteString(s string) { b.Write([]byte(s)) }
func (b *tailBuffer) Bytes() []byte        { return b.b }
func (b *tailBuffer) String() string       { return string(b.b) }
