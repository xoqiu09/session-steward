// 正常 SS 里的直播入口：编辑展示说明、复制展示地址、打开展示视图。只在本机面板出现。
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type LiveStyle, type LivePresentation, type LiveGesture } from '../api'
import { LIVE_VIEW_HREF } from '../town/route'
import { LIVE_STYLES, liveStyle } from './styles'
import { livePresentation } from './companion'
import './liveSettings.css'
import { useNativeDialog } from '../ui/useNativeDialog'
import { ActionFeedback } from '../ui/ActionFeedback'

export const LIVE_NOTE_MAX = 80

const FIELDS = [
  { key: 'doing', label: '正在', placeholder: '例如：给小镇加直播画面' },
  { key: 'thinking', label: '最近思考', placeholder: '例如：怎么让观众一眼看懂' },
  { key: 'contact', label: '交流方式', placeholder: '例如：留言，休息时统一回复' },
] as const
type Key = (typeof FIELDS)[number]['key']
type Feedback = { text: string; tone: 'success' | 'warning' | 'error' }

/** 字数按字符算（与服务端一致），超出时给出提示。 */
export function noteProblem(text: string): string {
  const n = Array.from(text.trim()).length
  return n > LIVE_NOTE_MAX ? `最多 ${LIVE_NOTE_MAX} 个字，现在 ${n} 个` : /[\u0000-\u001f\u007f-\u009f]/.test(text) ? '不能包含换行' : ''
}

export function LiveSettings({ onClose }: { onClose: () => void }) {
  const [values, setValues] = useState<Record<Key, string>>({ doing: '', thinking: '', contact: '' })
  const [style, setStyle] = useState<LiveStyle>('cozy-night')
  const [presentation, setPresentation] = useState<LivePresentation>('companion')
  const [gestureBusy, setGestureBusy] = useState(false)
  const [gestureFeedback, setGestureFeedback] = useState<Feedback | null>(null)
  const [previewScale, setPreviewScale] = useState(1 / 3)
  const previewBox = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saved, setSaved] = useState('')
  const [saveFeedback, setSaveFeedback] = useState<Feedback | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<Feedback | null>(null)
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [copyBusy, setCopyBusy] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const generation = useRef(0)
  const saving = useRef(false)
  const copying = useRef(false)
  const sendingGesture = useRef(false)
  const keepEditing = useRef<HTMLButtonElement>(null)
  const closeRegion = useRef<HTMLElement>(null)
  const dirty = loaded && JSON.stringify({ ...values, style, presentation }) !== saved
  const requestClose = () => {
    if (saving.current) return
    if (confirmClose) { setConfirmClose(false); return }
    if (dirty) setConfirmClose(true)
    else onClose()
  }
  const dialog = useNativeDialog(requestClose, '[data-live-close]')
  const load = useCallback(async () => {
    const request = ++generation.current
    setLoaded(false); setLoading(true); setLoadError('')
    try {
      const note = await api.liveNote()
      if (generation.current !== request) return
      const nextValues = { doing: note.doing ?? '', thinking: note.thinking ?? '', contact: note.contact ?? '' }, nextStyle = liveStyle(note.style)
      const nextPresentation = livePresentation(note.presentation)
      setValues(nextValues); setStyle(nextStyle); setPresentation(nextPresentation)
      setSaved(JSON.stringify({ ...nextValues, style: nextStyle, presentation: nextPresentation })); setLoaded(true)
    } catch (error) {
      if (generation.current === request) setLoadError(`读取说明失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally { if (generation.current === request) setLoading(false) }
  }, [])
  useEffect(() => { void load(); return () => { ++generation.current } }, [load])
  useEffect(() => {
    const el = previewBox.current
    if (!el) return
    const measure = () => setPreviewScale(el.clientWidth / 1080)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure); ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (confirmClose) { closeRegion.current?.scrollIntoView({ block: 'nearest' }); keepEditing.current?.focus() }
  }, [confirmClose])
  const problems = Object.fromEntries(FIELDS.map((f) => [f.key, noteProblem(values[f.key])])) as Record<Key, string>
  const invalid = FIELDS.some((f) => problems[f.key])
  const save = async () => {
    if (!loaded || invalid || saving.current) return
    saving.current = true
    const request = generation.current
    const submitted = { ...values, style, presentation }
    setBusy(true); setSaveFeedback(null)
    try {
      const note = await api.saveLiveNote(submitted)
      if (generation.current === request) {
        const nextValues = { doing: note.doing ?? submitted.doing, thinking: note.thinking ?? submitted.thinking, contact: note.contact ?? submitted.contact }, nextStyle = liveStyle(note.style ?? submitted.style)
        const nextPresentation = livePresentation(note.presentation ?? submitted.presentation)
        setValues(nextValues); setStyle(nextStyle); setPresentation(nextPresentation); setSaved(JSON.stringify({ ...nextValues, style: nextStyle, presentation: nextPresentation })); setConfirmClose(false)
        setSaveFeedback({ text: '说明和画风已保存，布局已同步，展示画面约 2 秒内更新。', tone: 'success' })
      }
    }
    catch (e) { if (generation.current === request) setSaveFeedback({ text: `没有保存成功：${e instanceof Error ? e.message : '未知错误'}。草稿仍保留，可以重试。`, tone: 'error' }) }
    finally { saving.current = false; if (generation.current === request) setBusy(false) }
  }
  const copy = async () => {
    if (copying.current) return
    copying.current = true
    const request = generation.current
    setCopyBusy(true); setCopyFeedback(null)
    try {
      const { url } = await api.liveLink()
      if (generation.current !== request) return
      setLink(url)
      try { await navigator.clipboard.writeText(url); if (generation.current === request) setCopyFeedback({ text: '展示地址已复制。地址里含展示令牌，只粘到 OBS，不要发给别人。', tone: 'success' }) }
      catch { if (generation.current === request) setCopyFeedback({ text: '浏览器没有允许复制，请手动复制下面的地址。', tone: 'warning' }) }
    } catch (e) { if (generation.current === request) setCopyFeedback({ text: `取地址失败：${e instanceof Error ? e.message : '未知错误'}`, tone: 'error' }) }
    finally { copying.current = false; if (generation.current === request) setCopyBusy(false) }
  }
  const gesture = async (kind: LiveGesture) => {
    if (!loaded || sendingGesture.current) return
    sendingGesture.current = true
    const request = generation.current
    setGestureBusy(true); setGestureFeedback(null)
    const name = { pat: '摸摸', walk: '散步', home: '回家' }[kind]
    try {
      await api.liveCompanion(kind)
      if (generation.current === request) setGestureFeedback({ text: `已发送「${name}」，展示画面约 2 秒内更新。`, tone: 'success' })
    } catch (e) {
      if (generation.current === request) setGestureFeedback({ text: `动作没有发送成功：${e instanceof Error ? e.message : '未知错误'}。可以重试。`, tone: 'error' })
    } finally { sendingGesture.current = false; if (generation.current === request) setGestureBusy(false) }
  }
  const preview = `${LIVE_VIEW_HREF}&live-style=${style}&live-layout=${presentation}`
  return (
      <dialog className="live-settings" {...dialog} role="dialog" aria-modal="true" aria-label="直播展示" onClick={event => {
        if (event.target !== event.currentTarget) return
        const box = event.currentTarget.getBoundingClientRect()
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) requestClose()
      }}>
        <header className="live-studio-heading"><div><p>工作小镇 · 展示工作台</p><h2>把小镇，留给路过的人。</h2></div><span>本地预览</span></header>
        <div className="live-studio-layout">
        <div className="live-studio-controls">
        {loading && <p role="status">正在读取直播说明…</p>}
        {loadError && <div role="alert"><p>{loadError}</p><p>原说明尚未读取，暂时不能编辑或保存。</p><button className="btn small" onClick={() => void load()}>重新读取说明</button></div>}
        <fieldset className="live-layout-picker" disabled={!loaded || busy}>
          <legend>展示内容</legend><div>{([{ id: 'companion', label: '团子 + 小镇', hint: '上方陪伴，下方小镇实况' }, { id: 'town', label: '整座小镇', hint: '让原来的小镇占满画面' }] as const).map(p => <button type="button" key={p.id} aria-pressed={presentation === p.id} onClick={() => { if (!loaded || saving.current) return; setPresentation(p.id); setSaveFeedback(null); setConfirmClose(false) }}><b>{p.label}</b><small>{p.hint}</small></button>)}</div>
        </fieldset>
        <fieldset className="live-style-picker" disabled={!loaded || busy}>
          <legend>画面风格</legend>
          <div className="live-style-options">{LIVE_STYLES.map(s => <button type="button" key={s.id} className={`live-style-option${style === s.id ? ' is-selected' : ''}`} aria-pressed={style === s.id} onClick={() => { if (!loaded || saving.current) return; setStyle(s.id); setSaveFeedback(null); setConfirmClose(false) }}>
            <span className="live-style-swatch" data-live-style={s.id} aria-hidden="true"><i /><i /><i /></span>
            <b>{s.name}</b><small>{s.description}</small>
          </button>)}</div>
        </fieldset>
        <p className="live-studio-privacy">小镇只展示通用项目名和数量。下面是你主动公开的文字，保存前请确认。</p>
        {FIELDS.map(f => (
          <label key={f.key} className="live-settings-field">
            <span>{f.label}</span>
            <input value={values[f.key]} placeholder={f.placeholder} disabled={!loaded || busy}
              aria-invalid={!!problems[f.key]} onChange={(e) => { if (!loaded || saving.current) return; setValues({ ...values, [f.key]: e.target.value }); setSaveFeedback(null); setConfirmClose(false) }} />
            <small className={problems[f.key] ? 'is-error' : 'muted'}>{problems[f.key] || `${Array.from(values[f.key].trim()).length}/${LIVE_NOTE_MAX}`}</small>
          </label>
        ))}
        <section className="live-owner-gestures" aria-label="团子的动作">
          <div><strong>让团子回应一下</strong><small>由你手动触发 · 尚未接入直播间弹幕</small></div>
          <div className="live-gesture-actions">{([{ kind: 'pat', label: '摸摸团子' }, { kind: 'walk', label: '去散步' }, { kind: 'home', label: '该回家啦' }] as const).map(a => <button type="button" key={a.kind} disabled={!loaded || gestureBusy || presentation !== 'companion'} onClick={() => void gesture(a.kind)}>{a.label}</button>)}</div>
          {gestureBusy && <p role="status">正在发送动作…</p>}
          {gestureFeedback && <ActionFeedback tone={gestureFeedback.tone}><p>{gestureFeedback.text}</p></ActionFeedback>}
        </section>
        {dirty && !busy && <p className="live-settings-dirty">有未保存的修改。点“保存”后，OBS 画面才会更新。</p>}
        {busy && <p role="status">正在保存，请等待结果后再关闭。</p>}
        {saveFeedback && <ActionFeedback tone={saveFeedback.tone}><strong>保存结果</strong><p>{saveFeedback.text}</p></ActionFeedback>}
        {copyFeedback && <ActionFeedback tone={copyFeedback.tone}><strong>展示地址</strong><p>{copyFeedback.text}</p></ActionFeedback>}
        {link && <input className="live-settings-link" readOnly value={link} aria-label="展示地址" onFocus={(e) => e.currentTarget.select()} />}
        <div className="live-settings-actions">
          <button className="btn small primary" disabled={!loaded || busy || invalid} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
          <button className="btn small" disabled={copyBusy} onClick={() => void copy()}>{copyBusy ? '取地址中…' : '复制展示地址'}</button>
          <button className="btn small" disabled={!loaded} onClick={() => window.open(preview, '_blank', 'noopener')}>预览所选风格</button>
          <button className="btn small" data-live-close disabled={busy} onClick={requestClose}>关闭</button>
        </div>
        {confirmClose && <section ref={closeRegion} className="live-close-confirm" role="region" aria-label="关闭前确认">
          <strong>还有未保存的修改</strong><p>现在关闭会放弃本次草稿，已保存的展示画面保持原样。</p>
          <div><button ref={keepEditing} className="btn small primary" disabled={busy} onClick={() => { setConfirmClose(false); dialog.ref.current?.querySelector<HTMLInputElement>('input:not([readonly])')?.focus() }}>继续编辑</button><button className="btn small" disabled={busy} onClick={() => { if (!saving.current) onClose() }}>放弃修改并关闭</button></div>
        </section>}
        </div>
        <aside className="live-studio-preview" aria-label="直播画面预览">
          <div><strong>观众看到的画面</strong><span>9 : 16</span></div>
          <div className="live-preview-frame" ref={previewBox}>{loaded && <iframe title="脱敏小镇直播预览" src={preview} tabIndex={-1} style={{ transform: `scale(${previewScale})` }} />}</div>
          <p>{dirty ? '布局与画风可先试看；文字与 OBS 画面在保存后更新。' : '这是脱敏展示页。复制地址到 OBS 浏览器源，尺寸设为 1080 × 1920。'}</p>
        </aside>
        </div>
      </dialog>
  )
}
