// 收菜：每个项目门口一块菜地，一个未完成的工作项是一棵菜。长势只是状态的另一种画法：
// 待开始=种子，Agent 在干=发芽，等你决定=缺水，待验收=熟了，受阻=生虫。熟了的由你一棵一棵收（验收）。
import type { Approval, WorkItem } from '../types'
import type { BuildingView } from './townModel'
import { attentionManaged } from '../workManagement'

export type CropStage = 'seed' | 'sprout' | 'thirsty' | 'ripe' | 'bug'

export const STAGE_LABEL: Record<CropStage, string> = {
  seed: '种子 · 待开始', sprout: '发芽 · Agent 在干', thirsty: '缺水 · 等你决定', ripe: '熟了 · 待你验收', bug: '生虫 · 受阻',
}

export type CropKind = 'tomato' | 'carrot' | 'pumpkin' | 'cabbage' | 'corn'
const KINDS: CropKind[] = ['tomato', 'carrot', 'pumpkin', 'cabbage', 'corn']
export const CROP_NAME: Record<CropKind, string> = { tomato: '番茄', carrot: '萝卜', pumpkin: '南瓜', cabbage: '白菜', corn: '玉米' }

/** 每个项目种的菜固定，一眼认得出是哪块地。 */
export function cropKindOf(repoId: number | null | undefined): CropKind {
  return KINDS[Math.abs(repoId ?? 0) % KINDS.length]
}

/** 菜地最多种几棵，其余只计数。 */
export const FIELD_MAX = 9
/** 熟了这么久还没收，会发蔫提醒。 */
export const OVERRIPE_MS = 2 * 86400_000

export interface Crop { item: WorkItem; stage: CropStage; overripe: boolean }

const ORDER: Record<CropStage, number> = { ripe: 0, thirsty: 1, bug: 2, sprout: 3, seed: 4 }

export function cropStage(item: WorkItem, b: BuildingView, pending: readonly Approval[]): CropStage {
  if (item.status === 'review') return 'ripe'
  if (item.status === 'blocked') return 'bug'
  const waiting = pending.some((a) => a.work_item_id === item.id) || b.characters.some((c) => c.item?.id === item.id && c.status === 'waiting')
  if (waiting) return 'thirsty'
  return item.status === 'in_progress' ? 'sprout' : 'seed'
}

export function cropsOf(b: BuildingView, pending: readonly Approval[], now: number): { crops: Crop[]; more: number } {
  const open = b.items.filter((w) => !attentionManaged(w) && w.status !== 'done' && w.status !== 'abandoned')
  const all = open.map((item) => {
    const stage = cropStage(item, b, pending)
    return { item, stage, overripe: stage === 'ripe' && now - Date.parse(item.updated_at) > OVERRIPE_MS }
  }).sort((x, y) => ORDER[x.stage] - ORDER[y.stage] || x.item.id.localeCompare(y.item.id))
  return { crops: all.slice(0, FIELD_MAX), more: Math.max(0, all.length - FIELD_MAX) }
}

/** 收菜顺序：按给定的项目顺序（地图巡游的顺序），每块地里先收熟得最久的。 */
export function ripeQueue(buildings: readonly BuildingView[]): { item: WorkItem; buildingKey: string }[] {
  return buildings.flatMap((b) => b.items.filter((w) => !attentionManaged(w) && w.status === 'review')
    .sort((x, y) => x.updated_at.localeCompare(y.updated_at) || x.id.localeCompare(y.id))
    .map((item) => ({ item, buildingKey: b.key })))
}

export type HarvestResult = 'pending' | 'harvested' | 'returned' | 'gone'

/** 收菜开始时记下的那批菜，现在各自怎样了：收下（已完成）、退回（回到执行中）、还没动、或已经不在了。 */
export function harvestResult(id: string, buildings: readonly BuildingView[]): HarvestResult {
  for (const b of buildings) {
    const w = b.items.find((x) => x.id === id)
    if (!w) continue
    if (w.status === 'review') return 'pending'
    if (w.status === 'done') return 'harvested'
    return 'returned'
  }
  return 'gone'
}
