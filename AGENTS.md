# Session Steward development notes

Guidance for humans and coding agents working on this repository.

- Keep WorkItem, Session, Run and Approval separate. A `Stop` is not task completion; a delivered decision is not a successful execution. Older events must never overwrite newer progress or leak into a different work item.
- Only the user can mark work as accepted. Agent reports, test results and user acceptance are recorded separately.
- Use synthetic data in tests and demos. Never commit tokens, SQLite files, conversation text or real project content.
- `steward install` must only touch its own hook entries; other tools' hooks and trust settings stay as they are.
- Verify Go changes with `go test ./...`, and `go test -race ./...` for state machine or concurrency changes. Verify frontend changes with `npm test` and `npm run build` in `web/`, and commit the rebuilt `web/dist`.
