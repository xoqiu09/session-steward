# 补充任务书索引与执行门槛

本包当前仅交付设计。没有启动下列实现任务，也没有同时创建 Agent 或聊天。下表“可研究”只表示依赖允许，不等于已指派执行。

先读原仓库 AGENTS、[原设计](../reference/docs/perception/architecture.zh-CN.md)、[原路线图](../reference/docs/perception/roadmap.zh-CN.md)、[本包方案](../README.zh-CN.md) 和 [共用契约](../architecture-addendum.zh-CN.md)。原 P1/P2/P3/T0/V1 任务书在 reference 中保留，不覆盖原文。

## 任务与依赖

| 任务 | 文件 | 阶段与依赖 |
| --- | --- | --- |
| D0 共用契约 | [D0](D0-contract.zh-CN.md) | 可先设计；独立审查后冻结，字段/API 仍是提案。 |
| F0 P1/P3 整合 | [F0](F0-perception-integration.zh-CN.md) | 待主线程分配及独立审查；基于最新 main 整合，不改原执行分支。 |
| U1 跨库升级恢复 | [U1](U1-schema-upgrade.zh-CN.md) | 可先设计；实现依赖 T0，schema 与迁移入口和 F0 负责人协调。 |
| W1 稳定世界和详情 | [W1](W1-stable-world.zh-CN.md) | D0 后可用模拟输入；公共类型/路由最终由 I0 接线。 |
| W2 动态恢复与来源映射 | [W2](W2-moments-recovery.zh-CN.md) | D0 后复用 V1；新 GitHub 事实等 P2，信号展示等 P1。 |
| A0 公共接入层 | [A0](A0-adapter-core.zh-CN.md) | D0 冻结、P1 整合后；独占公共身份/能力/桥接实现。 |
| A1 Harness | [A1](A1-harness.zh-CN.md) | 研究阶段可先做；原型等 A0，可先用冻结模拟接口。 |
| A2 WorkBuddy | [A2](A2-workbuddy.zh-CN.md) | 研究阶段可先做；桥接等 A0，不把 MCP 当作自动监听。 |
| M1 项目记忆 | [M1](M1-project-memory.zh-CN.md) | 数据设计依赖 D0；模型写入依赖 P6，正式迁移走共同升级流程。 |
| I0 集成验收 | [I0](I0-integration-acceptance.zh-CN.md) | 候选就绪后按验收场景逐项接线；真实工具单列。 |
| P4 会话记录补漏 | [P4 预备草案](P4-transcript-catchup.zh-CN.md) | P1 合入后重新核对再派实现；不扩大正文采集。 |
| P5 非托管存活 | [P5 预备草案](P5-process-liveness.zh-CN.md) | P1 后，格式/进程绑定先调研；不以安静推断结束。 |
| P6 SS 解释接口 | [P6 预备草案](P6-interpretation-api.zh-CN.md) | P1、D0；复用快照和摘要，模型解释不走 Ingest。 |
| P6b 小猫调用 | [P6b 预备草案](P6b-xiaomao-client.zh-CN.md) | P6 契约冻结后可在小猫仓库用模拟服务；真实联调等 P6。 |
| P7 安装运行记录 | [P7 预备草案](P7-installation-runtime.zh-CN.md) | T0、P2；跨库正式升级依赖 U1，真实发布另行安排。 |

P2 沿用 [原任务书](../reference/docs/perception/tasks/P2-github-pr-awareness.zh-CN.md)，只补充：全局请求预算与排队时间可见、PR 关联与当前候选检查分开、禁止旧 head 的检查成功冒充新 head 的成功。“允许关联祖先”与原验收第 3 条“head 不符不关联”的歧义由设计负责人先澄清；建议保留 PR 关联但明确旧候选，合并判断仍按精确证据，不清除尚未合并的新提交提醒。

P4～P7 是为分工准备的草案，遵守原路线图“前一期合入后再定实现任务书”的规则；不是锁定尚不存在的数据结构。

## 公共文件所有权

| 范围 | 唯一集成负责人 | 其他任务如何并行 |
| --- | --- | --- |
| 契约、身份、能力与来源语义 | D0 设计，A0 实现 | 适配器只消费已冻结版本，变更走补充审查。 |
| 当前 P1/P3 的事件定义、Ingest、回放、schema5 | F0 | 不让 W/A 任务各补一次 channel 或另迁移这两列。 |
| 升级状态机、备份/恢复、期间事件 | U1 | 与 F0 对齐 schema；迁移编号由一个登记处串行分配。 |
| 新迁移、快照/公共类型、公共路由 | A0 与 I0 指定单一当值负责人 | 各任务提交接口需求或独立模块，不同时编辑共同入口。 |
| 世界坐标、相机、WorldScene | W1；最终 I0 | W2 先只改独立队列/恢复模块，用适配接口，接线交 I0。 |
| 最终入口、依赖清单、最终 web/dist | I0 | 每个分支仍按 AGENTS 跑构建，产物在自己的 worktree；合并时不拼旧 bundle，I0 从整合源码重建。 |
| 小猫仓库 | P6b 负责人 | 不写 SS 数据库或 SS 服务状态文件，使用公开冻结接口。 |

## 所有任务的共同执行边界

1. 执行前重新核对远程 main、HEAD、dirty、PR 状态和所需版本；主仓库的 assets 不暂存、不 reset、不 clean。需要写仓库时从最新 origin/main 建独立 worktree，既有 T0 例外仅用于原任务，不扩散为新任务例外。
2. 从本地工具包装器和已有缓存运行。只装任务明确需要并经项目授权的依赖；不全局安装工具或改正式账号/模型/代理配置。
3. 草稿 PR 使用中文标题和说明。已有推送分支不 rebase/force-push；不能把执行者自测写成独立审查通过。
4. 不合并、不发 tag/release、不签发生产密钥、不替换正式安装；不改多设备/Tailscale/同步密钥、其他工具设置。SS 对 GitHub 只读；开发 Agent 只有在本项明确获分配和授权时才开草稿 PR，写前核对账号 xoqiu09。
5. 用合成项目、事件、仓库和测试 home。真实工具测试只配置测试项目或隔离 profile；先核实工具是否真支持项目级隔离，不假设都有 STEWARD_HOME。
6. 模型自述/停止/动画不能写已处理或四类权威记录。hub 远端操作保持只读。暂停、发消息、权限批准不属于观察接入首期。
7. 写源码后按仓库 AGENTS 验证：Go 全仓测试，状态/并发加竞态；前端测试/构建和 dist。纯设计/调研不冒称已跑产品验证，也不为文档改动重跑全部产品测试。
8. 交付做 scoped worktree-lifecycle 检查，未合并/待用户检查的工作树保留，归档和备份不按缓存删除。

## 每项固定回报

结果／改动／验证／偏离任务书的地方／需要用户决定的事／PR。

明确写设计、模拟通过、真实工具通过、正式安装、用户确认分别到哪一步；每条验收标准记“满足／不满足／无法验证”，附候选、证据、截图和未验证项。没有 PR 就写“无，本轮仅设计或调研”。

合成总体验收矩阵见 [acceptance-plan.json](../acceptance-plan.json)，其中 expected 都是目标，不是已完成的测试结果。
