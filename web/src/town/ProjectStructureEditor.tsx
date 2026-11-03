import { useState } from 'react'
import { api } from '../api'
import type { ProjectFeature, ProjectStructure, ProjectStructureDocument } from '../types'
import { emptyStructure, parseStructure, structurePrompt } from './projectStructure'

/** Explicit metadata editing only; importing a file merely fills a preview. */
export function ProjectStructureEditor({ repo, name, features, current, onSaved }: {
  repo: number; name: string; features: readonly ProjectFeature[]; current?: ProjectStructure | null; onSaved: (saved: ProjectStructure) => void
}) {
  const [draft, setDraft] = useState<ProjectStructureDocument>(() => structuredClone(current?.document ?? emptyStructure()))
  const [base] = useState(current?.revision ?? '')
  const [text, setText] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const patch = (fields: Partial<ProjectStructureDocument>) => { setDraft(d => ({ ...d, ...fields })); setMessage('') }
  const load = (raw: string) => {
    try { setDraft(parseStructure(raw)); setError(''); setMessage('已载入预览，点击“保存目录”后才会生效。') }
    catch (e) { setError(e instanceof Error ? e.message : '无法读取结构资料') }
  }
  const assign = (id: string, target: string) => {
    const ref = draft.groups.flatMap(g => g.features).find(f => f.id === id) ?? { id }
    patch({ groups: draft.groups.map(g => ({ ...g, features: [...g.features.filter(f => f.id !== id), ...(g.id === target ? [ref] : [])] })) })
  }
  const save = async () => {
    setBusy(true); setError(''); setMessage('')
    try {
      const { structure } = await api.saveProjectStructure(repo, draft, base)
      onSaved(structure)
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重新读取目录核对结果') }
    finally { setBusy(false) }
  }
  return <div className="town-structure-editor">
    <p>这里整理项目说明和显示目录。保存不会改变任务状态、功能回报或用户验收。</p>
    {current && current.revision !== base && <p role="alert">目录已在别处更新，请关闭整理区并重新打开后再比较。</p>}
    <button type="button" onClick={() => setOutput(structurePrompt(name, features, current))}>给 Agent 的整理说明</button>
    {output && <label>复制以下内容给正在开发的 Agent，或保存为项目资料<textarea aria-label="整理说明或导出内容" readOnly value={output} rows={7} /></label>}
    <label>项目目标<input value={draft.goal} maxLength={600} onChange={e => patch({ goal: e.target.value })} /></label>
    <label>给谁使用<input value={draft.audience} maxLength={300} onChange={e => patch({ audience: e.target.value })} /></label>
    <label>当前范围<textarea aria-label="当前范围" value={draft.scope} maxLength={1200} rows={3} onChange={e => patch({ scope: e.target.value })} /></label>
    <div className="town-editor-row"><label>整理日期<input type="date" value={draft.prepared_at} onChange={e => patch({ prepared_at: e.target.value })} /></label><label>依据版本<input value={draft.basis_version} maxLength={200} onChange={e => patch({ basis_version: e.target.value })} /></label></div>
    <details><summary>调整用途目录与功能归属 · {draft.groups.length} 类</summary>
      {draft.groups.map((g, index) => <fieldset key={g.id}>
        <legend>用途 {index + 1}</legend>
        <label>用途名称<input value={g.title} maxLength={60} onChange={e => patch({ groups: draft.groups.map(x => x.id === g.id ? { ...x, title: e.target.value } : x) })} /></label>
        <label>回答的问题<input value={g.question} maxLength={200} onChange={e => patch({ groups: draft.groups.map(x => x.id === g.id ? { ...x, question: e.target.value } : x) })} /></label>
        <button type="button" onClick={() => patch({ groups: draft.groups.filter(x => x.id !== g.id), relations: draft.relations.filter(r => r.from !== g.id && r.to !== g.id) })}>移除此分组，功能保留待分类</button>
      </fieldset>)}
      <button type="button" disabled={draft.groups.length >= 12} onClick={() => {
        let n = 1; while (draft.groups.some(g => g.id === `purpose-${n}`)) n++
        patch({ groups: [...draft.groups, { id: `purpose-${n}`, title: '新用途', question: '', features: [] }] })
      }}>添加用途分组</button>
      {features.map(f => <label key={f.id}>{f.title}<select aria-label={`${f.title}的用途归属`} value={draft.groups.find(g => g.features.some(x => x.id === f.id))?.id ?? ''} onChange={e => assign(f.id, e.target.value)}><option value="">待分类</option>{draft.groups.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select></label>)}
    </details>
    <details><summary>导入、导出与关系资料</summary>
      <label>选择结构 JSON 文件<input type="file" accept=".json,application/json" onChange={async e => {
        const file = e.target.files?.[0]; if (!file) return
        if (file.size > 65536) { setError('结构资料最多 64 KiB'); return }
        try { const raw = await file.text(); setText(raw); load(raw) } catch { setError('文件读取失败') }
      }} /></label>
      <label>粘贴结构 JSON<textarea aria-label="粘贴结构 JSON" value={text} rows={7} onChange={e => setText(e.target.value)} /></label>
      <div className="town-editor-row"><button type="button" onClick={() => load(text)}>载入预览</button><button type="button" onClick={() => { const raw = JSON.stringify(draft, null, 2); setText(raw); setOutput(raw) }}>导出当前草稿</button></div>
      <p>导出的结构仅含项目说明、用途、关系和依据，不包含工作记录。导入预览可在上方检查目标、分组及功能归属。</p>
    </details>
    <p className="town-house-features-line">预览：{draft.groups.length} 类用途 · 已归类 {draft.groups.reduce((n, g) => n + g.features.length, 0)} 项。保存后标为“用户整理”，Agent 无法直接覆盖。</p>
    {error && <p className="town-house-features-blocker" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <button type="button" disabled={busy || !draft.goal.trim() || (current?.revision ?? '') !== base} onClick={save}>{busy ? '正在保存…' : '保存目录'}</button>
  </div>
}
