// 房子信息卡：悬停房子时的只读浮层。几个 Agent 在做、核心功能三组、Agent 建议的下一步。
import type { CSSProperties } from 'react'
import { FEATURE_GROUP_LABEL, agentLine, type FeatureGroup, type HouseInfo } from './houseInfo'
import { clip } from './townModel'
import './houseCard.css'

const GROUPS: FeatureGroup[] = ['done', 'building', 'todo']
const PER_GROUP = 4

export function HouseCard({ info, style }: { info: HouseInfo; style?: CSSProperties }) {
  return (
    <div className="town-house-card" role="group" aria-label="项目概况" style={style}>
      <div className="town-house-card-title">{clip(info.name, 24)}</div>
      <div className="town-house-card-agents">
        {info.agents.filter((a) => a.active > 0).map((a) => <i key={a.key} className="town-house-card-dot" style={{ background: a.color }} aria-hidden />)}
        <span>{agentLine(info)}</span>
      </div>
      {info.structure && <p className="town-house-card-purpose-label">{clip(info.structure.document.goal, 58)}</p>}
      {info.empty ? <p className="town-house-card-empty">还没登记核心功能</p> : info.purposeMapped ? <>
        <p className="town-house-card-purpose-label">按用途看功能 · 进入房间展开</p>
        <ul className="town-house-card-purposes">{info.sections.map(section => <li key={section.id}><span>{section.title}</span><b>{section.items.length}</b></li>)}</ul>
      </> : (
        <div className="town-house-card-groups">
          {GROUPS.map((g) => {
            const list = info.groups[g]
            return (
              <div key={g} className={`town-house-card-group is-${g}`}>
                <div className="town-house-card-count">{FEATURE_GROUP_LABEL[g]} <b>{list.length}</b></div>
                {list.length > 0 && (
                  <ul>
                    {list.slice(0, PER_GROUP).map((f) => <li key={f.id} title={`${f.title}：${f.status}`}>{clip(f.title, 12)}{f.conflict ? ' ⚠' : ''}</li>)}
                    {list.length > PER_GROUP && <li className="town-house-card-more">另 {list.length - PER_GROUP} 项</li>}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
      <p className="town-house-card-next">
        {info.next ? <><b>下一步 · {info.next.owner}</b> {clip(info.next.text, 40)} <span className="town-house-card-item">{info.next.itemId}</span></> : <span className="town-house-card-muted">下一步：暂无 Agent 建议</span>}
      </p>
    </div>
  )
}
