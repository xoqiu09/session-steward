// Package ojson 是保持键顺序的最小 JSON 模型，用于在不打乱他人配置的前提下编辑 hooks 文件。
package ojson

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// Value 是 *Object、[]Value 或标量（json.RawMessage）。
type Value any

type Member struct {
	Key   string
	Value Value
}

type Object struct{ Members []Member }

func (o *Object) Get(k string) (Value, bool) {
	for _, m := range o.Members {
		if m.Key == k {
			return m.Value, true
		}
	}
	return nil, false
}

func (o *Object) Set(k string, v Value) {
	for i := range o.Members {
		if o.Members[i].Key == k {
			o.Members[i].Value = v
			return
		}
	}
	o.Members = append(o.Members, Member{k, v})
}

func (o *Object) Delete(k string) {
	for i := range o.Members {
		if o.Members[i].Key == k {
			o.Members = append(o.Members[:i], o.Members[i+1:]...)
			return
		}
	}
}

func Parse(b []byte) (Value, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	v, err := parse(d)
	if err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, fmt.Errorf("JSON 末尾有多余内容")
	}
	return v, nil
}

func parse(d *json.Decoder) (Value, error) {
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch tt := t.(type) {
	case json.Delim:
		switch tt {
		case '{':
			o := &Object{}
			for d.More() {
				kt, err := d.Token()
				if err != nil {
					return nil, err
				}
				k, _ := kt.(string)
				v, err := parse(d)
				if err != nil {
					return nil, err
				}
				o.Members = append(o.Members, Member{k, v})
			}
			if _, err := d.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			arr := []Value{}
			for d.More() {
				v, err := parse(d)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := d.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("意外的分隔符 %v", tt)
	default:
		b, err := json.Marshal(tt)
		return json.RawMessage(b), err
	}
}

// Marshal 以两空格缩进输出。
func Marshal(v Value) []byte {
	var buf bytes.Buffer
	write(&buf, v, 0)
	buf.WriteByte('\n')
	return buf.Bytes()
}

func indent(buf *bytes.Buffer, n int) {
	buf.WriteByte('\n')
	for i := 0; i < n; i++ {
		buf.WriteString("  ")
	}
}

func write(buf *bytes.Buffer, v Value, depth int) {
	switch t := v.(type) {
	case *Object:
		if len(t.Members) == 0 {
			buf.WriteString("{}")
			return
		}
		buf.WriteByte('{')
		for i, m := range t.Members {
			if i > 0 {
				buf.WriteByte(',')
			}
			indent(buf, depth+1)
			k, _ := json.Marshal(m.Key)
			buf.Write(k)
			buf.WriteString(": ")
			write(buf, m.Value, depth+1)
		}
		indent(buf, depth)
		buf.WriteByte('}')
	case []Value:
		if len(t) == 0 {
			buf.WriteString("[]")
			return
		}
		buf.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			indent(buf, depth+1)
			write(buf, e, depth+1)
		}
		indent(buf, depth)
		buf.WriteByte(']')
	case json.RawMessage:
		var out bytes.Buffer
		if json.Compact(&out, t) == nil {
			buf.Write(out.Bytes())
		} else {
			buf.Write(t)
		}
	case string:
		b, _ := json.Marshal(t)
		buf.Write(b)
	case nil:
		buf.WriteString("null")
	default:
		b, _ := json.Marshal(t)
		buf.Write(b)
	}
}

// Str 读取字符串标量。
func Str(v Value) (string, bool) {
	r, ok := v.(json.RawMessage)
	if !ok {
		s, ok := v.(string)
		return s, ok
	}
	var s string
	if json.Unmarshal(r, &s) != nil {
		return "", false
	}
	return s, true
}
