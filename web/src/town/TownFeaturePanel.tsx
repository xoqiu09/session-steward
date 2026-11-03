import { houseInfo } from './houseInfo'
import type { PurposeFeature } from './featureCategories'
import type { BuildingView } from './townModel'
import type { ProjectFeature } from '../types'

function FeatureDetail({ feature: f }: { feature: PurposeFeature }) {
  return <li>
    <details className="town-feature-detail">
      <summary>
        <span className="town-house-features-name">{f.label}</span>
        <span className={`town-house-features-status${f.conflict || f.status.includes('失败') ? ' is-warn' : ''}`}>{f.status}</span>
        <span className="town-feature-chevron" aria-hidden="true">›</span>
      </summary>
      <div className="town-feature-facts">
        <p className="town-house-features-line">原登记名称：{f.title}</p>
        <p className="town-house-features-line">验收标准：{f.acceptance || '尚未回报'}</p>
        {f.blocker && <p className="town-house-features-blocker">卡点回报：{f.blocker}</p>}
        {f.stale && <p className="town-house-features-line">回报已超过一天，当前情况待同步。</p>}
      </div>
    </details>
  </li>
}

/** 先看用途，再展开具体功能，最后核对原登记与进度。所有交互均为本页展开/收起。 */
export function TownFeaturePanel({ b, features }: { b: BuildingView; features: readonly ProjectFeature[] | null }) {
  const info = houseInfo(b, features)
  const all = Object.values(info.groups).flat()
  const purposeCount = info.sections.filter(section => section.id !== 'unclassified').length
  return <section className="town-house-features" aria-label="核心功能">
    <div className="town-house-features-head">{info.purposeMapped ? '功能地图' : '项目功能'}</div>
    {info.empty ? <p className="town-house-features-empty">还没登记核心功能：Agent 用 steward-hook features 回报后会出现在这里</p> : <>
      <div className="town-house-features-counts">{info.purposeMapped ? `${purposeCount} 类用途 · ` : ''}{all.length} 项功能</div>
      <div className="town-house-features-counts">你已验收 {all.filter(f => f.accepted).length} · Agent 报验证通过 {all.filter(f => f.reportedPassed).length}</div>
      <p className="town-house-features-note">先看用途；展开功能，再核对进度和验收依据。</p>
      <div className="town-feature-categories" tabIndex={0} aria-label={`${b.name} 功能分类`}>
        {info.sections.map((section, index) => <details key={section.id} className="town-feature-category" data-purpose={section.id}>
          <summary>
            <span className="town-feature-category-title"><span className="town-feature-category-no" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>{section.title}<span className="town-feature-category-count">{section.items.length} 项</span></span>
            <span className="town-feature-category-question">{section.question}</span>
            <span className="town-feature-chevron" aria-hidden="true">›</span>
          </summary>
          <div className="town-feature-category-body">
            {section.note && <p className="town-house-features-note">{section.note}</p>}
            <ul aria-label={`${section.title}的功能`}>{section.items.map(f => <FeatureDetail key={f.id} feature={f} />)}</ul>
          </div>
        </details>)}
      </div>
    </>}
  </section>
}
