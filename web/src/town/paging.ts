// 项目多于一屏能画下的建筑时分页。需要你处理的项目（关注队列里的审批／决定）排在最前，
// 并固定在每一页上，轮播时不会被翻走；固定的太多时留一个位置给其它项目轮流出现。
import type { Approval } from '../types'
import type { BuildingView } from './townModel'

export function pageBuildings<T>(list: readonly T[], perPage: number, pinned: (b: T) => boolean): T[][] {
  const size = Math.max(1, Math.floor(perPage))
  const urgent = list.filter(pinned)
  const rest = list.filter((b) => !pinned(b))
  if (list.length <= size) return [[...urgent, ...rest]]
  const fixed = urgent.slice(0, size - 1)
  const rotating = [...urgent.slice(size - 1), ...rest]
  const room = size - fixed.length
  const pages: T[][] = []
  for (let i = 0; i < rotating.length; i += room) pages.push([...fixed, ...rotating.slice(i, i + room)])
  return pages
}

/** 这栋建筑里有没有等你处理的请求：角色身上挂着的，或按项目归属的。 */
export function needsYou(b: BuildingView, pending: readonly Approval[]): boolean {
  if (b.characters.some((c) => c.pendingApprovals.length > 0)) return true
  return b.repo != null && pending.some((a) => a.repo_id === b.repo!.id)
}

/** 页码越界时（项目变少）收回到最后一页。 */
export function clampPage(page: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(Math.max(0, page), count - 1)
}

/** 包含这个会话角色的页；找不到时为 -1。 */
export function pageOfCharacter(pages: readonly BuildingView[][], key: string): number {
  return pages.findIndex((p) => p.some((b) => b.characters.some((c) => c.key === key)))
}
