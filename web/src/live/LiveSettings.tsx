// 正常 SS 里的直播入口：编辑展示说明、复制展示地址、打开展示视图。只在本机面板出现。
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { LIVE_VIEW_HREF } from '../town/route'
import './liveSettings.css'

export const LIVE_NOTE_MAX = 80

const FIELDS = [
  { key: 'doing', label: '正在', placeholder: '例如：给小镇加直播画面' },
  { key: 'thinking', label: '最近思考', placeholder: '例如：怎么让观众一眼看懂' },
  { key: 'contact', label: '交流方式', placeholder: '例如：留言，休息时统一回复' },
] as const
type Key = (typeof FIELDS)[number]['key']

/** 字数按字符算（与服务端一致），超出时给出提示。 */
export function noteProblem(text: string): string {
  const n = Array.from(text.trim()).length
  return n > LIVE_NOTE_MAX ? `最多 ${LIVE_NOTE_MAX} 个字，现在 ${n} 个` : /[\u0000-\u001f\u007f-\u009f]/.test(text) ? '不能包含换行' : ''
}

export function LiveSettings({ onClose }: { onClose: () => void }) {
  const [values, setValues] = useState<Record<Key, string>>({ doing: '', thinking: '', contact: '' })
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState('')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let live = true
    api.liveNote().then((n) => { if (live) { setValues({ doing: n.doing ?? '', thinking: n.thinking ?? '', contact: n.contact ?? '' }); setLoaded(true) } },
      (e) => { if (live) { setLoaded(true); setStatus(`读取说明失败：${e instanceof Error ? e.message : '未知错误'}`) } })
    first.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => { live = false; window.removeEventListener('keydown', onKey) }
  }, [])
  const problems = Object.fromEntries(FIELDS.map((f) => [f.key, noteProblem(values[f.key])])) as Record<Key, string>
  const invalid = FIELDS.some((f) => problems[f.key])
  const save = async () => {
    if (invalid) return
    setBusy(true); setStatus('')
    try { await api.saveLiveNote(values); setStatus('已保存，展示画面约 10 秒内更新。') }
    catch (e) { setStatus(`没有保存成功：${e instanceof Error ? e.message : '未知错误'}`) }
    finally { setBusy(false) }
  }
  const copy = async () => {
    setStatus('')
    try {
      const { url } = await api.liveLink()
      setLink(url)
      try { await navigator.clipboard.writeText(url); setStatus('展示地址已复制。地址里含展示令牌，只粘到 OBS，不要发给别人。') }
      catch { setStatus('浏览器没有允许复制，请手动复制下面的地址。') }
    } catch (e) { setStatus(`取地址失败：${e instanceof Error ? e.message : '未知错误'}`) }
  }
  return (
    <div className="live-settings-scrim" onClick={onClose}>
      <div className="live-settings" role="dialog" aria-modal="true" aria-label="直播展示" onClick={(e) => e.stopPropagation()}>
        <h2>直播展示</h2>
        <p className="muted">展示画面只显示“项目 A”这类通用名和数量，不显示项目名、路径、标题和审批。下面三行会显示在画面上方，留空的那行不显示。</p>
        {FIELDS.map((f, i) => (
          <label key={f.key} className="live-settings-field">
            <span>{f.label}</span>
            <input ref={i === 0 ? first : undefined} value={values[f.key]} placeholder={f.placeholder} disabled={!loaded}
              aria-invalid={!!problems[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            <small className={problems[f.key] ? 'is-error' : 'muted'}>{problems[f.key] || `${Array.from(values[f.key].trim()).length}/${LIVE_NOTE_MAX}`}</small>
          </label>
        ))}
        {status && <p className="live-settings-status" role="status">{status}</p>}
        {link && <input className="live-settings-link" readOnly value={link} aria-label="展示地址" onFocus={(e) => e.currentTarget.select()} />}
        <div className="live-settings-actions">
          <button className="btn small primary" disabled={!loaded || busy || invalid} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
          <button className="btn small" onClick={() => void copy()}>复制展示地址</button>
          <button className="btn small" onClick={() => window.open(LIVE_VIEW_HREF, '_blank', 'noopener')}>打开展示视图</button>
          <button className="btn small" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
