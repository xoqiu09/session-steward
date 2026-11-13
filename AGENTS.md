# Session Steward development notes

Guidance for humans and coding agents working on this repository.

- Keep WorkItem, Session, Run and Approval separate. A `Stop` is not task completion; a delivered decision is not a successful execution. Older events must never overwrite newer progress or leak into a different work item.
- Only the user can mark work as accepted. Agent reports, test results and user acceptance are recorded separately.
- Use synthetic data in tests and demos. Never commit tokens, SQLite files, conversation text or real project content.
- `steward install` must only touch its own hook entries; other tools' hooks and trust settings stay as they are.
- Verify Go changes with `go test ./...`, and `go test -race ./...` for state machine or concurrency changes. Verify frontend changes with `npm test` and `npm run build` in `web/`, and commit the rebuilt `web/dist`.

## Perception (how Steward learns what is happening)

Design: `docs/perception/architecture.zh-CN.md`. Read it before touching collectors, verifiers, the hub summary or anything a model writes.

- Facts, observations and interpretations are different layers. Facts are re-checkable by a program (Git ancestry, a verified PR merge, a live process). Observations are collected signals that may be late, duplicated or out of order. Interpretations come from a model; they are shown as proposals and never change WorkItem, Session, Run or Approval state.
- Every signal records its channel (`hook`, `transcript`, `process`, `git`, `github`, `hub`, `model`, `user`), device, occurred time, received time and a reference that lets it be re-checked. Model output also records the model name and the signals it was based on.
- Four completion records stay separate and have fixed writers: user acceptance (only the user), code merged (only the merge verifier), installed on a device (only a verifier comparing the running build with the merge commit), runtime verified (a verifier or the user). Agent reports, passing tests and model judgements are evidence, never one of these records.
- No new signal means an information gap. Show how long it has been; do not call it stuck, failed or done.
- Collect on the device where the work happens. The hub (Mac Studio) only receives summaries and never reaches into another device's files or processes. Summaries never carry conversation text, commands, tool previews, paths, resume commands or approval content.
- Session files are read for structured fields only (times, event types, tool names, tool_use_id, exit status, token counts). Never store or send conversation text, tool input/output or file contents.
- Do not widen what is collected (new apps, Computer History, chat inboxes, screen content) without first updating the design document and getting the user's approval.
- Steward is read-only towards GitHub. Use the user's own `gh` login; never comment, merge, label or push on their behalf.

## Working from a task book

Planned work lives in `docs/perception/roadmap.zh-CN.md`, with one task book per item in `docs/perception/tasks/`.

- Start a branch from the latest `origin/main` using the branch name in the task book. Do not rebase or force-push a branch someone else has already pushed; merge `main` into it instead.
- Stay inside the task book's scope and "不做" list. If the design turns out to be wrong, stop and describe the problem in the report instead of quietly changing direction.
- Open a draft PR, write commit messages and PR text in Chinese, and reply with the report format in `docs/perception/tasks/README.zh-CN.md`, including what was not verified and why.
- Never merge PRs, create tags or releases, generate or install production signing keys, or replace the real installation on any device. Before any GitHub write, check that `gh api user` returns `xoqiu09`.
- Leave existing multi-device, Tailscale, secret, database and other tools' hook settings as they are.
