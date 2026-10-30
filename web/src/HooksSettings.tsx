import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type HookCoverage } from './api'
import { ErrorLine } from './bits'
import './projects.css'

/** 只读采集设置。沿用项目管理的原生对话框与排版，不在网页里写客户端配置。 */
export function HooksSettings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [coverage, setCoverage] = useState<HookCoverage[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const request = ++generation.current
    setBusy(true)
    try {
      const data = await api.hookCoverage()
      if (generation.current === request) { setCoverage(data); setError('') }
    } catch {
      if (generation.current === request) { setCoverage(null); setError('采集设置暂时无法读取，请稍后刷新。') }
    } finally { if (generation.current === request) setBusy(false) }
  }, [])
  useEffect(() => {
    dialog.current?.showModal()
    void load()
    return () => { ++generation.current }
  }, [load])
  return <dialog className="project-manager hooks-settings" ref={dialog} aria-label="设置" onCancel={onClose} onClose={onClose}>
    <div className="pm-heading"><div><span className="pm-eyebrow">这台电脑</span><h1>采集设置</h1><p>查看 Claude Code 和 Codex 的事件接入情况。</p></div><button className="btn" onClick={onClose} autoFocus>关闭</button></div>
    <ErrorLine msg={error} />
    <div className="row wrap"><h2>会话事件</h2><button className="btn small" onClick={() => void load()} disabled={busy}>{busy ? '正在检查…' : '刷新'}</button></div>
    {coverage?.map(row => <HooksCoverage key={row.provider} row={row} />)}
    {coverage?.length === 0 && <p className="hint">当前服务未提供事件覆盖信息。</p>}
    <p className="hint">版本检测缓存一分钟。这里只查看状态；重新安装会补齐事件并更新 Steward 的运行设置，其他工具的设置保持原样。</p>
  </dialog>
}

export function HooksCoverage({ row }: { row: HookCoverage }) {
  const name = row.provider === 'claude' ? 'Claude Code' : 'Codex'
  return <section aria-label={`${name} 事件接入`}>
    <h3>{name}{row.version ? ` · ${row.version}` : ' · 版本待核对'}</h3>
    <p>已接入 {row.installed.length} 种事件。</p>
    {row.missing.length > 0 ? <div className="warn-box" role="status"><strong>hooks 有更新，重新运行 steward install 即可</strong><p>还未接入：{row.missing.join('、')}</p><code>steward install {row.provider}</code></div>
      : row.version && !row.read_error && <p className="hint">当前已核实支持的事件均已接入。</p>}
    {row.skipped.length > 0 && <p className="hint">此版本未核实支持，暂不新增：{row.skipped.join('、')}</p>}
    {row.reason && <p className="hint">{row.reason}</p>}
  </section>
}
