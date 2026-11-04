// Project-owned purpose directories organize display without changing registered facts.
import type { ProjectStructure } from '../types'
import type { HouseFeature } from './houseInfo'
import type { BuildingView } from './townModel'

export interface PurposeFeature extends HouseFeature { label: string }
export interface FeatureSection { id: string; title: string; question: string; note?: string; items: PurposeFeature[] }

/** Bind by canonical project ID, never by project name, keywords or a developer's local path. */
export function featureSections(b: BuildingView, features: readonly HouseFeature[], structure?: ProjectStructure | null): { mapped: boolean; sections: FeatureSection[] } {
  const document = b.repo && structure?.repo_id === b.repo.id ? structure.document : null
  if (!document) return { mapped: false, sections: features.length ? [{ id: 'all', title: '功能清单', question: '尚未整理用途，展开查看已登记功能。', items: features.map(f => ({ ...f, label: f.title })) }] : [] }
  const ids = new Map(features.map(f => [f.id, f]))
  const used = new Set<string>()
  const sections: FeatureSection[] = document.groups.map(({ features: refs, ...group }) => ({
    ...group,
    items: refs.flatMap(ref => {
      const f = ids.get(ref.id)
      if (!f || used.has(ref.id)) return []
      used.add(ref.id)
      return [{ ...f, label: ref.label?.trim() || f.title }]
    }),
  }))
  const unclassified = features.filter(f => !used.has(f.id)).map(f => ({ ...f, label: f.title }))
  if (unclassified.length) sections.push({ id: 'unclassified', title: '待分类功能', question: '这些功能还未归入用途目录，已有登记与回报仍保留。', items: unclassified })
  return { mapped: true, sections }
}
