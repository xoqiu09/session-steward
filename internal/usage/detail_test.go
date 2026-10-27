package usage

import (
	"path/filepath"
	"testing"
	"time"
)

// 合成 transcript：按轮、按天、按模型拆分；工具结果回传不算新的一轮；子 Agent 单独列出并计入合计。
func TestClaudeDetailTurnsDaysAndSubagents(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "proj", "sid-1.jsonl"), `{"type":"user","timestamp":"2026-10-26T15:00:00Z","message":{"content":"第一问"}}
{"type":"assistant","timestamp":"2026-10-26T15:00:05Z","message":{"id":"m1","model":"claude-a","usage":{"input_tokens":10,"output_tokens":1}}}
{"type":"assistant","timestamp":"2026-10-26T15:00:06Z","message":{"id":"m1","model":"claude-a","usage":{"input_tokens":10,"output_tokens":4}}}
{"type":"user","timestamp":"2026-10-26T15:00:07Z","message":{"content":[{"type":"tool_result","content":"x"}]}}
{"type":"assistant","timestamp":"2026-10-26T15:00:08Z","message":{"id":"m2","model":"claude-a","usage":{"input_tokens":2,"output_tokens":3}}}
{"type":"user","timestamp":"2026-10-27T01:00:00Z","message":{"content":[{"type":"text","text":"第二问"}]}}
{"type":"assistant","timestamp":"2026-10-27T01:00:05Z","message":{"id":"m3","model":"claude-b","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":50}}}
{"type":"assistant","timestamp":"2026-10-27T01:00:06Z","message":{"id":"m4","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}}}
{"type":"assistant","timestamp":"2026-10-27T01:00:07Z","message":{"id":"m5","model":"claude-c","usage":{"input_tokens":0,"output_tokens":0}}}
`)
	write(t, filepath.Join(root, "proj", "sid-1", "subagents", "agent-x1.jsonl"), `{"type":"user","isSidechain":true,"timestamp":"2026-10-27T01:00:10Z","message":{"content":"子任务"}}
{"type":"assistant","isSidechain":true,"timestamp":"2026-10-27T01:00:20Z","message":{"id":"s1","model":"claude-b","usage":{"input_tokens":4,"output_tokens":6}}}
`)
	write(t, filepath.Join(root, "proj", "sid-1", "subagents", "agent-x1.meta.json"), `{"agentType":"Explore","description":"查一下数据从哪来","finished":true}`)
	utc8 := time.FixedZone("UTC+8", 8*3600)
	self, subs, all, ok := Finder{ClaudeRoot: root}.Detail("claude", "sid-1", utc8)
	if !ok {
		t.Fatal("没找到")
	}
	if len(self.Turns) != 2 || self.Turns[0].Output != 7 || self.Turns[1].CacheRead != 50 {
		t.Fatalf("轮次 %+v", self.Turns)
	}
	// 本地 UTC+8：第一轮在 10/26 23:00，第二轮在 10/27 09:00
	if _, ok := self.Models["<synthetic>"]; ok || len(self.Models) != 2 || len(self.ByDay["2026-10-27"]) != 1 {
		t.Fatalf("占位模型和 0 token 的模型不应出现在列表里：%+v", self.Models)
	}
	if self.ByDay["2026-10-26"]["claude-a"].Output != 7 || self.ByDay["2026-10-27"]["claude-b"].Output != 1 {
		t.Fatalf("按天 %+v", self.ByDay)
	}
	if len(subs) != 1 || subs[0].Type != "Explore" || !subs[0].Finished || subs[0].Total.Output != 6 || subs[0].Description != "查一下数据从哪来" {
		t.Fatalf("子 Agent %+v", subs)
	}
	if all.Total.Output != self.Total.Output+6 || all.ByDay["2026-10-27"]["claude-b"].Output != 7 {
		t.Fatalf("含子 Agent 合计 %+v", all)
	}
	if old, _ := (Finder{ClaudeRoot: root}).Totals("claude", "sid-1"); old != self.Total {
		t.Fatalf("会话自身合计应与原有统计一致：%+v vs %+v", old, self.Total)
	}
}

func TestCodexDetailDeltas(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "2026", "10", "26", "rollout-x-abc-9.jsonl"), `{"type":"turn_context","timestamp":"2026-10-26T10:00:00Z","payload":{"model":"gpt-x"}}
{"type":"event_msg","timestamp":"2026-10-26T10:00:01Z","payload":{"type":"user_message"}}
{"type":"event_msg","timestamp":"2026-10-26T10:00:02Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":5}}}}
{"type":"event_msg","timestamp":"2026-10-27T10:00:01Z","payload":{"type":"user_message"}}
{"type":"event_msg","timestamp":"2026-10-27T10:00:02Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":200,"output_tokens":20}}}}
`)
	self, _, _, ok := Finder{CodexRoot: root}.Detail("codex", "abc-9", time.UTC)
	if !ok || len(self.Turns) != 2 {
		t.Fatalf("%v %+v", ok, self)
	}
	if d := self.ByDay["2026-10-26"]["gpt-x"]; d.Input != 60 || d.CacheRead != 40 || d.Output != 5 {
		t.Fatalf("第一天 %+v", d)
	}
	if d := self.ByDay["2026-10-27"]["gpt-x"]; d.Input != 40 || d.CacheRead != 160 || d.Output != 15 {
		t.Fatalf("第二天 %+v", d)
	}
	if old, _ := (Finder{CodexRoot: root}).Totals("codex", "abc-9"); old != self.Total {
		t.Fatalf("合计应与原有统计一致：%+v vs %+v", old, self.Total)
	}
}
