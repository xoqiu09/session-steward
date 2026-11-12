import { useEffect, useRef, useState } from 'react'
import { api, ApiError, type LiveContent, type LiveContentAction, type LiveReadingPoolSummary, type LiveReadingPoolImport } from '../api'
import { ActionFeedback } from '../ui/ActionFeedback'
import { CONTENT_SOURCES, sourceName } from './content'
import { LIVE_TOPICS, liveTopic } from './topics'
import { ReadingPoolImport } from './ReadingPoolImport'
import './contentSettings.css'

export function contentProblem(draft: LiveContent): string {
  for (const [index, item] of draft.items.entries()) {
    if (item.topic && !liveTopic(item.topic)) return `内容 ${index + 1} 请选择已有的联动小屋。`
    for (const [label, text, max] of [['标题', item.title, 48], ['正文', item.body, 240], ['出处', item.credit, 80]] as const) {
      if (Array.from(text).length > max || /[\u0000-\u001f\u007f-\u009f]/.test(text)) return `内容 ${index + 1} 的${label}最多 ${max} 字，不能包含换行或控制字符。`
    }
    if (item.approved && (!item.title.trim() || !item.body.trim())) return `内容 ${index + 1} 还缺少标题或正文，暂时不能公开。`
  }
  return ''
}

export function LiveContentSettings({ onDirty, onBusy }: { onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void }) {
  const [draft, setDraft] = useState<LiveContent | null>(null)
  const [pool, setPool] = useState<LiveReadingPoolSummary | null>(null)
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const mounted = useRef(false), pending = useRef(false)
  const dirty = !!draft && JSON.stringify(draft) !== saved
  const problem = draft ? contentProblem(draft) : ''
  useEffect(() => { onDirty(dirty) }, [dirty, onDirty])
  useEffect(() => { onBusy(busy) }, [busy, onBusy])
  const load = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setFeedback('')
    try {
      const [data, library] = await Promise.all([api.liveContent(), api.liveReadingPool()])
      if (mounted.current) { setDraft(data); setPool(library); setSaved(JSON.stringify(data)); setUncertain(false) }
    } catch (e) { if (mounted.current) setError(`读取播放清单失败：${e instanceof Error ? e.message : '请稍后重试'}`) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; onDirty(false); onBusy(false) } }, [])
  const edit = (next: LiveContent) => { setDraft(next); setFeedback(''); setError('') }
  const update = async (action: LiveContentAction) => {
    if (!draft || pending.current || uncertain || (action === 'save' && problem)) return
    pending.current = true; setBusy(true); setFeedback(''); setError('')
    try {
      const data = await api.saveLiveContent(draft, action)
      if (mounted.current) {
        setDraft(data); setSaved(JSON.stringify(data))
        setFeedback(action === 'save' ? (data.mode === 'random' ? '已切换到随机摘句。一轮读完前不重复，主题小屋同步亮灯。' : '公开清单已保存。只有已确认且勾选播放的卡片会进入画面，约 5 秒内同步。') : action === 'pause' ? '已暂停在当前卡片。小镇继续运行。' : action === 'play' ? '已开始轮播公开卡片。' : '已切换到下一张公开卡片。')
      }
    } catch (e) {
      if (mounted.current) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 409) setError(`没有保存成功：${e.message}。草稿仍在，可以修改后再保存。`)
        else { setUncertain(true); setError(`未确认操作结果：${e instanceof Error ? e.message : '连接中断'}。草稿仍在，请先重新读取服务器清单，再决定是否修改。`) }
      }
    } finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const importPool = async (input: LiveReadingPoolImport) => {
    if (!pool || pending.current || dirty || uncertain) return
    pending.current = true; setBusy(true); setError(''); setFeedback('')
    try {
      const library = await api.importLiveReadingPool(input, pool.revision)
      const data = await api.liveContent()
      if (mounted.current) { setPool(library); setDraft(data); setSaved(JSON.stringify(data)); setFeedback(`已导入 ${library.count.toLocaleString()} 句，可以选择随机摘句模式。`) }
    } catch (e) {
      if (mounted.current) { setUncertain(true); setError(`未确认导入结果：${e instanceof Error ? e.message : '连接中断'}。请先重新读取，再决定是否导入。`) }
    } finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const count = draft?.mode === 'random' ? (draft.sources.includes('kuangye') ? pool?.count ?? 0 : 0) : draft?.items.filter(item => item.enabled && item.approved && draft.sources.includes(item.source)).length ?? 0
  return <section className="live-content-settings" aria-label="公开内容轮播">
    <header><div><h3>让内容，在小镇慢慢流过。</h3><p>手动选卡，或从已确认的摘句库里偶然读到一句。</p></div><span>{count.toLocaleString()} {draft?.mode === 'random' ? '句随机摘句' : '张公开卡片'}</span></header>
    {busy && <p role="status">{draft ? '正在同步播放清单…' : '正在读取播放清单…'}</p>}
    {error && <ActionFeedback tone="error"><p>{error}</p><button className="btn small" disabled={busy} onClick={() => void load()}>{draft ? '重新读取并替换草稿' : '重新读取'}</button></ActionFeedback>}
    {draft && <>
      <fieldset disabled={busy || uncertain} className="live-content-options"><legend>公开画面</legend>
        <label>播放方式<select value={draft.mode ?? ''} onChange={e => edit({ ...draft, mode: e.target.value === 'random' ? 'random' : undefined })}><option value="">手动清单</option><option value="random" disabled={!pool?.count}>随机摘句{pool?.count ? ` · ${pool.count.toLocaleString()} 句` : ' · 请先导入'}</option></select></label>
        <label>画面重心<select value={draft.focus} onChange={e => edit({ ...draft, focus: e.target.value as LiveContent['focus'] })}><option value="town">小镇为主</option><option value="reading">内容为主</option></select></label>
        <label>每张停留<select value={draft.interval_seconds} onChange={e => edit({ ...draft, interval_seconds: Number(e.target.value) as LiveContent['interval_seconds'] })}>{[20, 40, 60].map(n => <option key={n} value={n}>{n} 秒</option>)}</select></label>
        <div className="live-content-sources">{CONTENT_SOURCES.map(source => <label key={source}><input type="checkbox" checked={draft.sources.includes(source)} onChange={e => edit({ ...draft, sources: e.target.checked ? [...draft.sources, source] : draft.sources.filter(s => s !== source) })} />{sourceName(source, true)}</label>)}</div>
      </fieldset>
      <ReadingPoolImport pool={pool} disabled={busy || uncertain || dirty} onImport={importPool} />
      {draft.mode !== 'random' && <>
      {!draft.items.length && <div className="live-content-empty"><strong>给小镇选一张内容卡吧。</strong><p>可以是一句自己的思考、一段作品介绍，或带出处的阅读笔记。清单为空时只展示小镇。</p></div>}
      <fieldset className="live-content-cards" disabled={busy || uncertain}><legend className="sr-only">编辑内容卡片</legend>
        {draft.items.map((item, index) => {
          const patch = (change: Partial<typeof item>, copy = false) => edit({ ...draft, items: draft.items.map((card, i) => i === index ? { ...card, ...change, ...(copy ? { approved: false } : {}) } : card) })
          return <article className="live-content-edit" key={item.id}>
            <header><span>内容 {String(index + 1).padStart(2, '0')}</span><button className="btn small" type="button" onClick={() => edit({ ...draft, items: draft.items.filter(card => card.id !== item.id) })} aria-label={`移除内容 ${index + 1}`}>移除</button></header>
            <label>来源<select value={item.source} onChange={e => patch({ source: e.target.value as typeof item.source }, true)}>{CONTENT_SOURCES.map(source => <option key={source} value={source}>{sourceName(source, true)}</option>)}</select></label>
            <label>联动小屋<select aria-label={`内容 ${index + 1} 的联动小屋`} value={item.topic ?? ''} onChange={e => patch({ topic: liveTopic(e.target.value)?.id }, true)}><option value="">不联动</option>{LIVE_TOPICS.map(topic => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select><small>播放时这间小屋亮灯，一位居民沿小路过去陪读。</small></label>
            <label>标题<input value={item.title} maxLength={96} placeholder="用一句话把观众带进来" onChange={e => patch({ title: e.target.value }, true)} /><small>{Array.from(item.title).length} / 48 字</small></label>
            <label>正文<textarea rows={3} value={item.body} maxLength={480} placeholder="一张卡片只讲一个想法，最多 240 字；不填写私人信息" onChange={e => patch({ body: e.target.value.replace(/[\r\n]+/g, ' ') }, true)} /><small>{Array.from(item.body).length} / 240 字</small></label>
            <label>出处或说明<input value={item.credit} maxLength={160} placeholder="例如：自己的随笔 · 2026.11" onChange={e => patch({ credit: e.target.value }, true)} /></label>
            <div className="live-content-approval"><label><input type="checkbox" checked={item.enabled} onChange={e => patch({ enabled: e.target.checked })} />加入播放</label><label><input type="checkbox" checked={item.approved} disabled={!item.title.trim() || !item.body.trim()} onChange={e => patch({ approved: e.target.checked })} />我已检查内容，可以公开</label></div>
            {!item.approved && <small className="live-content-private">草稿 · 不会出现在观众画面。修改文字后需要重新确认。</small>}
          </article>
        })}
        <button className="btn small" type="button" disabled={draft.items.length >= 24} onClick={() => edit({ ...draft, items: [...draft.items, { id: crypto.randomUUID(), source: 'compass', title: '', body: '', credit: '', enabled: true, approved: false }] })}>＋ 添加内容卡</button>
      </fieldset>
      </>}
      {problem && <p role="alert" className="live-content-private">{problem}</p>}
      <div className="live-content-actions"><button className="btn small primary" disabled={busy || uncertain || !dirty || !!problem} onClick={() => void update('save')}>保存公开清单</button><button className="btn small" disabled={busy || uncertain || dirty || !count} onClick={() => void update(draft.playing ? 'pause' : 'play')}>{draft.playing ? '暂停轮播' : '开始轮播'}</button><button className="btn small" disabled={busy || uncertain || dirty || !count} onClick={() => void update('next')}>下一张</button></div>
      {dirty && <p className="live-content-private">清单有未保存的修改。保存后再控制播放。</p>}
      <p className="live-content-hint">公开画面不带阅读来源名称。选好联动小屋后，灯光与卡片同步；暂停时留在当前小屋，同主题连续播放时继续停留。</p>
    </>}
    {feedback && <ActionFeedback tone="success"><p>{feedback}</p></ActionFeedback>}
  </section>
}
