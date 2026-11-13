# K3：MacBook 配对与派活

状态：待做，等 K1 合入。
分支：`feat/dispatch-desk-macbook`。

## 目标

在 MacBook 的小镇里打开派活台，给 Mac Studio 派活、批准、停止、交给电脑，和在 Studio 本机一样。按 U06：MacBook 可以允许；密钥不过期，只能在 Studio 上手动收回。按 U07：走 Tailscale 的 8444。

## 范围

- **Studio 侧。** `steward serve` 在 `127.0.0.1:7790` 开一个只挂派活路由的监听（配置项默认关）；配对码、设备表、按动作权限、收回；请求检查按设计第 5 节（Tailscale 身份头与配对时一致、拒绝 Funnel、密钥哈希、权限、租约、指纹、Host）。
- **MacBook 侧。** 本机服务的 `/api/dispatch/*` 带着 `~/.steward/dispatch.key` 去请求 Studio；浏览器拿不到密钥。配置里只写 Studio 的派活地址。
- **前端。** 同一个派活台页面；页头写“任务在 Mac Studio 上执行 · MacBook 正在控制”；“接过来”切换控制者；Studio 片区里点派活台发起的房子直接进对应任务。
- **说明。** `docs/GUIDE.zh-CN.md` 增加一段：用户在 Studio 上执行 `tailscale serve --bg --https=8444 http://127.0.0.1:7790`，怎么配对、怎么收回。

## 不做

- 不替用户执行 `tailscale serve`，不开 Funnel，不改 8443 和 hub 推送。
- 派活密钥不复用 hub 密钥、`remote.token` 或面板 cookie。
- MacBook 上不执行任务；Studio 不控制 MacBook。
- 不做手机、微信。

## 验收标准

1. 无密钥、错密钥、已收回的密钥、缺少或不一致的 Tailscale 身份头、带 Funnel 标记、错 Host，全部拒绝并写审计。
2. 配对码一次性、10 分钟过期；Studio 只存哈希。
3. MacBook 能派活、停止、恢复、允许、拒绝；两台同时决定同一审批，后到的 409。
4. 收回后 MacBook 下一次请求立即失败，执行中的本轮不被停掉。
5. MacBook 合盖或断网后任务继续；重新连上看到“你离开期间”的提示。
6. 命令正文只在显示时取，不进 MacBook 数据库、审计、hub 摘要、通知。
7. 8443、hub 推送、普通远程只读的原有测试全部保留并通过。

## 验证

合成测试覆盖 1～4、6、7；`-race` 覆盖租约切换。真实点验需要用户在 Studio 上配好 8444，两台各用临时 STEWARD_HOME 的测试实例跑 3～5，不碰正式安装。

## 交付

草稿 PR，中文说明；写清哪些在两台真机上验过，哪些只是合成测试。
