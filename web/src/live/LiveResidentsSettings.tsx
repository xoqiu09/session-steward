import { useEffect, useRef, useState } from 'react'
import { api, type LiveResidents } from '../api'
import { residentImage, type ResidentId } from '../town/residents'
import { ActionFeedback } from '../ui/ActionFeedback'
import { DEFAULT_RESIDENT_CONTROL, LIVE_RESIDENT_IDS, liveResidentName, publicLiveResidents } from './liveResidents'
import { useLiveResident } from './useLiveResident'
import './liveResidents.css'

export function LiveResidentsSettings() {
  const [control, setControl] = useState<LiveResidents>(DEFAULT_RESIDENT_CONTROL)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{text: string; error: boolean} | null>(null)
  const pending = useRef(false), generation = useRef(0)
  const current = useLiveResident(control)
  const load = async () => {
    const id = ++generation.current
    setLoaded(false); setFeedback(null)
    try {
      const note = await api.liveNote()
      if (generation.current !== id) return
      setControl(publicLiveResidents(note.resident_control) ?? DEFAULT_RESIDENT_CONTROL); setLoaded(true)
    } catch (error) {
      if (generation.current === id) setFeedback({ text: `读取出场设置失败：${error instanceof Error ? error.message : '未知错误'}`, error: true })
    }
  }
  useEffect(() => { void load(); return () => { ++generation.current } }, [])
  const update = async (patch: Partial<Omit<LiveResidents, 'anchor'>>) => {
    if (!loaded || pending.current) return
    pending.current = true; setBusy(true); setFeedback(null)
    const id = generation.current
    const next = { resident: current, mode: control.mode, interval_seconds: control.interval_seconds, ...patch }
    try {
      const saved = publicLiveResidents(await api.setLiveResidents(next))
      if (!saved) throw new Error('没有收到有效的出场设置')
      if (generation.current !== id) return
      setControl(saved)
      setFeedback({ text: `已切换到 ${liveResidentName(saved.resident)}。${saved.mode === 'auto' ? `每 ${saved.interval_seconds / 60} 分钟轮换一位。` : '将保持这位居民出场。'}画面约 2 秒内更新。`, error: false })
    } catch (error) {
      if (generation.current === id) setFeedback({ text: `未能确认出场设置：${error instanceof Error ? error.message : '未知错误'}。可重新读取确认当前状态。`, error: true })
    } finally { pending.current = false; if (generation.current === id) setBusy(false) }
  }
  return <section className="live-residents-settings" aria-label="七位居民出场设置">
    <header><div><h3>今天，谁来陪你？</h3><p>{loaded ? `现在是 ${liveResidentName(current)} · ${control.mode === 'auto' ? '七位轮流出场' : '固定一位'}` : '正在读取出场设置…'}</p></div><span>7 位居民</span></header>
    <fieldset disabled={!loaded || busy}>
      <legend className="sr-only">选择出场居民，立即生效</legend>
      <div className="live-resident-roster">{LIVE_RESIDENT_IDS.map((id: ResidentId) => <button key={id} type="button" aria-label={`让 ${liveResidentName(id)} 出场`} aria-pressed={current === id} onClick={() => void update({ resident: id })}><img src={residentImage(id, 'avatar')} alt="" /><b>{liveResidentName(id)}</b></button>)}</div>
      <div className="live-resident-options"><div role="group" aria-label="出场方式"><button type="button" aria-pressed={control.mode === 'auto'} onClick={() => void update({ mode: 'auto' })}>轮流出场</button><button type="button" aria-pressed={control.mode === 'fixed'} onClick={() => void update({ mode: 'fixed' })}>固定一位</button></div><label>每隔 <select aria-label="自动轮换间隔" disabled={control.mode !== 'auto' || !loaded || busy} value={control.interval_seconds} onChange={e => void update({ interval_seconds: Number(e.target.value) as LiveResidents['interval_seconds'] })}><option value="60">1 分钟</option><option value="120">2 分钟</option><option value="300">5 分钟</option></select>换一位</label></div>
    </fieldset>
    <p className="live-resident-help">点头像立即切换；轮换时会更新名字和回应。观众点名时，你也可以在这里代她切换。</p>
    {busy && <p role="status">正在更新出场设置…</p>}
    {feedback && <ActionFeedback tone={feedback.error ? 'error' : 'success'}><p>{feedback.text}</p>{feedback.error && <button type="button" className="btn small" disabled={busy} onClick={() => void load()}>重新读取出场设置</button>}</ActionFeedback>}
  </section>
}
