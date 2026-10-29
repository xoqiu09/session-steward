import type { Dep, WorkItem } from './types'
import { layers, type Group } from './model'

export const CARD_W = 280
export const CARD_H = 220
export const CANVAS_ZOOM = 0.95
const GAP = 18, PAD = 16, HEAD = 76, PROJECT_GAP = 28
const order: Record<string, number> = { blocked: 0, in_progress: 1, review: 2, todo: 3, done: 4, abandoned: 5 }
export interface CanvasProject {
  group: Group; x: number; y: number; width: number; height: number; collapsed: boolean
  cards: { item: WorkItem; x: number; y: number }[]
}

/** Independent projects wrap into rows; dependency layers still run left to right inside each project. */
export function canvasLayout(groups: Group[], deps: Dep[], viewportWidth: number, collapsed: ReadonlySet<string>): CanvasProject[] {
  const room = Math.max(CARD_W + PAD * 2, viewportWidth / CANVAS_ZOOM - 48)
  const maxCols = Math.max(1, Math.min(groups.length === 1 ? 4 : 2, Math.floor((room - PAD * 2 + GAP) / (CARD_W + GAP))))
  let x = 0, y = 0, rowHeight = 0
  return groups.map(group => {
    const shut = collapsed.has(group.key)
    const cards: CanvasProject['cards'] = []
    let columns = 1, rows = 0
    if (!shut && group.items.length) {
      const levels = layers(group.items, deps), byLevel = new Map<number, WorkItem[]>()
      for (const item of group.items) {
        const level = levels.get(item.id) ?? 0
        if (!byLevel.has(level)) byLevel.set(level, [])
        byLevel.get(level)!.push(item)
      }
      let offset = 0
      for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
        const list = byLevel.get(level)!.sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id))
        const cols = byLevel.size === 1 ? Math.min(maxCols, Math.ceil(Math.sqrt(list.length))) : Math.ceil(list.length / 3)
        const layerRows = byLevel.size === 1 ? Math.ceil(list.length / cols) : Math.min(3, list.length)
        list.forEach((item, index) => {
          const col = byLevel.size === 1 ? index % cols : Math.floor(index / 3)
          const row = byLevel.size === 1 ? Math.floor(index / cols) : index % 3
          cards.push({ item, x: PAD + (offset + col) * (CARD_W + GAP), y: HEAD + row * (CARD_H + GAP) })
        })
        offset += cols
        rows = Math.max(rows, layerRows)
      }
      columns = Math.max(1, offset)
    }
    const width = columns * CARD_W + (columns - 1) * GAP + PAD * 2
    const height = HEAD + (rows ? rows * CARD_H + (rows - 1) * GAP + PAD : 0)
    if (x > 0 && x + width > room) { x = 0; y += rowHeight + PROJECT_GAP; rowHeight = 0 }
    const project = { group, x, y, width, height, collapsed: shut, cards: cards.map(c => ({ ...c, x: c.x + x, y: c.y + y })) }
    x += width + PROJECT_GAP
    rowHeight = Math.max(rowHeight, height)
    return project
  })
}

/** Reading never scales a long board down to an unreadable overview. */
export function canvasReadingViewport(rect: { x: number; y: number }, width: number) {
  const zoom = Math.min(CANVAS_ZOOM, Math.max(0.8, (width - 48) / (CARD_W + 32)))
  return { x: 24 - rect.x * zoom, y: 20 - rect.y * zoom, zoom }
}
