# 派活台任务书

设计见 [design.zh-CN.md](../design.zh-CN.md)。四份任务书都还没有开工，也没有指派 Agent。

| 任务 | 分支 | 依赖 | 在哪台做 |
| --- | --- | --- | --- |
| [K2 桌面 App 接手点验](K2-desktop-handoff.zh-CN.md) | 不改代码；证据放 `docs/dispatch/evidence/k2/`，分支 `docs/dispatch-k2-evidence` | 无，最先做 | Mac Studio（要用户在屏幕前） |
| [K1 Studio 本机派活台](K1-local-desk.zh-CN.md) | `feat/dispatch-desk-local` | 无硬依赖；“回电脑接着做”按钮等 K2 通过 | Mac Studio |
| [K3 MacBook 配对与派活](K3-macbook.zh-CN.md) | `feat/dispatch-desk-macbook` | K1 合入 | 两台都要 |
| [K4 微信入口调研](K4-wechat-research.zh-CN.md) | `docs/dispatch-wechat-research` | 无；只调研 | 任意 |

## 共同规则

- 遵守仓库 AGENTS.md：从最新 `origin/main` 开分支；中文提交和草稿 PR；GitHub 写操作前确认 `gh api user` 是 `xoqiu09`；不合并、不发版、不替换任何一台的正式安装。
- 测试只用合成项目和合成数据。真实 Codex 执行只在专门的合成项目里做，会话号、密钥和日志不进仓库。
- 设计不对时停下，在回报里写清楚，不悄悄改方向。尤其是 K2 不通过时，K1 不做“只给命令行”的降级。
- Go 改动跑 `go test ./...`；状态机、租约、并发改动加跑 `go test -race ./...`。前端改动在 `web/` 跑 `npm test`、`npm run build`，提交重建的 `web/dist`。
- 回报按 [任务回报格式](../../perception/product-plan/2026-10-30/tasks/README.zh-CN.md) 写，Agent 自测、真实点验和用户验收分开写。
