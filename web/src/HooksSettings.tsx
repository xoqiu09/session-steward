import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type HookCoverage } from './api'
import { ErrorLine } from './bits'
import { useNativeDialog } from './ui/useNativeDialog'
import './projects.css'

/** 只读采集设置。沿用项目管理的原生对话框与排版，不在网页里写客户端配置。 */
export function HooksSettings({ onClose }: { onClose: () => void }) {
  const dialog = useNativeDialog(onClose)
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
    void load()
    return () => { ++generation.current }
  }, [load])
  return <dialog className="project-manager hooks-settings" {...dialog} role="dialog" aria-modal="true" aria-label="设置">
    <div className="pm-heading"><div><span className="pm-eyebrow">这台电脑</span><h1>采集设置</h1><p>查看 Claude Code 和 Codex 的事件接入情况。</p></div><button className="btn" onClick={onClose} autoFocus>关闭</button></div>
    <ErrorLine msg={error} />
    <div className="row wrap"><h2>会话事件</h2><button className="btn small" onClick={() => void load()} disabled={busy}>{busy ? '正在检查…' : '刷新'}</button></div>
    {coverage?.map(row => <HooksCoverage key={row.provider} row={row} />)}
    {coverage?.length === 0 && <p className="hint">当前服务未提供事件覆盖信息。</p>}
    <p className="hint">版本检测缓存一分钟。这里只查看状态；重新安装会补齐事件并更新 Steward 的运行设置，其他工具的设置保持原样。</p>
    {coverage?.some(row => row.provider === 'codex' && (row.untrusted ?? 0) > 0) && <p className="warn-box" role="status">Codex 里还有 {coverage.find(row => row.provider === 'codex')?.untrusted} 个 Steward 的 hooks 没有信任记录：打开 Codex，按它的提示信任新加的 hooks。这里只能看到“有没有记录”，以 Codex 的提示为准。</p>}
    <PrivacyNotes />
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

/** SS 记录什么、不记录什么。内容与 README“隐私与安全”、使用手册“安全与隐私”一致，不在这里增加新的承诺。 */
export function PrivacyNotes() {
  return <section className="privacy-notes" aria-label="SS 记录了什么">
    <h2>SS 记录了什么</h2>
    <ul>
      <li><b>记录：</b>脱敏后的事件元数据——事件类型、工具名、指纹、截断并遮蔽密钥的预览；Agent 主动回报的进展、交付和功能状态；你在面板里的决定和验收。</li>
      <li><b>不记录：</b>原始载荷和完整对话。例外：最后一条回复以问句结尾时保存末尾约 200 字，作为“疑似需要关注”的上下文；Agent 用 ask、deliver 回报的文字截断并脱敏后保存；打开 <code>keep_summary</code> 才会保存提问和回复的截断摘要（默认关闭）。冷启动只读 Claude Code / Codex 会话文件开头的元数据。</li>
      <li><b>放在哪里：</b>只在这台电脑的 <code>~/.steward</code>，没有 SS 账号，没有遥测。</li>
      <li><b>什么时候联网：</b>只有你配置了才会：Git 远端核对合并、<code>ntfy_url</code>、<code>summary_command</code>、远程查看或多设备同步；Claude Code / Codex 本身照常联网。</li>
    </ul>
    <p className="hint">从面板启动托管会话需要本机有 tmux 并配置了 Agent；没有时不显示“新建会话”。派活台需要本机找到 Codex，没有时小镇里不画派活台。</p>
  </section>
}

