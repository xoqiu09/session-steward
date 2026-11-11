import { useState } from 'react'
import { groupByRepo, itemStatusLabel, providerLabel } from '../model'
import type { ItemStatus, WorkItem } from '../types'
import './workItemList.css'

type Sort = 'status' | 'updated' | 'id'
const statusOrder: Record<ItemStatus, number> = { blocked: 0, review: 1, in_progress: 2, todo: 3, done: 4, abandoned: 5 }
const agentsOf = (item: WorkItem) => item.agents.map(providerLabel).join(' · ') || '—'
const waitingFor = (item: WorkItem) => item.waiting.join('、') || '上游依赖'

export function WorkItemList({ groups, onSelect, filtered = false, onClearFilters, onOpenWorkItems }: {
  groups: ReturnType<typeof groupByRepo>
  onSelect: (id: string) => void
  filtered?: boolean
  onClearFilters?: () => void
  onOpenWorkItems?: () => void
}) {
  const [sort, setSort] = useState<Sort>('status')
  const rows = groups.flatMap(group => group.items.map(item => ({ item, repo: group.name })))
  rows.sort((a, b) => sort === 'status'
    ? statusOrder[a.item.status] - statusOrder[b.item.status] || b.item.updated_at.localeCompare(a.item.updated_at)
    : sort === 'updated' ? b.item.updated_at.localeCompare(a.item.updated_at) : a.item.id.localeCompare(b.item.id))

  return <section className="work-item-list" aria-label="工作列表">
    <div className="work-item-list-toolbar">
      <p className="work-item-list-count"><strong>{rows.length}</strong> 项工作</p>
      {rows.length > 0 && <label className="work-item-list-sort">排序
        <select aria-label="工作项排序" value={sort} onChange={event => setSort(event.target.value as Sort)}>
          <option value="status">按状态</option>
          <option value="updated">按更新时间</option>
          <option value="id">按编号</option>
        </select>
      </label>}
    </div>

    {rows.length === 0 ? <div className="work-item-list-empty">
      <h2>{filtered ? '没有匹配的工作项' : '当前没有可显示的工作项'}</h2>
      <p>{filtered ? '试试清除筛选，或到工作项面板查看其他记录。' : '这里显示当前范围内的工作。已处理和历史记录可到工作项面板查看。'}</p>
      {(filtered && onClearFilters || onOpenWorkItems) && <div className="work-item-list-empty-actions">
        {filtered && onClearFilters && <button type="button" className="btn primary" onClick={onClearFilters}>清除筛选</button>}
        {onOpenWorkItems && <button type="button" className="btn" onClick={onOpenWorkItems}>打开工作项面板</button>}
      </div>}
    </div> : <>
      <div className="work-item-list-desktop">
        <table className="work-item-table" aria-label="工作项表格">
          <colgroup><col className="work-col-id" /><col className="work-col-title" /><col className="work-col-project" /><col className="work-col-status" /><col className="work-col-agent" /><col className="work-col-deps" /></colgroup>
          <thead><tr><th scope="col">编号</th><th scope="col">标题</th><th scope="col">项目</th><th scope="col">状态</th><th scope="col">Agent</th><th scope="col">依赖</th></tr></thead>
          <tbody>{rows.map(({ item, repo }) => <tr key={item.id}>
            <td className="mono">{item.id}</td>
            <td><button type="button" className="work-item-open" aria-label={`查看工作项 ${item.id} ${item.title}`} onClick={() => onSelect(item.id)}>{item.title}</button></td>
            <td>{repo}</td>
            <td className="work-item-status-cell"><span className={`pill st-${item.status}`}>{itemStatusLabel[item.status]}</span></td>
            <td>{agentsOf(item)}</td>
            <td className="work-item-dependency">{item.ready ? '—' : `等 ${waitingFor(item)}`}</td>
          </tr>)}</tbody>
        </table>
      </div>

      <ul className="work-item-list-mobile" aria-label="工作项卡片">
        {rows.map(({ item, repo }) => <li className="work-item-card" key={item.id}>
          <div className="work-item-card-heading">
            <h2><button type="button" className="work-item-open" aria-label={`查看工作项 ${item.id} ${item.title}`} onClick={() => onSelect(item.id)}>{item.title}</button></h2>
            <span className={`pill st-${item.status}`}>{itemStatusLabel[item.status]}</span>
          </div>
          <p className="work-item-card-project"><span>项目</span> {repo}</p>
          <details className="work-item-card-more">
            <summary>编号、Agent 与依赖</summary>
            <dl>
              <dt>编号</dt><dd className="mono">{item.id}</dd>
              <dt>Agent</dt><dd>{agentsOf(item)}</dd>
              <dt>依赖</dt><dd>{item.ready ? '当前不需等待上游' : `等待 ${waitingFor(item)}`}</dd>
            </dl>
          </details>
        </li>)}
      </ul>
    </>}
  </section>
}
