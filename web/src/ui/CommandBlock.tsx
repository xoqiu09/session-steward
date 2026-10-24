import { CopyButton } from '../bits'
import { StatusChip } from './StatusChip'
import type { CommandEntry } from './runDeskModel'

// 命令与结果成对展示。没有退出码的命令一律标“无执行证据”。
export function CommandBlock({ c }: { c: CommandEntry }) {
  const hasResult = typeof c.exitCode === 'number' && Number.isFinite(c.exitCode)
  return (
    <li className={`rd-cmd ${hasResult ? 'has-result' : ''}`}>
      <div className="rd-cmd-head">
        <StatusChip state={c.state} label={hasResult ? c.exitCode === 0 ? '检查成功' : '检查失败' : undefined} />
        <span className="rd-cmd-evidence">{c.evidence}</span>
        {hasResult && <span className="rd-cmd-meta">退出码 {c.exitCode} · {c.seconds?.toFixed(1)}s</span>}
        {c.copyable && <CopyButton text={c.text} label="复制" />}
      </div>
      <pre className="rd-cmd-text"><code>{c.text}</code></pre>
      {c.tail && <details className="rd-cmd-tail" open={c.state === 'failed'}>
        <summary>输出末尾</summary>
        <pre>{c.tail}</pre>
      </details>}
    </li>
  )
}
