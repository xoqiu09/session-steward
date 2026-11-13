# T0：把内置升级（PR #33）整合到最新 main

- 执行：Codex（Mac Studio）
- 分支：沿用 `feat/in-app-update-20261029`，把最新 `origin/main` **合并**进来（不要 rebase，不要强推）
- PR：https://github.com/xoqiu09/session-steward/pull/33，保持草稿

## 目标

PR #33 基于 `cefeaf9`，main 之后又进来了 12 个提交，其中包括 #32（通知闭环、可读画布、项目回收站）。现在有三处冲突。目标是解决冲突，同时保留两边的功能，并在新的基线上重新验证升级的全部链路。

## 背景：三处冲突各是什么

| 文件 | main 这边（#32） | PR #33 这边 | 处理原则 |
| --- | --- | --- | --- |
| `native/app/Info.plist` | 新增 `CFBundleURLTypes`，注册 `session-steward://`，通知点开后靠它跳回 SS | 改了网络说明注释 | 两边都保留 |
| `scripts/build-app.sh` | Swift 编译加了 `native/shared/*.swift`，以及 `SwiftUI`、`QuartzCore` 框架 | 版本号和构建序号改从 `update-version.json` 读取；注入公钥；构建 `steward-updater`；用 PlistBuddy 写版本和 schema | 两边都保留。Swift 源文件列表要同时包含 `native/shared/*.swift`、`native/app/*.swift`（里面已经有新增的 `Paths.swift`、`Updates.swift`）；`steward-updater` 也要签名 |
| `native/app/main.swift` | 改了约 130 行：通知回到原会话、顶部提醒、回到前台刷新 | 改了约 57 行：路径和数据目录改走 `Paths.swift`；加了更新菜单 | 逐段合并，不能丢掉任何一边的行为 |

## 范围

1. 合并 main，解决三处冲突。顺带检查自动合并的文件有没有语义冲突，重点看 `release.yml`、`release.sh`、`build-notifier.sh`，以及通知助手的打包位置。
2. 确认升级流程覆盖 #32 带来的新东西：
   - 替换 App 以后，`session-steward://` 链接仍然能打开新版 App（LaunchServices 重新登记）。
   - 通知助手按 #32 之后的新位置和新标识，能正确停止、替换并重新启动。
   - 失败恢复后，旧版的通知和链接仍然可用。
3. 在新基线上重跑全部验证，并更新 `docs/in-app-update.zh-CN.md` 里过时的描述（例如开头的“尚未推送”）。

## 不做

- 不生成或接入生产签名密钥，不配置 GitHub secrets。
- 不打标签，不建 Release，不发布。
- 不替换 Mac Studio 或 MacBook Pro 上的正式安装，也不连接真实的 `~/.steward` 做测试。
- 不改升级协议本身（清单格式、签名方式、事务记录）。如果发现协议有问题，写在回报的“需要用户决定的事”里。

## 设计约束

- 遵守 AGENTS.md。测试只用合成数据和随机生成的测试密钥。
- 隔离测试沿用 `scripts/test-app-update.sh` 的做法：独立 bundle identifier、独立数据目录、独立 LaunchAgent 标签，测试完删除。
- 合并提交的说明用中文。

## 验收标准

1. 三处冲突解决，`git diff origin/main...HEAD` 里看不到 #32 的任何功能被删掉或改回。
2. `go test ./...`、`go test -race ./...`、`go vet ./...` 全部通过。
3. `web/` 下 `npm test`、`npm run build` 通过，`web/dist` 没有漂移。
4. `scripts/build-app.sh arm64` 和 `amd64` 都能构建，嵌套代码签名校验通过。产物里 `CFBundleURLTypes`、`CFBundleShortVersionString`、`CFBundleVersion`、`StewardSchema` 都在。
5. `scripts/test-app-update.sh` 两种模式（App 自管后台、共用 launchd）的“安装成功”和“健康检查失败 → 恢复”都通过。
6. 用隔离的测试 App 实测：升级前后各发一条合成通知，点开都能打开对应的工作详情。
7. 没有生产公钥时，App 明确拒绝生产安装（这一点和原来一致）。
8. PR 描述更新为新基线上的验证结果，仍然是草稿。

## 验证命令

```sh
go test ./... && go test -race ./... && go vet ./...
(cd web && npm test && npm run build) && git diff --exit-code web/dist
sh scripts/build-app.sh arm64 && sh scripts/build-app.sh amd64
sh scripts/test-app-update.sh /完整外置Scratch路径
```

## 回报

按 [README](README.zh-CN.md) 里的回报格式。“验证”一节要分开写：哪些在本机真实跑过，哪些只是单元测试覆盖，哪些需要 Intel 电脑或正式签名之后才能验证。
