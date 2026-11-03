// Package demodata supplies only fictional projects through existing Core APIs.
// It does not discover repositories, read sessions, install hooks or run Agents.
package demodata

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/projectstructure"
)

const Version = "synthetic-demo-v1"

// Locator represents demo directories directly, without executing Git or
// inheriting a real repository from an ancestor of the temporary directory.
type Locator struct{}

func (Locator) Locate(_ context.Context, cwd string) gitx.Location {
	if canonical, err := filepath.EvalSymlinks(cwd); err == nil {
		cwd = canonical
	}
	return gitx.Location{CommonDir: "dir:" + cwd, Worktree: cwd, RepoName: filepath.Base(cwd)}
}

type feature struct{ id, title, implementation, validation string }
type project struct {
	name, workID, task, goal, provider, status, progress, blocker, next string
	features                                                            []feature
	groups                                                              []projectstructure.Group
	relations                                                           []projectstructure.Relation
}

func group(id, title, question string, ids ...string) projectstructure.Group {
	g := projectstructure.Group{ID: id, Title: title, Question: question}
	for _, id := range ids {
		g.Features = append(g.Features, projectstructure.Feature{ID: id})
	}
	return g
}

func projects() []project {
	return []project{
		{
			name: "示例-阅读站", workID: "READ-001", task: "合成演示：阅读页面等待你查看", provider: "claude", status: "review",
			goal:     "把收集的阅读资料变成可检索、可读且有来源的站点。",
			progress: "演示交付：阅读页与搜索条目已有模拟结果，等待用户查看。",
			next:     "在房间里沿着功能关系阅读，再查看交付；这是合成状态，不是真实验证。",
			features: []feature{
				{"collect", "收集阅读资料", "implemented", "passed"},
				{"read", "阅读文章", "implemented", "passed"},
				{"search", "搜索与返回原位置", "implemented", "not_verified"},
				{"sources", "核对内容来源", "implementing", "not_verified"},
			},
			groups: []projectstructure.Group{
				group("collect", "准备资料", "内容从哪里来？", "collect"),
				group("read", "阅读与查找", "怎样读文章、找内容并回到原处？", "read", "search"),
				group("check", "核对来源", "读到的内容有什么依据？", "sources"),
			},
			relations: []projectstructure.Relation{
				{From: "collect", To: "read", Label: "收集好的内容进入阅读与检索"},
				{From: "collect", To: "check", Label: "保留来源供核对"},
				{From: "check", To: "read", Label: "读者可以追溯内容依据"},
			},
		},
		{
			name: "示例-发布清单", workID: "CHECK-001", task: "合成演示：缺少封面样例", provider: "codex", status: "blocked",
			goal:     "把准备发布的材料逐项核对，并留下交付记录。",
			progress: "演示进展：清单录入已完成，封面检查还缺少一份示例。",
			blocker:  "合成卡点：缺少示例封面；不会访问真实发布账号。",
			next:     "查看卡点和下一步；演示中的决定只改变这份演示数据。",
			features: []feature{
				{"capture", "录入待发布材料", "implemented", "passed"},
				{"cover-check", "检查封面与文字", "implementing", "not_verified"},
				{"receipt", "保存发布核对记录", "not_started", "not_verified"},
			},
			groups: []projectstructure.Group{
				group("prepare", "准备材料", "这次要核对哪些材料？", "capture"),
				group("review", "检查内容", "封面和文字是否齐全？", "cover-check"),
				group("record", "留下记录", "核对完以后怎样追溯？", "receipt"),
			},
			relations: []projectstructure.Relation{
				{From: "prepare", To: "review", Label: "材料进入封面与文字检查"},
				{From: "review", To: "record", Label: "核对结果形成交付记录"},
			},
		},
		{
			name: "示例-素材册", workID: "ASSET-001", task: "合成演示：整理第一个项目目录", provider: "codex", status: "in_progress",
			goal:     "按用途保存素材，并能在需要时找回来。",
			progress: "已登记两项合成功能，还没有结构资料。",
			next:     "按首次使用说明导入素材册目录，再看概况与功能关系。",
			features: []feature{
				{"collect-assets", "保存素材与来源", "implemented", "not_verified"},
				{"find-assets", "按用途查找素材", "implementing", "not_verified"},
			},
		},
	}
}

func Seed(ctx context.Context, c *core.Core, dir string) error {
	root := filepath.Join(dir, "projects")
	if err := os.Mkdir(root, 0o700); err != nil {
		return err
	}
	base := c.St.Now().Add(-2 * time.Minute)
	for index, p := range projects() {
		path := filepath.Join(root, p.name)
		if err := os.Mkdir(path, 0o700); err != nil {
			return err
		}
		readme := fmt.Sprintf("# %s\n\n这是合成演示项目，不是真实工作记录。\n\n目标：%s\n\n本页只作为演示里的说明依据；所有状态均为虚构。\n", p.name, p.goal)
		if err := os.WriteFile(filepath.Join(path, "README.md"), []byte(readme), 0o600); err != nil {
			return err
		}
		needsMerge := false
		if err := c.CreateWorkItem(ctx, core.WorkItemInput{ID: p.workID, RepoPath: path, Title: p.task,
			Acceptance: "合成演示：看懂项目结构、进度和下一步；不代表真实项目验收。", NeedsMerge: &needsMerge}); err != nil {
			return err
		}
		sequence := 0
		send := func(kind event.Kind, configure func(*event.Event)) error {
			sequence++
			e := &event.Event{SchemaVersion: event.SchemaVersion, EventID: fmt.Sprintf("demo-%d-%d", index, sequence),
				OccurredAt: base.Add(time.Duration(index*10+sequence) * time.Second), Cwd: path,
				Source: event.Source{Channel: "hook", Provider: p.provider, Client: "unknown", HostID: "synthetic-demo", Version: Version},
				Kind:   kind, RawName: "synthetic-demo", SessionID: fmt.Sprintf("synthetic-demo-%d", index), WorkTag: p.workID}
			if configure != nil {
				configure(e)
			}
			_, err := c.Ingest(ctx, e)
			return err
		}
		if err := send(event.KindSessionStart, nil); err != nil {
			return err
		}
		if err := send(event.KindClaim, nil); err != nil {
			return err
		}
		if err := send(event.KindFeatures, func(e *event.Event) {
			e.Features = &event.FeatureBatch{ScopeStatus: "documented", ScopeBasis: "README.md：内置合成样例", Provenance: "仅用于演示界面，不是真实 Agent 验证"}
			for _, f := range p.features {
				e.Features.Features = append(e.Features.Features, event.FeatureUpdate{ID: f.id, Title: f.title,
					Candidate: Version, Implementation: f.implementation, Validation: f.validation,
					Evidence: "合成样例状态；没有执行真实业务测试，不代表用户验收。"})
			}
		}); err != nil {
			return err
		}
		if err := send(event.KindReport, func(e *event.Event) {
			e.Brief = map[string]string{"goal": p.goal, "stage": "implementing", "summary": p.task,
				"progress": p.progress, "blocker": p.blocker, "next": p.next, "next_owner": "user"}
		}); err != nil {
			return err
		}
		if p.status == "review" {
			if err := send(event.KindDeliver, func(e *event.Event) { e.Text = p.progress }); err != nil {
				return err
			}
			if err := send(event.KindStop, nil); err != nil {
				return err
			}
		} else if p.status == "blocked" {
			if err := c.UpdateWorkItem(ctx, p.workID, core.WorkItemPatch{Status: &p.status}); err != nil {
				return err
			}
			if err := send(event.KindAsk, func(e *event.Event) {
				e.Text = "合成提问：示例封面用浅色还是深色？此决定不会发布内容或运行命令。"
			}); err != nil {
				return err
			}
		}
		if len(p.groups) > 0 {
			var repoID int64
			if err := c.St.R().QueryRowContext(ctx, "SELECT repo_id FROM work_items WHERE id=?", p.workID).Scan(&repoID); err != nil {
				return err
			}
			document := projectstructure.Document{SchemaVersion: 1, Goal: p.goal, Audience: "首次体验 SS 的用户（合成样例）",
				Scope:      "所有项目、进度和验证结果均为合成数据；用来理解房间与功能关系，不代表真实执行或用户验收。",
				PreparedAt: "2026-11-03", BasisVersion: Version, Groups: p.groups, Relations: p.relations,
				Sources: []projectstructure.Source{{Path: "README.md", LineStart: 1, LineEnd: 7, Kind: "documentation", Note: "演示目录内生成的合成说明"}}}
			raw, err := json.Marshal(document)
			if err != nil {
				return err
			}
			if _, err = c.SaveProjectStructure(ctx, repoID, raw, "", "agent"); err != nil {
				return err
			}
		}
	}
	return nil
}
