import { useId, useRef, useState } from 'react'
import { ago } from '../model'
import type { RoomFocus } from './roomRequest'
import { houseInfo, featureStatus } from './houseInfo'
import type { PurposeFeature } from './featureCategories'
import type { BuildingView } from './townModel'
import { itemStatusLabel } from './townModel'
import type { ProjectFeature, ProjectStructure } from '../types'
import { ProjectStructureEditor } from './ProjectStructureEditor'
import { ProjectHousekeeping } from './ProjectHousekeeping'
import './projectRoom.css'

function FeatureDetail({ feature: f }: { feature: PurposeFeature }) {
  return <li><details className="town-feature-detail">
    <summary><span className="town-house-features-name">{f.label}</span><span className={`town-house-features-status${f.conflict || f.status.includes('失败') ? ' is-warn' : ''}`}>{f.status}</span><span className="town-feature-chevron" aria-hidden="true">›</span></summary>
    <div className="town-feature-facts"><p className="town-house-features-line">原登记名称：{f.title}</p><p className="town-house-features-line">验收标准：{f.acceptance || '尚未回报'}</p>
      {f.blocker && <p className="town-house-features-blocker">卡点回报：{f.blocker}</p>}{f.stale && <p className="town-house-features-line">回报已超过一天，当前情况待同步。</p>}
    </div>
  </details></li>
}

const TABS = [{ id: 'overview', label: '项目概况' }, { id: 'map', label: '功能地图' }, { id: 'work', label: '当前推进' }, { id: 'evidence', label: '验证依据' }] as const
type Tab = typeof TABS[number]['id']

/** Shared reader; structure is metadata, all progress comes from existing facts. */
export function TownFeaturePanel({ b, features, structure, writeable = false, onOpenItem, focus }: {
  b: BuildingView; features: readonly ProjectFeature[] | null; structure?: ProjectStructure | null; writeable?: boolean; onOpenItem?: (id: string) => void
  /** 从右键菜单进来时直接展开的区块。 */
  focus?: RoomFocus
}) {
  const info = houseInfo(b, features, structure)
  const now = new Date().toISOString()
  const document = info.structure?.document
  const mine = (features ?? []).filter(f => f.repo_id === b.repo?.id)
  const [tab, setTab] = useState<Tab>('overview')
  const [editing, setEditing] = useState(focus === 'organize' && writeable)
  const [receipt, setReceipt] = useState('')
  const tabs = useRef<HTMLDivElement>(null)
  const id = useId()
  const all = Object.values(info.groups).flat()
  const tasks = b.items.filter(w => w.status !== 'done' && w.status !== 'abandoned')
  const titleOf = (key: string) => document?.groups.find(g => g.id === key)?.title ?? key
  return <section className="town-house-features town-project-room" aria-label={`${b.name} 项目结构`} onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
    <div className="town-house-features-head">项目结构</div>
    <div className="town-house-features-counts">{document ? `${document.groups.length} 类用途 · ` : ''}{all.length} 项功能</div>
    <div className="town-house-features-counts">你已确认 {all.filter(f => f.accepted).length} · Agent 自报通过 {all.filter(f => f.reportedPassed).length}（未经你确认）</div>
    <div className="town-room-tabs" ref={tabs} role="tablist" aria-label="项目阅读方式">
      {TABS.map((t, i) => <button type="button" key={t.id} role="tab" id={`${id}-${t.id}`} aria-controls={`${id}-panel`} aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)} onKeyDown={e => {
        const n = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1
        if (n >= 0) { e.preventDefault(); setTab(TABS[n].id); tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[n]?.focus() }
      }}>{t.label}</button>)}
    </div>
    <div id={`${id}-panel`} className="town-room-scroll" role="tabpanel" aria-labelledby={`${id}-${tab}`} tabIndex={0}>
      {tab === 'overview' && (document ? <>
        <p className="town-room-goal">{document.goal}</p>
        <dl className="town-room-facts"><div><dt>给谁使用</dt><dd>{document.audience || '尚未整理'}</dd></div><div><dt>当前范围</dt><dd>{document.scope || '尚未整理'}</dd></div></dl>
        <h3>能力怎样配合</h3>
        {document.relations.length ? <ol className="town-room-relations" aria-label="功能关系">{document.relations.map(r => <li key={`${r.from}/${r.to}`}><div><b>{titleOf(r.from)}</b><svg width="26" height="16" viewBox="0 0 26 16" aria-label="关联到" role="img"><path d="M2 8h21m-5-5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg><b>{titleOf(r.to)}</b></div><p>{r.label}</p></li>)}</ol> : <p className="town-house-features-note">尚未整理关系，可先从功能地图了解用途。</p>}
        <p className="town-house-features-note">结构说明的是功能规则；当前进展与验证请看另外两个页签。</p>
      </> : <div className="town-room-empty"><h3>先给这个项目一张说明卡</h3><p>目标、用途和功能关系尚未整理。已有任务和功能回报仍可查看。</p><p>从下方“整理项目”填写概况、导入结构资料，或复制说明给正在开发的 Agent。</p></div>)}
      {tab === 'map' && <>
        <p className="town-house-features-note">先看用途；展开功能，再核对原登记和进度。</p>
        {info.empty && <p className="town-house-features-empty">尚未登记核心功能，不能据此判断项目未开发。</p>}
        <div className="town-feature-categories" aria-label={`${b.name} 功能分类`}>{info.sections.map((section, index) => <details key={section.id} className="town-feature-category" data-purpose={section.id}>
          <summary><span className="town-feature-category-title"><span className="town-feature-category-no" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>{section.title}<span className="town-feature-category-count">{section.items.length} 项</span></span><span className="town-feature-category-question">{section.question}</span><span className="town-feature-chevron" aria-hidden="true">›</span></summary>
          <div className="town-feature-category-body">{section.note && <p className="town-house-features-note">{section.note}</p>}<ul aria-label={`${section.title}的功能`}>{section.items.map(f => <FeatureDetail key={f.id} feature={f} />)}</ul>{!section.items.length && <p className="town-house-features-note">该用途尚未关联功能登记，开发情况待核对。</p>}</div>
        </details>)}</div>
      </>}
      {tab === 'work' && <>
        <p className="town-house-features-note">来自现有工作项，按当前小镇筛选范围展示。任务改变，功能目录保留。</p>
        {!tasks.length && <p>当前范围没有未完成工作项。</p>}
        <ul className="town-room-tasks">{tasks.map(w => {
          const linked = mine.filter(f => f.work_item_ids.includes(w.id))
          const summary = w.brief?.fields.progress
          const blocker = w.brief?.fields.blocker
          return <li key={w.id}>{onOpenItem ? <button type="button" onClick={() => onOpenItem(w.id)}>{w.title}</button> : <b>{w.title}</b>}
            <p className="town-house-features-line">{w.id} · {itemStatusLabel[w.status]}{w.management?.state === 'paused' ? ' · 已暂停' : ''}</p>
            <details className="town-room-task-links"><summary>关联功能 · {linked.length} 项</summary>{linked.length ? <ul>{linked.map(f => <li key={f.id}>{f.title}</li>)}</ul> : <p className="town-house-features-line">尚未登记关联。</p>}</details>
            {summary && !summary.flagged && <p>{summary.text}</p>}{blocker && !blocker.flagged && blocker.text && <p className="town-house-features-blocker">卡点：{blocker.text}</p>}
          </li>
        })}</ul>
      </>}
      {tab === 'evidence' && <>
        <p className="town-house-features-note">实现、验证是 Agent 回报；用户验收单独记录。测试通过不等于部署或实际运行。</p>
        {!mine.length && <p>尚未登记功能验证依据。</p>}
        <ul>{mine.map(f => <li key={f.id}><details className="town-feature-detail"><summary><span className="town-house-features-name">{f.title}</span><span className="town-house-features-status">{featureStatus(f)}</span><span className="town-feature-chevron" aria-hidden="true">›</span></summary><div className="town-feature-facts">
          <p className="town-house-features-line">候选版本：{f.candidate || '未回报'}</p><p className="town-house-features-line">你的确认：{f.accepted ? <>你已确认{f.accepted_at && <> · <time dateTime={f.accepted_at} title={f.accepted_at}>{ago(f.accepted_at, now)}</time></>}</> : '尚未确认'}</p>
          {!f.contributions.length && <p>尚无 Agent 依据回报。</p>}{f.contributions.map((c, i) => <div className="town-room-evidence" key={`${c.id}/${c.run_id}/${i}`}><p>{c.evidence || '本次没有附验证说明'}</p><small>{c.provider} 自报 · <time dateTime={c.at} title={c.at}>{ago(c.at, now)}</time> · {c.candidate || '版本未回报'}</small></div>)}
          <p className="town-house-features-note">实际运行与部署范围需查看原回报，不从以上状态自动推断。</p>
        </div></details></li>)}</ul>
      </>}
      {document && <details className="town-room-sources"><summary>结构整理依据 · {document.prepared_at}</summary><p>依据版本：<code>{document.basis_version}</code></p><p>{info.structure?.author === 'user' ? '用户整理' : 'Agent 建议'} · {info.structure?.updated_at ? <time dateTime={info.structure.updated_at} title={info.structure.updated_at}>{ago(info.structure.updated_at, now)}</time> : '时间未记录'}。这是日期化结构说明，未自动刷新源码或运行状态。</p>
        <ul>{document.sources.map((s, i) => <li key={`${s.path}/${i}`}><code>{s.path}{s.line_start ? `:${s.line_start}${s.line_end ? `–${s.line_end}` : ''}` : ''}</code><span>{s.kind === 'source' ? '源码依据' : '文档依据'}{s.note ? ` · ${s.note}` : ''}</span></li>)}</ul>{!document.sources.length && <p>手工填写，尚未附源码或文档依据。</p>}
      </details>}
      {receipt && <p role="status">{receipt}</p>}
      {writeable && b.repo && <details className="town-room-organize" open={editing} onToggle={e => setEditing(e.currentTarget.open)}><summary>整理项目</summary>{editing && <ProjectStructureEditor repo={b.repo.id} name={b.name} features={mine} current={info.structure} onSaved={() => { setEditing(false); setReceipt('目录已保存。') }} />}</details>}
      {writeable && b.repo && <ProjectHousekeeping repo={b.repo} name={b.name} initialOpen={focus === 'housekeeping'} />}
      {!writeable && !document && <p className="town-house-features-note">请在项目所属设备的本机实时视图整理结构资料。</p>}
    </div>
  </section>
}
