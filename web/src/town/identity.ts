// 项目的稳定身份：来源设备 + 那台设备上的原始项目编号。
// 合并视图里加了偏移的 repo_id、显示名（带“ · 设备名”后缀）、排序都会变，不能拿来当身份。
// D0 身份契约冻结前的最小版本：快照里的项目只带设备名、不带 device_id，所以远端设备按名字区分；
// 两台设备同名时退回到合并编号，宁可这一次换位置，也不把两栋房子当成同一个。
import type { Repo } from '../types'
import { HUB_STRIDE } from '../hub/ids'
import type { BuildingView } from './townModel'

export interface ProjectIdentity {
  /** 'self' 是本机；其他是设备名。 */
  device: string
  /** 来源设备上的原始项目编号（去掉合并偏移）。 */
  projectId: number
  key: string
}

/** selfName：本机设备名，不知道时传空串。“这台”视图里的项目不带设备名，合并视图里本机项目带本机名，两边得到同一个身份。 */
export function projectIdentity(repo: Pick<Repo, 'id' | 'device'>, selfName = ''): ProjectIdentity {
  const device = !repo.device || repo.device === selfName ? 'self' : repo.device
  const projectId = repo.id % HUB_STRIDE
  return { device, projectId, key: `${device}#${projectId}` }
}

/** 给一组建筑分配不重复的稳定键：未归属按建筑键，撞名的设备附上合并编号。 */
export function identityKeys(buildings: readonly BuildingView[], selfName = ''): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const b of buildings) {
    let id = b.repo ? projectIdentity(b.repo, selfName).key : `unassigned:${b.key}`
    if (used.has(id)) id = `${id}~${b.key}`
    used.add(id)
    out.set(b.key, id)
  }
  return out
}
