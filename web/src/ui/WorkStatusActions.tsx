import { useState } from 'react'
import { api } from '../api'
import { isRemote } from '../access'
import { ErrorLine, useAction } from '../bits'
import type { WorkItem, WorkManagement } from '../types'
import { managementLabel } from '../workManagement'
import './workStatus.css'

const choices: Record<WorkManagement['state'], { label: string; confirm: string; help: string }> = {
  accepted: { label: '标记已验收', confirm: '确认已验收', help: '按你的确认将此工作项标为已完成，旧简报保留。代码合并和核心功能的验收仍分别记录。' },
  delegated: { label: '记录已转交', confirm: '确认转交记录', help: '记录接手人，并收起此项的日常催办。这里只保存交接记录，接手人的通知和安排由你完成。' },
  paused: { label: '暂停提醒', confirm: '确认暂停提醒', help: '暂时收起此项的日常催办，可随时继续处理。正在运行的会话不会停止，正式审批仍会显示。' },
  active: { label: '继续处理', confirm: '确认继续处理', help: '恢复日常跟进并清除旧的阻塞提示。旧回报保留；可在说明中填写现在的下一步。' },
}

export function WorkStatusActions({ item }: { item: WorkItem }) {
  const [open, setOpen] = useState(false)
  if (isRemote()) return null
  return <div className="work-status-actions">
    <button className="btn" type="button" aria-label={`管理状态 ${item.id}`} aria-expanded={open} onClick={() => setOpen(!open)}>管理状态</button>
    {open && <WorkManagementForm key={item.id} item={item} onClose={() => setOpen(false)} />}
  </div>
}

export function WorkManagementForm({ item, onClose }: { item: WorkItem; onClose: () => void }) {
  const [state, setState] = useState<WorkManagement['state']>(item.management?.state === 'paused' || item.management?.state === 'delegated' ? 'active' : 'accepted')
  const [owner, setOwner] = useState(item.management?.owner || '')
  const [note, setNote] = useState('')
  const act = useAction()
  if (isRemote()) return null
  const choice = choices[state]
  return <form className="work-management-form" aria-label={`管理状态 ${item.id}`} onSubmit={e => {
    e.preventDefault()
    act.run(async () => {
      await api.patchItem(item.id, { management: { state, owner: state === 'delegated' ? owner.trim() : '', note: note.trim() } })
      onClose()
    })
  }}>
    <strong>{item.id} · {item.title}</strong>
    {item.management && <p className="muted">当前：{managementLabel(item)}{item.management.note ? ` · ${item.management.note}` : ''}</p>}
    <label>处理方式<select autoFocus value={state} disabled={act.busy} onChange={e => setState(e.target.value as WorkManagement['state'])}>
      {Object.entries(choices).map(([value, c]) => <option key={value} value={value}>{c.label}</option>)}
    </select></label>
    {state === 'delegated' && <label>接手人或接手会话<input required maxLength={80} value={owner} disabled={act.busy} onChange={e => setOwner(e.target.value)} placeholder="例如：小猫，或新的会话名称" /></label>}
    <label>{state === 'active' ? '现在的下一步（可选）' : '说明（可选）'}<textarea maxLength={500} rows={2} value={note} disabled={act.busy} onChange={e => setNote(e.target.value)} /></label>
    <p className="hint">{choice.help}</p>
    <ErrorLine msg={act.error} />
    <div className="row wrap"><button className="btn primary" type="submit" disabled={act.busy}>{act.busy ? '正在保存…' : choice.confirm}</button><button className="btn" type="button" disabled={act.busy} onClick={onClose}>取消</button></div>
  </form>
}
