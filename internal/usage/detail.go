package usage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Detail 是一个会话按天、按模型、按轮的 token 明细。只含数字、模型名和时间，不含对话内容。
type Detail struct {
	ByDay  map[string]map[string]Totals `json:"by_day"` // 本地日期 YYYY-MM-DD → 模型 → 用量
	Models map[string]Totals            `json:"models"`
	Turns  []TurnUsage                  `json:"turns"`
	Total  Totals                       `json:"total"`
}

// TurnUsage 是一轮（你发一条消息到下一条之前）的用量；Start 为这条消息的时间。
type TurnUsage struct {
	Start string `json:"start"`
	Totals
}

// Subagent 是 Claude 的一个子 Agent。Description 是启动时写的一句任务说明，截断保存，不读它的对话。
type Subagent struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Description string `json:"description"`
	Finished    bool   `json:"finished"`
	Start       string `json:"start"`
	End         string `json:"end"`
	Total       Totals `json:"total"`
}

func (t *Totals) add(o Totals) {
	t.Input += o.Input
	t.Output += o.Output
	t.CacheRead += o.CacheRead
	t.CacheWrite += o.CacheWrite
}

func newDetail() Detail {
	return Detail{ByDay: map[string]map[string]Totals{}, Models: map[string]Totals{}, Turns: []TurnUsage{}}
}

func (d *Detail) put(at time.Time, model string, t Totals, loc *time.Location) {
	if model == "" {
		model = "未知模型"
	}
	day := at.In(loc).Format("2006-01-02")
	if d.ByDay[day] == nil {
		d.ByDay[day] = map[string]Totals{}
	}
	m := d.ByDay[day][model]
	m.add(t)
	d.ByDay[day][model] = m
	mm := d.Models[model]
	mm.add(t)
	d.Models[model] = mm
	d.Total.add(t)
}

// merge 把另一份明细（例如子 Agent）的按天、按模型数字加进来；轮次不合并。
func (d *Detail) merge(o Detail) {
	for day, models := range o.ByDay {
		if d.ByDay[day] == nil {
			d.ByDay[day] = map[string]Totals{}
		}
		for model, t := range models {
			m := d.ByDay[day][model]
			m.add(t)
			d.ByDay[day][model] = m
		}
	}
	for model, t := range o.Models {
		m := d.Models[model]
		m.add(t)
		d.Models[model] = m
	}
	d.Total.add(o.Total)
}

type claudeDetailLine struct {
	Type        string `json:"type"`
	Timestamp   string `json:"timestamp"`
	IsSidechain bool   `json:"isSidechain"`
	Message     struct {
		ID      string          `json:"id"`
		Model   string          `json:"model"`
		Content json.RawMessage `json:"content"`
		Usage   *struct {
			Input      int64 `json:"input_tokens"`
			Output     int64 `json:"output_tokens"`
			CacheRead  int64 `json:"cache_read_input_tokens"`
			CacheWrite int64 `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

// isPrompt：用户自己发的消息（字符串，或含 text 的数组），而不是工具结果回传。只看类型字段，不读正文。
func isPrompt(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	if strings.HasPrefix(s, `"`) {
		return true
	}
	var parts []struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return false
	}
	for _, p := range parts {
		if p.Type == "tool_result" {
			return false
		}
	}
	for _, p := range parts {
		if p.Type == "text" {
			return true
		}
	}
	return false
}

// ClaudeDetail 读一个 Claude 会话文件的明细。同一条消息流式写多行时按 message.id 只计最后一次。
func ClaudeDetail(path string, loc *time.Location) (Detail, error) {
	d := newDetail()
	type msg struct {
		at    time.Time
		model string
		t     Totals
		turn  int
	}
	per := map[string]msg{}
	order := []string{}
	turn := -1
	n := 0
	err := scan(path, func(b []byte) {
		var l claudeDetailLine
		if json.Unmarshal(b, &l) != nil {
			return
		}
		at, _ := time.Parse(time.RFC3339Nano, l.Timestamp)
		if l.Type == "user" && !l.IsSidechain && isPrompt(l.Message.Content) {
			turn++
			d.Turns = append(d.Turns, TurnUsage{Start: l.Timestamp})
			return
		}
		if l.Type != "assistant" || l.Message.Usage == nil {
			return
		}
		id := l.Message.ID
		if id == "" {
			n++
			id = "#" + string(rune(n))
		}
		if _, seen := per[id]; !seen {
			order = append(order, id)
		}
		u := l.Message.Usage
		per[id] = msg{at: at, model: l.Message.Model, t: Totals{Input: u.Input, Output: u.Output, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite}, turn: turn}
	})
	for _, id := range order {
		m := per[id]
		d.put(m.at, m.model, m.t, loc)
		if m.turn >= 0 && m.turn < len(d.Turns) {
			d.Turns[m.turn].add(m.t)
		}
	}
	return d, err
}

type codexDetailLine struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Payload   struct {
		Type  string `json:"type"`
		Model string `json:"model"`
		Info  *struct {
			Total *struct {
				Input  int64 `json:"input_tokens"`
				Cached int64 `json:"cached_input_tokens"`
				Output int64 `json:"output_tokens"`
			} `json:"total_token_usage"`
		} `json:"info"`
	} `json:"payload"`
}

// CodexDetail 按 token_count 的累计值逐次相减，得到每次增加的用量，再按天、按模型归档。
// Codex 记录里的 user_message 视为一轮的开始。
func CodexDetail(path string, loc *time.Location) (Detail, error) {
	d := newDetail()
	var last Totals
	model := ""
	err := scan(path, func(b []byte) {
		s := string(b)
		if !strings.Contains(s, `"token_count"`) && !strings.Contains(s, `"turn_context"`) && !strings.Contains(s, `"user_message"`) {
			return
		}
		var l codexDetailLine
		if json.Unmarshal(b, &l) != nil {
			return
		}
		switch {
		case l.Type == "turn_context" && l.Payload.Model != "":
			model = l.Payload.Model
		case l.Payload.Type == "user_message":
			d.Turns = append(d.Turns, TurnUsage{Start: l.Timestamp})
		case l.Payload.Type == "token_count" && l.Payload.Info != nil && l.Payload.Info.Total != nil:
			u := l.Payload.Info.Total
			in := u.Input - u.Cached
			if in < 0 {
				in = u.Input
			}
			cur := Totals{Input: in, Output: u.Output, CacheRead: u.Cached}
			delta := Totals{Input: cur.Input - last.Input, Output: cur.Output - last.Output, CacheRead: cur.CacheRead - last.CacheRead}
			if delta.Input < 0 || delta.Output < 0 || delta.CacheRead < 0 { // 累计值回退（新文件段）：整段重算
				delta = cur
			}
			last = cur
			if delta.Zero() {
				return
			}
			at, _ := time.Parse(time.RFC3339Nano, l.Timestamp)
			d.put(at, model, delta, loc)
			if len(d.Turns) > 0 {
				d.Turns[len(d.Turns)-1].add(delta)
			}
		}
	})
	return d, err
}

type subMeta struct {
	AgentType   string `json:"agentType"`
	Description string `json:"description"`
	Finished    bool   `json:"finished"`
}

// claudeSubagents 读 <会话目录>/subagents/agent-*.jsonl 及同名 .meta.json。
func claudeSubagents(sessionFile string, loc *time.Location) ([]Subagent, Detail) {
	dir := filepath.Join(strings.TrimSuffix(sessionFile, ".jsonl"), "subagents")
	files, _ := filepath.Glob(filepath.Join(dir, "agent-*.jsonl"))
	sort.Strings(files)
	all := newDetail()
	out := []Subagent{}
	for _, f := range files {
		id := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(f), "agent-"), ".jsonl")
		var m subMeta
		if b, err := os.ReadFile(strings.TrimSuffix(f, ".jsonl") + ".meta.json"); err == nil {
			_ = json.Unmarshal(b, &m)
		}
		d, err := ClaudeDetail(f, loc)
		if err != nil {
			continue
		}
		start, end := "", ""
		for _, t := range d.Turns {
			if start == "" || t.Start < start {
				start = t.Start
			}
		}
		end = lastTimestamp(f)
		desc := []rune(m.Description)
		if len(desc) > 80 {
			desc = append(desc[:79], '…')
		}
		out = append(out, Subagent{ID: id, Type: m.AgentType, Description: string(desc), Finished: m.Finished, Start: start, End: end, Total: d.Total})
		all.merge(d)
	}
	return out, all
}

func lastTimestamp(path string) string {
	last := ""
	_ = scan(path, func(b []byte) {
		var l struct {
			Timestamp string `json:"timestamp"`
		}
		if json.Unmarshal(b, &l) == nil && l.Timestamp != "" {
			last = l.Timestamp
		}
	})
	return last
}

func (f Finder) file(provider, sessionID string) string {
	if !safeID(sessionID) {
		return ""
	}
	var files []string
	switch provider {
	case "claude":
		files, _ = filepath.Glob(filepath.Join(f.ClaudeRoot, "*", sessionID+".jsonl"))
	case "codex":
		files, _ = filepath.Glob(filepath.Join(f.CodexRoot, "*", "*", "*", "*"+sessionID+".jsonl"))
	}
	if len(files) == 0 {
		return ""
	}
	return files[len(files)-1]
}

// Detail 返回会话自身的明细、子 Agent 列表，以及“会话 + 子 Agent”的按天合计（用于历史归档）。找不到文件时 ok=false。
func (f Finder) Detail(provider, sessionID string, loc *time.Location) (self Detail, subs []Subagent, withSubs Detail, ok bool) {
	path := f.file(provider, sessionID)
	if path == "" {
		return Detail{}, nil, Detail{}, false
	}
	var err error
	switch provider {
	case "claude":
		self, err = ClaudeDetail(path, loc)
	case "codex":
		self, err = CodexDetail(path, loc)
	}
	if err != nil {
		return Detail{}, nil, Detail{}, false
	}
	withSubs = newDetail()
	withSubs.merge(self)
	subs = []Subagent{}
	if provider == "claude" {
		var subTotal Detail
		subs, subTotal = claudeSubagents(path, loc)
		withSubs.merge(subTotal)
	}
	return self, subs, withSubs, true
}
