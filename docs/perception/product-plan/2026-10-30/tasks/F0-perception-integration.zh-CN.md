# F0：P1/P3 与最新 main 的候选整合

状态：任务书就绪；待主线程分配及独立审查；本轮未执行。
分支建议：`feat/perception-integration-20261030`。执行时从最新 main 创建独立 worktree；当前没有创建该分支。
共用约束：[索引与回报格式](README.zh-CN.md)；[契约提案](../architecture-addendum.zh-CN.md)。

## 目标

得到同时包含 main、P1、P3 的单一候选，并保留已经上线的行为。

## 范围与复用

- 从执行时最新 origin/main 建新 worktree；合入 #37/#38 精确候选，原推送分支保留，不 force-push 或关闭原 PR。
- 解决 normalize.go、replay.go、TodayView.tsx 等冲突；复用同一套渠道定义、去重和元信息观察规则。
- 合入渠道写入白名单：`/hook/*` 只收 hook/transcript/process（空值按既有规则归为 hook）；user 只由 panelTx、git/github 只由核实器写入。拒绝伪造来源时不能刷新 LastSignal/LastSignalAt，不能只在规范化纯函数中声明规则。
- 合入无 claude CLI 的基础安装路径：Claude Desktop/App 的系统 PATH 找不到命令行时，仍可安装基础 12 个 hooks。新 5 项与 async 按显式版本参数 > 已记录会话版本 > PATH 探测取得的可核实版本决定；无法核实时不伪造新能力，也不能把基础 hooks 一并跳过。
- 保留 main 上已处理文案、记忆整理静默规则、WorkOverview、V1 三秒归并和远端只读；不得回退到旧任务书的验收通过文案。
- web/dist 从最终源码重建，记录两个原始候选与整合候选；独立审查者对照 P1/P3 标准复核。
- 与 U1 确认 schema5 及迁移边界；候选构建可使用隔离 home，不打开真实库。正式 schema5 发布前，必须先完成仍为 schema4 的 U1 过渡升级器发布与所有目标设备安装，或用户明确选择并验证一次性手动路线；F0 隔离整合不等于获准发布。

## 不做

整合不代表发布；不绕过内置升级 schema 守卫，不变更原两份 PR 的审查结论。

## 验收标准

1. 本轮已发现的三类源码冲突消除，旧分支不变。
2. P1 绑定区间、迟到信号、model 拒绝、hub 无 Ref 与 P3 观察不复活/不交付回归通过。
3. 旧 main 的项目归档、记忆静默、已处理、完整世界和返回镜头不退化。
4. 集成代码通过全仓普通/竞态、前端测试/构建；合成库迁移通过，正式库未触碰。
5. 从真实 HTTP hook 入口验证 hook/transcript/process 可收，伪造 user/git/github 被拒绝且最新信号不变；合法 panelTx 与核实器仍可写。
6. 合成无 CLI 安装与 MacBook Claude Desktop/App 场景 S19 覆盖基础 12 hooks；新 5 项/async 的已知、未知、显式版本优先级分别记录，未触发真实新事件仍写无法验证。

## 验证

按仓库 AGENTS 跑 Go 全仓、-race、前端测试/构建；复用现有合成用例，记录精确 HEAD 与 dist。 每条标准写满足/不满足/无法验证；模拟 expected 不得填成真实已通过。

## 交付

新整合草稿 PR，列出原候选、冲突处理及未验证项；合并策略由用户后续决定。 按共同六段格式回报，附精确候选、证据和未验证项；没有 PR 则明确仅设计/调研。用户确认与执行者自测分开。
