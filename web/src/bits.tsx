import { useState } from 'react'
import { providerLabel } from './model'

export function AgentBadge({ provider, client }: { provider: string; client?: string }) {
  const c = client && client !== 'unknown' ? (client === 'desktop' ? '桌面' : client === 'cli' ? 'CLI' : client) : ''
  return (
    <span className={`agent agent-${provider}`} title={`${providerLabel(provider)}${c ? ' · ' + c : ''}`}>
      {providerLabel(provider)}
      {c && <small> · {c}</small>}
    </span>
  )
}

export function CopyButton({ text, label = '复制', onCopied }: { text: string | (() => Promise<string>); label?: string; onCopied?: () => void }) {
  const [done, setDone] = useState(false)
  const [err, setErr] = useState('')
  return (
    <button
      className="btn small"
      onClick={async () => {
        try {
          const t = typeof text === 'string' ? text : await text()
          await navigator.clipboard.writeText(t)
          setDone(true)
          setErr('')
          onCopied?.()
          setTimeout(() => setDone(false), 1500)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }}
      title={err || undefined}
    >
      {err ? '失败' : done ? '已复制' : label}
    </button>
  )
}

// useAction 包装一次异步操作，统一处理进行中状态与错误提示。
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run, setError }
}

export function ErrorLine({ msg }: { msg: string }) {
  return msg ? <div className="err" role="alert">{msg}</div> : null
}
