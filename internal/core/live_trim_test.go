package core

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// liveBigSnapshot 造一份大规模的合成快照：124 个项目、2000 多个会话。
//   - 第 0–13 个项目活跃、有在画面上的会话（0–7 有助手在干活），最近活动依次变早；
//   - 第 14–23 个项目活跃、只有未关闭的工作项，最近活动更早；
//   - 其余项目安静或沉睡，只有历史会话和工作项。
//
// 项目编号故意与顺序无关（高编号的反而最活跃），用来检查通用名按全部项目编号排名。
func liveBigSnapshot(now time.Time) *Snapshot {
	ts := func(d time.Duration) string { return now.Add(-d).UTC().Format(time.RFC3339Nano) }
	s := &Snapshot{Cursor: 99, Now: now.UTC().Format(time.RFC3339Nano)}
	id := func(i int) int64 { return int64(1000 - i*7) }
	sessionID, runID := int64(1), int64(1)
	for i := 0; i < 124; i++ {
		repo := id(i)
		r := Repo{ID: repo, Name: fmt.Sprintf("合成私密项目-%03d", i), CommonDir: fmt.Sprintf("/synthetic/home/project-%03d", i), IsGit: true, TargetRef: "synthetic/main"}
		switch {
		case i < 24:
			r.Activity, r.LastActivityAt = "active", ts(time.Duration(i)*time.Minute)
		case i%2 == 0:
			r.Activity, r.LastActivityAt = "quiet", ts(72*time.Hour)
		default:
			r.Activity, r.LastActivityAt = "dormant", ts(40*24*time.Hour)
		}
		s.Repos = append(s.Repos, r)
		ref := &repo
		// 每个项目 30 个工作项：一半未关闭，一半已关闭（其中几个刚刚关闭）。
		for k := 0; k < 30; k++ {
			status := []string{"todo", "in_progress", "blocked", "review", "done", "abandoned"}[k%6]
			updated := ts(time.Duration(k) * 3 * time.Hour)
			if k < 6 {
				updated = ts(time.Duration(k) * time.Minute)
			}
			s.WorkItems = append(s.WorkItems, WorkItem{ID: fmt.Sprintf("SYN%03d-%02d", i, k), RepoID: ref, Title: fmt.Sprintf("合成私密标题 %d-%d", i, k),
				Status: status, Branch: "synthetic/branch", Acceptance: "合成验收说明", MergeState: "none", CreatedAt: ts(30 * 24 * time.Hour), UpdatedAt: updated,
				Agents: []string{"claude", "codex"}, Waiting: []string{"SYN-UP-1", "SYN-UP-2"}, Brief: &Brief{}})
		}
		// 历史会话：每个项目 16 个，合计约 2000 个。
		for k := 0; k < 16; k++ {
			s.Sessions = append(s.Sessions, Session{ID: sessionID, HostID: "synthetic-host", Provider: "claude", ProviderSessionID: fmt.Sprintf("synthetic-%d", sessionID),
				Cwd: fmt.Sprintf("/synthetic/home/project-%03d", i), Branch: "synthetic/branch", RepoID: ref, State: "ended", DataSource: "history", Freshness: "history",
				FirstSeenAt: ts(10 * 24 * time.Hour), LastActivityAt: ts(time.Duration(k+2) * 24 * time.Hour), Title: "合成私密会话标题", LastToolPreview: "synthetic tool preview",
				ResumeCommand: "synthetic --resume"})
			s.Runs = append(s.Runs, Run{ID: runID, WorkItemID: fmt.Sprintf("SYN%03d-%02d", i, k), SessionID: sessionID, Provider: "claude", Attempt: 1,
				StartedAt: ts(5 * 24 * time.Hour), EndedAt: ts(5*24*time.Hour - time.Hour), Outcome: "delivered"})
			sessionID++
			runID++
		}
		if i < 14 {
			// 在画面上的会话：前 8 个项目各 12 个在干活，其余项目 3 个刚刚空闲、2 个空闲很久（不上画面）。
			working := 0
			if i < 8 {
				working = 12
			}
			for k := 0; k < working+5; k++ {
				state, last := "running", ts(time.Duration(i)*time.Minute+time.Duration(k)*time.Second)
				if k >= working {
					state, last = "idle", ts(time.Duration(i+k-working)*time.Minute)
					if k-working >= 3 {
						last = ts(3 * time.Hour)
					}
				}
				s.Sessions = append(s.Sessions, Session{ID: sessionID, Provider: []string{"claude", "codex", "custom-agent"}[k%3], RepoID: ref, State: state,
					DataSource: "live", Freshness: "live", LastActivityAt: last, WorkItemID: fmt.Sprintf("SYN%03d-%02d", i, k%30), Cwd: "/synthetic/live", Title: "合成私密会话标题"})
				s.Runs = append(s.Runs, Run{ID: runID, WorkItemID: fmt.Sprintf("SYN%03d-%02d", i, k%30), SessionID: sessionID, Provider: "claude", Attempt: 1, StartedAt: ts(time.Minute)})
				sessionID++
				runID++
			}
		}
	}
	return s
}

func TestLiveSnapshotTrimsToShownProjects(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	snap := liveBigSnapshot(now)
	if len(snap.Repos) != 124 || len(snap.Sessions) < 2000 {
		t.Fatalf("合成规模不对: %d 个项目, %d 个会话", len(snap.Repos), len(snap.Sessions))
	}
	out := LiveSnapshot(snap, []byte("k"))

	// 只带要画的项目：有助手在干活的 8 个在前（按最近活动），其余按最近活动补满 12 个。
	if len(out.Repos) != LiveMaxProjects {
		t.Fatalf("应只带 %d 个项目，实际 %d", LiveMaxProjects, len(out.Repos))
	}
	for i, r := range out.Repos {
		if want := int64(1000 - i*7); r.ID != want {
			t.Fatalf("第 %d 个项目应为 %d，实际 %d", i, want, r.ID)
		}
	}
	if out.More != 124-LiveMaxProjects {
		t.Fatalf("没画出来的项目数: %d", out.More)
	}

	// 通用名按全部 124 个项目的编号名次，而不是按裁剪后的 12 个。
	ids := make([]int64, 0, len(snap.Repos))
	for _, r := range snap.Repos {
		ids = append(ids, r.ID)
	}
	full := LiveProjectNames(ids)
	for _, r := range out.Repos {
		if r.Name != full[r.ID] {
			t.Fatalf("项目 %d 裁剪后改名: %s → %s", r.ID, full[r.ID], r.Name)
		}
	}
	if out.Repos[0].Name != "项目 124" || out.Repos[0].Name == "项目 A" {
		t.Fatalf("编号最大的项目应叫“项目 124”: %s", out.Repos[0].Name)
	}

	// 每个项目的记录数有上限；所有记录都属于画出来的项目。
	shown := map[int64]bool{}
	for _, r := range out.Repos {
		shown[r.ID] = true
	}
	sessions, open, closed, runs := map[int64]int{}, map[int64]int{}, map[int64]int{}, map[int64]int{}
	itemRepo, sessionRepo := map[string]int64{}, map[int64]int64{}
	for _, x := range out.Sessions {
		if x.RepoID == nil || !shown[*x.RepoID] {
			t.Fatalf("会话 %d 不属于画出来的项目", x.ID)
		}
		if x.DataSource != "live" || x.State == "ended" {
			t.Fatalf("历史或已结束的会话不应带上: %+v", x)
		}
		sessions[*x.RepoID]++
		sessionRepo[x.ID] = *x.RepoID
	}
	for _, w := range out.WorkItems {
		if w.RepoID == nil || !shown[*w.RepoID] {
			t.Fatalf("工作项 %s 不属于画出来的项目", w.ID)
		}
		itemRepo[w.ID] = *w.RepoID
		if liveOpen(w.Status) {
			open[*w.RepoID]++
		} else {
			closed[*w.RepoID]++
		}
	}
	for _, r := range out.Runs {
		repo, ok := itemRepo[r.WorkItemID]
		if !ok {
			repo, ok = sessionRepo[r.SessionID]
		}
		if !ok || !shown[repo] {
			t.Fatalf("运行 %d 不属于画出来的项目", r.ID)
		}
		runs[repo]++
	}
	for _, r := range out.Repos {
		if sessions[r.ID] > liveMaxSessions || open[r.ID] > liveMaxOpenItems || closed[r.ID] > liveMaxClosedItems || runs[r.ID] > liveMaxOpenRuns+liveMaxEndedRuns {
			t.Fatalf("项目 %d 超过上限: 会话 %d 未关闭 %d 已关闭 %d 运行 %d", r.ID, sessions[r.ID], open[r.ID], closed[r.ID], runs[r.ID])
		}
	}
	// 有 12 个助手在干活的项目：带上的 8 个会话全是在干活的。
	for _, x := range out.Sessions {
		if *x.RepoID == 1000 && x.State != "running" {
			t.Fatalf("正在干活的会话应优先: %+v", x)
		}
	}
	if sessions[1000] != liveMaxSessions {
		t.Fatalf("第一个项目应带满 %d 个会话: %d", liveMaxSessions, sessions[1000])
	}
	// 空闲超过 30 分钟的会话不上画面（与前端口径一致）：第 8 个项目只有 3 个刚刚空闲的。
	if sessions[1000-8*7] != 3 {
		t.Fatalf("空闲很久的会话不应带上: %d", sessions[1000-8*7])
	}

	// 大小：远小于完整快照，低于 100 KB。
	b, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	fullJSON, _ := json.Marshal(liveUntrimmed(snap))
	t.Logf("合成数据 %d 个项目、%d 个会话、%d 个工作项、%d 个运行：展示快照 %d 字节（全部记录约 %d 字节）",
		len(snap.Repos), len(snap.Sessions), len(snap.WorkItems), len(snap.Runs), len(b), len(fullJSON))
	if len(b) >= 100*1024 {
		t.Fatalf("展示快照太大: %d 字节", len(b))
	}
}

// liveUntrimmed 只给测试用：裁剪前（所有项目、所有记录）的快照，用来对比大小。
func liveUntrimmed(s *Snapshot) *Snapshot {
	return &Snapshot{Cursor: s.Cursor, Now: s.Now, Repos: s.Repos, Sessions: s.Sessions, WorkItems: s.WorkItems, Runs: s.Runs}
}

// 裁剪后，相邻两份快照仍能比出进度：工作项交付后被收下、运行结束，都能在两份里看到同一个编号。
func TestLiveSnapshotKeepsTransitionsVisible(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	prev := liveBigSnapshot(now)
	next := liveBigSnapshot(now.Add(5 * time.Second))
	find := func(s *Snapshot, id string) *WorkItem {
		for i := range s.WorkItems {
			if s.WorkItems[i].ID == id {
				return &s.WorkItems[i]
			}
		}
		t.Fatalf("合成数据里没有 %s", id)
		return nil
	}
	// 第一个项目里一个待处理的工作项，下一份快照里被收下。
	const target = "SYN000-03"
	if find(prev, target).Status != "review" {
		t.Fatal("合成数据的前提变了")
	}
	w := find(next, target)
	w.Status, w.UpdatedAt = "done", now.Add(5*time.Second).Format(time.RFC3339Nano)
	// 一次运行在下一份里结束。
	var runID int64
	for i := range next.Runs {
		if next.Runs[i].EndedAt == "" && next.Runs[i].WorkItemID == "SYN000-00" {
			runID = next.Runs[i].ID
			next.Runs[i].EndedAt, next.Runs[i].Outcome = now.Add(4*time.Second).Format(time.RFC3339Nano), "delivered"
			break
		}
	}
	a, b := LiveSnapshot(prev, []byte("k")), LiveSnapshot(next, []byte("k"))
	opaque := LiveItemID([]byte("k"), target)
	status := func(s *LiveSnap) string {
		for _, w := range s.WorkItems {
			if w.ID == opaque {
				return w.Status
			}
		}
		return ""
	}
	if status(a) != "review" || status(b) != "done" {
		t.Fatalf("工作项状态变化在裁剪后看不到: %q → %q", status(a), status(b))
	}
	ended := func(s *LiveSnap) (bool, string) {
		for _, r := range s.Runs {
			if r.ID == runID {
				return true, r.EndedAt
			}
		}
		return false, ""
	}
	if ok, at := ended(a); !ok || at != "" {
		t.Fatalf("上一份应带着未结束的运行 %d", runID)
	}
	if ok, at := ended(b); !ok || at == "" {
		t.Fatalf("下一份应带着刚结束的运行 %d", runID)
	}
	// 关闭很久的工作项不带。
	for _, w := range b.WorkItems {
		if w.Status == "done" || w.Status == "abandoned" {
			if at := liveAt(w.UpdatedAt); now.Sub(at) > liveClosedWindow {
				t.Fatalf("关闭很久的工作项不应带上: %+v", w)
			}
		}
	}
}

// 项目进出画面不改变其他项目的名字。
func TestLiveSnapshotNamesStableWhenTrimmed(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	a := LiveSnapshot(liveBigSnapshot(now), []byte("k"))
	snap := liveBigSnapshot(now)
	// 第一个项目的会话全部结束、工作项全部关闭：它离开画面，第 13 个项目补进来。
	for i := range snap.Sessions {
		if snap.Sessions[i].RepoID != nil && *snap.Sessions[i].RepoID == 1000 {
			snap.Sessions[i].State = "ended"
		}
	}
	for i := range snap.WorkItems {
		if *snap.WorkItems[i].RepoID == 1000 {
			snap.WorkItems[i].Status = "done"
		}
	}
	b := LiveSnapshot(snap, []byte("k"))
	names := map[int64]string{}
	for _, r := range a.Repos {
		names[r.ID] = r.Name
	}
	both := 0
	for _, r := range b.Repos {
		if r.ID == 1000 {
			t.Fatal("离开画面的项目不应再出现")
		}
		if n, ok := names[r.ID]; ok {
			both++
			if n != r.Name {
				t.Fatalf("项目 %d 改名: %s → %s", r.ID, n, r.Name)
			}
		}
	}
	if both != LiveMaxProjects-1 || len(b.Repos) != LiveMaxProjects {
		t.Fatalf("应只换掉一个项目: 共同 %d, 共 %d", both, len(b.Repos))
	}
}
