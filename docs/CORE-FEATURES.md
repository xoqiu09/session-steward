# 核心功能进度接入

首页与工作项详情共用项目功能清单。一个功能可关联多个工作项/执行记录；按项目和稳定功能 ID 计一次。每项分别展示实现、验证、卡点、下一步负责人、候选和来源。

## Agent 使用

先保持已有工作项归属；确实换了任务才使用原有 begin，不能为了功能进度重复建任务。已有会话按它自然工作的阶段更新，无需用户逐条维护，也不要为补进度重跑测试。

```sh
~/.steward/bin/steward-hook features --list --provider claude --session '<当前会话ID>'
~/.steward/bin/steward-hook features --file /absolute/path/features.json --provider claude --session '<当前会话ID>'
```

第一次按本项目已授权的目标/规格登记少量稳定核心功能。已有功能复用 ID 和名称；后续文件可以仅含变化的功能。功能名/范围不会被后来的回报静默重命名或删除。

```json
{
  "scope_status": "documented",
  "scope_basis": "已有需求或验收标准的路径/章节；推断范围用 proposed",
  "features": [{
    "id": "bulk-export",
    "title": "批量导出",
    "acceptance": "大文件也能导出完整数据",
    "candidate": "synthetic-repo@full-commit-sha",
    "implementation": "implemented",
    "validation": "validating",
    "evidence": "小文件用例通过，大文件尚未验证",
    "blocker": "大文件样本尚未生成",
    "next": "补齐样本并检查内存与完整性",
    "next_owner": "agent"
  }]
}
```

- 实现：`unknown / not_started / implementing / implemented`。
- 验证：`unknown / not_verified / validating / passed / failed`。
- 下一步负责人：`unknown / agent / claude / codex / user / external`；指定模型但未指定会话会照实显示。
- 已实现或验证结果必须附候选版本，通过必须有依据。候选应使用实际仓库提交及必要的未提交范围标记，不能只写“最新”。
- 只负责验证的会话可以省略 implementation，避免替实现者改状态。每条更新必须带自己的候选，候选变化后原实现/验证状态重置；新版本需要重新回报。blocker/next/next_owner 省略表示保留，空字符串可清除 blocker/next。
- 内容是 Agent 自述，**不是独立校验**。首页明确标为“Agent 报验证通过”；本版没有自动执行项目检查，不会调用实网、签名、交易、安装 SDK 或授予权限。
- 仅有 proposed 范围时不显示比例；用户可在来源抽屉确认有歧义的功能范围。已明确规格可由 Agent 以 documented 登记，仍标注是 Agent 依据规格登记，不伪造用户确认。

## 一致性和验收

事件只追加、按事件 ID 去重；按发生时间归属当时的 Run/WorkItem，旧事件不能串入新任务。各会话的卡点和下一步独立保存；相同候选的一条失败不会被另一会话“通过”抹去，验证会话结束也不自动抹去失败。并行候选不同显示待对齐，不拼出完成。

实现/验证字段分别保存时间。Stop、空闲、无活动和交付不改变功能完成度。旧候选的验收不能带入新候选；新出现失败时验收标记失效。历史执行与证据可在来源中查看。

用户验收、范围确认使用面板独立接口和当前 revision；采集凭据不能调用它们。Agent 事件不接受“accepted”实现状态；验收操作绑定功能、候选、范围，遇到版本或回报变化会拒绝旧按钮。用户验收不等于合并或部署，也不自动验收整个项目。

功能回报中的 next_owner=user 在 Agent 回报新的负责人后关闭，不能仅凭同一聊天又收到一条消息就视为决定已回答：接入通知可能与原问题无关，更不代表批准 SDK 或实网权限。旧简报的回应提示保留原有语义，不授予权限。

新启动/下一次自然输入时，已有 hooks 的上下文说明会升级到功能回报格式。同一会话每个说明版本只提醒一次，启动恢复可以重发。接入说明只是提示：不等于已经收到真实回报，更不等于 Agent 会持续回报。

## 验证和发布边界

自动验证包含：事件校验与去重、乱序归属、原子写入、同功能多会话、失败保留、候选变化、明确用户验收、范围确认、面板鉴权、CLI → HTTP → SQLite → 快照、前端输出与构建。

功能数据只来自各项目的执行 Agent 和实际证据，保存在本机运行库；不要把 token、SQLite、其他项目的真实摘要或对话提交进仓库。升级服务前备份运行库与二进制，并确认没有等待中的工具审批。
