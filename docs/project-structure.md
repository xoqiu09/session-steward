# 项目结构资料与小镇房间

每个项目共用四个阅读入口：项目概况、功能地图、当前推进、验证依据。
目录来自项目自己的结构资料；任务、实现、验证和用户验收继续读取现有记录。
没有资料时显示“尚未整理”，不从项目名、目录名或功能标题猜测分类。

## 为一个项目整理

进入项目房间，展开“整理项目”，可以填写目标、受众、范围，添加用途分组、修改名称及选择功能归属。
已有 Agent 时，复制“给 Agent 的整理说明”，让当前开发 Agent 根据已有项目文档和必要源码提出结构。
SS 不因此启动新会话、后台扫描源码、调用模型、执行文档指令或访问外部地址。

Agent 先读取当前会话所属项目的登记和结构：

```sh
steward-hook features --list --provider codex --session SESSION
steward-hook structure --list --provider codex --session SESSION
```

`structure --list` 返回 `{"structure":null}` 或带 `document`、`revision`、`author` 和 `updated_at` 的记录。
使用已有功能 ID，每个功能仅有一个主用途；遗漏的登记仍出现在“待分类功能”。
功能尚未登记不等于项目未开发。结构中可以保留未关联功能的用途，并注明范围仍需核对。

新结构用 `structure --file 项目结构.json` 回报。更新必须带上刚读取的
`--base-revision REVISION`；命令支持 `--file -` 从标准输入读取。
项目由当前会话已关联的 WorkItem 确定，不能传入任意 repo_id 改其他项目。
失败或结果不明时不自动重试，先读回结构核对。

手工调整过的目录标记为“用户整理”，Agent 写入会被拒绝。新的 Agent 建议可由用户在面板导入预览后保存。
导入与编辑只有点击“保存目录”才写入；文件选择本身只读取用户选中的文件。
“导出当前草稿”提供可复制的 JSON，不包含会话、任务、凭据或业务工作记录。

## 可移植格式 v1

```json
{
  "schema_version": 1,
  "goal": "把合成资料整理为可交付的结果",
  "audience": "合成示例用户",
  "scope": "只描述项目功能，不声明开发完成或实际运行",
  "prepared_at": "2026-11-03",
  "basis_version": "synthetic-source-version",
  "groups": [
    {"id":"input","title":"收集资料","question":"资料从哪里来？","features":[{"id":"import","label":"导入资料"}]},
    {"id":"output","title":"交付结果","question":"结果怎么交付？","features":[{"id":"export","label":"导出结果"}]}
  ],
  "relations": [{"from":"input","to":"output","label":"收集的资料用于生成结果"}],
  "sources": [{"path":"docs/overview.md","line_start":1,"line_end":12,"kind":"documentation","note":"合成说明依据"}]
}
```

`groups[].note` 可补充用途范围。依据类别为 `documentation` 或 `source`；行号可省略。
依据只展示仓库相对路径，不提供任意文件读取、可执行链接或外网请求。
最多 64 KiB、12 类用途、200 项功能映射、32 条关系、24 项依据。
未知字段、重复功能、无效关系、越界路径和未在本项目登记的功能 ID 会被拒绝。

资料中的日期与版本是整理依据，不是自动追踪结果；代码变化后由项目负责 Agent 按需更新。
不要求为每次任务重新整理整张目录，手工修正不会被普通功能回报覆盖。

## 兼容与权限

- 使用现有 SQLite `meta` 保存按项目 ID 绑定的结构及旧修订；没有新增数据库表或迁移。
- 面板 `GET/PUT /api/projects/{repo}/structure` 沿用面板鉴权、同源/CSRF 和远程只读边界。
- Hook `POST /hook/structure/read|write` 沿用 ingest 凭据，并要求当前会话已关联明确项目工作项。
- 写入需比较准确修订，防止迟到或并发更新覆盖。面板导入可用 envelope 的 `origin:"agent"` 标记 Agent 建议；默认保存标为用户整理。Hook 不接受来源覆盖。人工整理与 Agent 建议只说明资料来源，不代表业务验收。
- 结构不写 WorkItem、Session、Run、Approval、功能定义、功能回报、编排或验收记录。
- 改名不影响目录；同一项目已验证的路径别名归并会保留结构，两份竞争结构会阻止自动归并。
- 归档、回收站保留结构；恢复后重新显示。历史回放不混入当前结构。
- 全部设备视图保留本机资料；现有设备摘要不增加结构或私有项目内容的自动共享。其他设备须在其所属设备整理。
- 工具栏“结构说明”保留明确标注的 SS 教学样本；房间同名入口展示所属项目资料；窄屏分页视图先点选项目，再从“结构说明”阅读该项目。

其他用户只需提供项目自己的结构资料，共用这套展示，不需要修改或重新编译 SS。
