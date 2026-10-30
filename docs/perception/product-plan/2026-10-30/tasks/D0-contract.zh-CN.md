# D0：共用契约与兼容设计

状态：可先设计；独立审查后冻结，当前没有实现授权。
分支建议：`docs/perception-contract`。执行时从最新 main 创建独立 worktree；当前没有创建该分支。
共用约束：[索引与回报格式](README.zh-CN.md)；[契约提案](../architecture-addendum.zh-CN.md)。

## 目标

把身份、信号语义、能力和处理入口统一，后续任务只消费同一契约。

## 范围与复用

- 以 architecture-addendum.zh-CN.md 为提案，核对现有 provider、host_id 和会话主键；`execution_tool` 只是 provider 的文档语义，不新增列或修改唯一键。新增 provider 用 `workbuddy/deepseek_harness` 等工具 ID，旧值不改；模型厂商/名称新增记录待用户 U03 授权。
- 明确 `ResolveSession` 的 other 兼容分支：原生 ID 查询（当前 ingest.go:389）空值/other 不加 provider 条件；目录候选选择（:415）空值/other 匹配任意 provider。旧路径保留，新工具必须传认证上下文的明确非空工具 ID，在两处都走精确匹配；冲突拒绝，不借 other 猜到其他工具。
- 定义自动观察、Agent 回报、程序核实、用户操作与模型解释的权限来源；来源不能由调用者任意升级。
- 定义项目稳定键、工具/模型信息、时间依据、幂等标识、能力状态和受控 action ID；标明本机字段、可同步字段、未知与默认值。
- 区分 PR 关联与候选检查：允许 PR head 是本地分支祖先时建立关联并显示落后提交数，checks 仍绑精确 PR head；合并仍核 current head/base/merge commit/目标包含，不清除本地更新候选的未合并提醒。既非相同也非祖先则不关联，详见索引 P2 补充。
- 用合成样例说明同原生 ID 的两个工具、两台设备、换模型、旧设备无字段、缺原生 ID 的桥接会话；输出冻结契约版本及变更流程。

## 本机控制契约（设计，未实现）

按[共用契约第 6 节](../architecture-addendum.zh-CN.md#6-仅控制执行设备的本机控制提案)定义独立动作契约。执行设备仅 Mac Studio 本机，不借 hub 控制其他设备；未来控制状态统一进 managed_sessions/managed_audit/ReconcileManaged，不复制任务或控制状态机。PR #42 仅是待核对的外部原型输入，I0 必须按精确候选分别验证 S22～S26。

凭据须独立、按设备可撤销，start/input/interrupt/stop/resume/approve 逐项授权，approve 默认关闭且等待用户 U06；不得复用 remote.token、面板/只读 cookie 或 hub 密钥。原 remoteBlocked 不变，`/api/managed*` 与 conversation 即使 GET 仍拒绝，普通远端仍只读；未来新增 path/listener/router 须独立鉴权，真实手机网络待 U07。

原生 CLI 恢复与官方桌面 App 接手是两项能力，都须核原 Session ID 与历史，禁止 --last；打开 App 或带摘要新开聊天不算接手。并发启动幂等、输入所有权、陈旧批准与重启处理按 S22～S26；不能验证 App 接手时，是否接受仅 CLI 恢复由用户决定。Ekko 先固定仓库/提交/许可与署名复用清单，用户 U08 未确认前不复制未知或不兼容许可代码。

## 不做

不改事件/数据库/快照类型，不承诺尚无依据的返回 URI，不扩大采集。

## 验收标准

1. 现有三元组与 provider 旧值保留，不新增 execution_tool 列；新工具精确 ID 在两处 other 分支均隔离，换模型不创建会话，未授权不新增模型记录。
2. 所有权限写入者有表，模型/桥接不能写用户处理、合并或安装/运行事实。
3. 能力验证与连接健康分开；未知不等于不支持，模拟不等于真实已验证。
4. A0/W1/W2/P6 可以用同一组合成契约独立工作，不需猜公共字段。
5. 观察桥接与本机控制授权分开；本机范围、逐动作独立凭据、默认关闭审批、唯一托管登记、remoteBlocked 不变、CLI/App 分开验证均有明确契约与 S22～S26 owner，仍标未实现。

## 验证

只做设计一致性、样例与兼容映射检查；不声称 Go/真实工具测试通过。 每条标准写满足/不满足/无法验证；模拟 expected 不得填成真实已通过。

## 交付

建议入库 docs/perception/contracts/；冻结版本需主线程与独立审查者确认。 按共同六段格式回报，附精确候选、证据和未验证项；没有 PR 则明确仅设计/调研。用户确认与执行者自测分开。
