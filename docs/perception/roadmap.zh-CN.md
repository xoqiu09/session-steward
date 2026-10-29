# 分期与分工

设计见 [architecture.zh-CN.md](architecture.zh-CN.md)。每一项对应 `tasks/` 下的一份任务书；任务书写到可以直接交给执行 Agent 的程度。后面几期的任务书等前一期合并后再写，因为前面的实现可能改变后面的设计。

## 分工

| 角色 | 负责 |
| --- | --- |
| 用户 | 决定设计里的“待决定”；合并 PR；验收；发布、签名密钥、替换正式安装 |
| Claude（MacBook Pro） | 写设计和任务书；审查每个 PR 是否符合任务书的验收标准；在这台电脑上验证 Claude Code 相关的采集（Claude Code 跑在这台）；写多设备联调步骤 |
| Codex（Mac Studio） | 按任务书实现、测试、开草稿 PR，按固定格式回报 |

一条规则：执行 Agent 不审查自己的 PR，审查 Agent 不直接改执行中的分支。审查意见写在 PR 评论里，由执行 Agent 修改。

## 第 0 期：收尾

| 任务 | 内容 | 执行 | 状态 |
| --- | --- | --- | --- |
| [T0](tasks/T0-integrate-in-app-update.zh-CN.md) | 把 PR #33（内置升级）整合到最新 main，重新验证 | Codex | 待开始 |

## 第 1 期：地基

| 任务 | 内容 | 执行 | 依赖 |
| --- | --- | --- | --- |
| [P1](tasks/P1-signal-provenance.zh-CN.md) | 每个信号带来源和时间；快照给出“最近信号”和“信息缺口” | Codex | 无 |
| [P2](tasks/P2-github-pr-awareness.zh-CN.md) | 工作项关联 PR；网页上合并后自动更新并收起提醒；显示 PR 检查结果 | Codex | P1 |
| [P3](tasks/P3-claude-hooks-coverage.zh-CN.md) | 补装选定的 Claude hooks；不需要回应的改成异步 | Codex 实现，Claude 在 MacBook 上验证 | 设计“待决定”第 3 条 |

## 第 2 期：补漏

| 任务 | 内容 | 执行 | 依赖 |
| --- | --- | --- | --- |
| P4 | 会话记录增量读取：记住读到哪里，只取结构化字段，和 hook 去重 | Codex | P1 |
| P5 | 非托管会话存活核对：Claude 用进程记录加进程列表；Codex 先调研 | Codex | P1 |

## 第 3 期：解释

| 任务 | 内容 | 执行 | 依赖 |
| --- | --- | --- | --- |
| P6 | SS 侧：给小猫的只读事实接口、写入“解释”的接口、面板上的“小猫的看法”一栏 | Codex | P1、设计“待决定”第 1 条 |
| P6b | 小猫侧：改用新接口，输出结构化的解释（在小猫仓库里做） | Codex | P6 |

## 第 4 期：交付链路

| 任务 | 内容 | 执行 | 依赖 |
| --- | --- | --- | --- |
| P7 | 安装和运行验证记录：每台电脑运行的版本是否包含某个工作的合并提交；升级后的健康检查结果 | Codex | T0、P2 |

## 暂不做

Computer History、飞书个人消息、屏幕观察。原因见设计文档的“不做的事”。

## 每一项怎么跑

1. 用户把任务书路径交给 Codex，提示词见 [tasks/README.zh-CN.md](tasks/README.zh-CN.md)。
2. Codex 从最新 main 开分支，实现，开**草稿** PR，按格式回报。
3. Claude 对照任务书审查，意见写在 PR 评论里；涉及 Claude Code 的部分在 MacBook 上实测。
4. 审查通过后，用户决定是否合并。合并后，两台电脑按发布说明更新。
5. 本表的“状态”一栏由审查的人更新。
