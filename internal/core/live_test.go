package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

const liveSentinel = "SECRET"

// fillSentinel 用反射把结构里所有字符串（含嵌套、切片元素、map 键值、指针）填上哨兵值。
// 整数和布尔也填上非零值，切片填两个元素。以后有人给 Snapshot 加文字字段，这个测试默认就会覆盖到。
func fillSentinel(v reflect.Value, path string, depth int) {
	if depth > 8 {
		return
	}
	switch v.Kind() {
	case reflect.String:
		v.SetString(liveSentinel + "-" + path)
	case reflect.Bool:
		v.SetBool(true)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		v.SetInt(int64(depth + 1))
	case reflect.Uint, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		v.SetUint(uint64(depth + 1))
	case reflect.Float32, reflect.Float64:
		v.SetFloat(1.5)
	case reflect.Ptr:
		n := reflect.New(v.Type().Elem())
		fillSentinel(n.Elem(), path, depth+1)
		v.Set(n)
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			f := v.Field(i)
			if !f.CanSet() {
				continue
			}
			fillSentinel(f, path+"."+v.Type().Field(i).Name, depth+1)
		}
	case reflect.Slice:
		if v.Type().Elem().Kind() == reflect.Uint8 { // json.RawMessage 等
			b, _ := json.Marshal(map[string]string{"k": liveSentinel + "-" + path})
			v.SetBytes(b)
			return
		}
		s := reflect.MakeSlice(v.Type(), 2, 2)
		for i := 0; i < 2; i++ {
			fillSentinel(s.Index(i), fmt.Sprintf("%s[%d]", path, i), depth+1)
		}
		v.Set(s)
	case reflect.Map:
		m := reflect.MakeMap(v.Type())
		k := reflect.New(v.Type().Key()).Elem()
		fillSentinel(k, path+"{k}", depth+1)
		e := reflect.New(v.Type().Elem()).Elem()
		fillSentinel(e, path+"{v}", depth+1)
		m.SetMapIndex(k, e)
		v.Set(m)
	case reflect.Interface:
		v.Set(reflect.ValueOf(liveSentinel + "-" + path))
	}
}

// 展示快照里没有任何字段允许把数据里的自由文字原样带出：provider、状态、时间都要过枚举或解析校验，
// 所以“允许保留原文”的名单是空的。要放行某个字段，必须在这里明确写出字段路径并说明理由。
var livePassthrough = map[string]string{}

func TestLiveSnapshotLeaksNoText(t *testing.T) {
	var snap Snapshot
	fillSentinel(reflect.ValueOf(&snap).Elem(), "Snapshot", 0)
	// 引用同一个工作项（编号本身也是哨兵文字），用来检查重映射后各处一致。
	ref := snap.WorkItems[0].ID
	snap.Sessions[0].WorkItemID, snap.Runs[0].WorkItemID, snap.Deps[0].Upstream = ref, ref, ref
	// 确认填充确实到达了深层文字字段，避免测试本身失效。
	raw, _ := json.Marshal(snap)
	for _, want := range []string{"Snapshot.Repos[0].Name", "Snapshot.Sessions[1].Title", "Snapshot.WorkItems[0].Brief", "Snapshot.Approvals[0].Preview", "Snapshot.Runs[0].Provider"} {
		if !strings.Contains(string(raw), liveSentinel+"-"+want) {
			t.Fatalf("反射填充没有覆盖 %s", want)
		}
	}
	out := LiveSnapshot(&snap, []byte("k"))
	b, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	for path := range livePassthrough {
		text = strings.ReplaceAll(text, liveSentinel+"-"+path, "")
	}
	if i := strings.Index(text, liveSentinel); i >= 0 {
		end := min(len(text), i+80)
		t.Fatalf("展示快照泄露了文字字段：%s", text[i:end])
	}
	// 结构仍在：数量、关联保持，项目换成通用名，审批清空。
	if len(out.Repos) != 2 || len(out.Sessions) != 2 || len(out.WorkItems) != 2 || len(out.Runs) != 2 || len(out.Deps) != 2 {
		t.Fatalf("展示快照丢了结构: %+v", out)
	}
	if out.Approvals == nil || len(out.Approvals) != 0 || out.Features != nil || out.Managed != nil || out.Handoffs != nil || out.SessionUsage != nil {
		t.Fatal("展示快照不应带审批、功能、托管、交接、用量")
	}
	if out.Sessions[0].WorkItemID != out.WorkItems[0].ID || out.Runs[0].WorkItemID != out.WorkItems[0].ID || out.Deps[0].Upstream != out.WorkItems[0].ID {
		t.Fatal("工作项编号重映射后引用不一致")
	}
	if out.Sessions[0].Provider != "other" {
		t.Fatalf("未知 provider 应记为 other: %q", out.Sessions[0].Provider)
	}
}

func TestLiveSnapshotKeepsSafeFields(t *testing.T) {
	repo := int64(7)
	at := "2026-11-10T08:00:00.000000000Z"
	snap := &Snapshot{
		Now:       at,
		Repos:     []Repo{{ID: 7, Name: "示例-私密名", CommonDir: "/synthetic/path", IsGit: true, Activity: "active", LastActivityAt: at}},
		Sessions:  []Session{{ID: 3, Provider: "claude", RepoID: &repo, State: "running", DataSource: "live", Freshness: "live", LastActivityAt: at, WorkItemID: "SYN-001", Cwd: "/synthetic/path", Title: "合成标题", Branch: "feature/x"}},
		WorkItems: []WorkItem{{ID: "SYN-001", RepoID: &repo, Title: "合成工作", Status: "review", Branch: "feature/x", Acceptance: "合成验收", Agents: []string{"codex"}, UpdatedAt: at, Brief: &Brief{}}},
		Runs:      []Run{{ID: 9, WorkItemID: "SYN-001", SessionID: 3, Provider: "codex", StartedAt: at, EndedAt: at, Outcome: "failed: 合成原因"}},
		Approvals: []Approval{{ID: "a1", Status: "pending", Preview: "合成命令"}},
	}
	out := LiveSnapshot(snap, []byte("k"))
	b, _ := json.Marshal(out)
	for _, bad := range []string{"示例-私密名", "/synthetic/path", "合成标题", "合成工作", "合成验收", "feature/x", "SYN-001", "合成原因", "合成命令"} {
		if strings.Contains(string(b), bad) {
			t.Fatalf("展示快照包含 %q", bad)
		}
	}
	if out.Repos[0].Name != "项目 A" || out.Repos[0].Activity != "active" || out.Sessions[0].Provider != "claude" || out.Sessions[0].State != "running" ||
		out.WorkItems[0].Status != "review" || out.WorkItems[0].Agents[0] != "codex" || out.Runs[0].Outcome != "failed" || out.Runs[0].EndedAt != at || out.Now != at {
		t.Fatalf("展示快照丢了画面需要的字段: %s", b)
	}
	if !strings.HasPrefix(out.WorkItems[0].ID, "item-") || out.WorkItems[0].ID != LiveItemID([]byte("k"), "SYN-001") {
		t.Fatalf("工作项编号应换成稳定的不透明编号: %q", out.WorkItems[0].ID)
	}
}

func TestLiveProjectNamesStable(t *testing.T) {
	a := LiveProjectNames([]int64{12, 3, 40})
	b := LiveProjectNames([]int64{40, 12, 3})
	if !reflect.DeepEqual(a, b) || a[3] != "项目 A" || a[12] != "项目 B" || a[40] != "项目 C" {
		t.Fatalf("同一组项目应得到同样的名称: %v %v", a, b)
	}
	c := LiveProjectNames([]int64{12, 3, 40, 99})
	for id, name := range a {
		if c[id] != name {
			t.Fatalf("新增更大编号的项目改变了已有名称: %d %s → %s", id, name, c[id])
		}
	}
	if c[99] != "项目 D" {
		t.Fatal(c[99])
	}
	many := make([]int64, 30)
	for i := range many {
		many[i] = int64(i + 1)
	}
	m := LiveProjectNames(many)
	if m[26] != "项目 Z" || m[27] != "项目 27" || m[30] != "项目 30" {
		t.Fatalf("超过 26 个项目的名称: %s %s %s", m[26], m[27], m[30])
	}
}

func TestLiveNoteReadWrite(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	n, err := c.LiveNote(ctx)
	if err != nil || n != (LiveNote{}) {
		t.Fatalf("没有设置时应为空: %+v %v", n, err)
	}
	saved, err := c.SetLiveNote(ctx, LiveNote{Doing: "  整理合成数据 ", Thinking: "", Contact: "留言", UpdatedAt: "ignored"})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Doing != "整理合成数据" || saved.Contact != "留言" || saved.UpdatedAt == "" || saved.UpdatedAt == "ignored" {
		t.Fatalf("%+v", saved)
	}
	got, _ := c.LiveNote(ctx)
	if got != saved {
		t.Fatalf("读回不一致: %+v vs %+v", got, saved)
	}
	if _, err := c.SetLiveNote(ctx, LiveNote{Thinking: strings.Repeat("字", LiveNoteMax)}); err != nil {
		t.Fatal("正好 80 个字应允许", err)
	}
	for _, bad := range []LiveNote{{Doing: strings.Repeat("字", LiveNoteMax+1)}, {Contact: "a\nb"}} {
		if _, err := c.SetLiveNote(ctx, bad); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("应拒绝 %+v: %v", bad, err)
		}
	}
	if got, _ := c.LiveNote(ctx); got.Thinking != strings.Repeat("字", LiveNoteMax) {
		t.Fatal("被拒绝的写入不应改变已保存的说明")
	}
}
