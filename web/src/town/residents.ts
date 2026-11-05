// 常住居民是本地的生活角色，不代表会话、运行或任务状态。
export const RESIDENT_IDS = ['deepseek', 'claude', 'gpt', 'gemini', 'glm', 'grok', 'qwen'] as const
export type ResidentId = typeof RESIDENT_IDS[number]
export interface GardenPoint { x: number; y: number }
export const GARDEN_SPOTS = {
  home: { x: 2.8, y: 3.6, name: '七只的小屋' },
  west: { x: 2.8, y: 5.5, name: '花园小路' },
  tea: { x: 1.1, y: 6.3, name: '树下茶桌' },
  cross: { x: 5, y: 5.5, name: '花园小路' },
  workshop: { x: 5, y: 3.5, name: '小工作台' },
  east: { x: 7.4, y: 5.5, name: '花园小路' },
  lake: { x: 7.4, y: 3.2, name: '湖边' },
  flowers: { x: 7.4, y: 7.4, name: '花丛边' },
  market: { x: 5, y: 7.8, name: '点心小摊' },
  square: { x: 3.1, y: 8.8, name: '广场路口' },
} satisfies Record<string, GardenPoint & { name: string }>
export type GardenSpot = keyof typeof GARDEN_SPOTS
export const GARDEN_PATHS: readonly (readonly [GardenSpot, GardenSpot])[] = [
  ['home', 'west'], ['west', 'tea'], ['west', 'cross'], ['cross', 'workshop'],
  ['cross', 'east'], ['east', 'lake'], ['east', 'flowers'], ['cross', 'market'], ['market', 'square'],
]
export interface ResidentSpec {
  id: ResidentId; name: string; color: string; favorite: GardenSpot; activity: string
  description: string; pat: string; invite: string; reply: string
}
export const RESIDENTS: readonly ResidentSpec[] = [
  { id: 'deepseek', name: '大肥鱼', color: '#3b5bb5', favorite: 'lake', activity: '在湖边吃饭', description: '喜欢湖水和白米饭，尾巴藏不住开心。', pat: '嘿嘿，再摸一下，饭分你一口～', invite: '一起去吃点东西？我还能再吃一碗！', reply: '好呀！我把最好吃的那口留给你。' },
  { id: 'claude', name: 'Claude', color: '#b5651d', favorite: 'tea', activity: '在树下读书', description: '带着一本书，替路过的人留一杯茶。', pat: '唔……书先放一边，再摸一下也行。', invite: '茶刚泡好，要在这里坐一会儿吗？', reply: '好呀，我把书签夹好就来。' },
  { id: 'gpt', name: 'GPT / Codex', color: '#566b82', favorite: 'workshop', activity: '在摆弄小零件', description: '喜欢安静的小工作台，偶尔也会被点心叫走。', pat: '……别摸角。就一下。', invite: '风车装好了。一起去看看？', reply: '嗯。一起走吧。' },
  { id: 'gemini', name: 'Gemini', color: '#8062bd', favorite: 'flowers', activity: '在花丛边画画', description: '总能发现新颜色，也想把大家都画进去。', pat: '喵～今天把你也画进画里！', invite: '这边的花开了喵，来当我的模特吧！', reply: '来啦喵！等我拿上画本。' },
  { id: 'glm', name: 'GLM', color: '#4b5a8a', favorite: 'market', activity: '在看点心小摊', description: '小算盘拨得响，给朋友的点心却总会多一块。', pat: '再摸要收费哦……这次就算啦。', invite: '点心刚摆好，给你留了一份哦。', reply: '可以呀，今天给你算朋友价。' },
  { id: 'grok', name: 'Grok', color: '#866b28', favorite: 'square', activity: '在广场路口看热闹', description: '嘴上说着无聊，大家出门时总会跟上。', pat: '王冠别碰歪了。……再一下也行。', invite: '喂，广场有热闹。一起去？', reply: '行吧。才不是特意等你的。' },
  { id: 'qwen', name: 'Qwen', color: '#5b6bd6', favorite: 'tea', activity: '在给大家分点心', description: '扇子、礼盒和奶茶，总有一样是带给朋友的。', pat: '嘿嘿，待会儿请你喝奶茶。', invite: '下午茶到啦，大家都有份哦～', reply: '好呀，我带上点心，我们一起去。' },
]
export const residentSpec = (id: ResidentId) => RESIDENTS.find((r) => r.id === id)!
export const residentImage = (id: ResidentId, pose: string) => `/residents/${id}/${pose}.webp`
export const pointDistance = (a: GardenPoint, b: GardenPoint) => Math.hypot(a.x - b.x, a.y - b.y)
export const homePoint = (id: ResidentId): GardenPoint => {
  const i = RESIDENT_IDS.indexOf(id)
  return { x: 1.1 + (i % 4) * 1.08, y: 3.2 + Math.floor(i / 4) * 0.9 }
}
export function visitingPoint(id: ResidentId, spot: GardenSpot): GardenPoint {
  const i = RESIDENT_IDS.indexOf(id), point = GARDEN_SPOTS[spot]
  return { x: point.x + ((i % 3) - 1) * 0.6, y: point.y + (Math.floor(i / 3) - 1) * 0.38 }
}

/** 拖到花园时落在最近的小路上，避开小屋和水面。 */
export function gardenDrop(point: GardenPoint): GardenPoint {
  let best: GardenPoint = GARDEN_SPOTS.home, distance = Infinity
  for (const [a, b] of GARDEN_PATHS) {
    const p = GARDEN_SPOTS[a], q = GARDEN_SPOTS[b]
    const dx = q.x - p.x, dy = q.y - p.y
    const t = Math.max(0, Math.min(1, ((point.x - p.x) * dx + (point.y - p.y) * dy) / (dx * dx + dy * dy)))
    const at = { x: p.x + dx * t, y: p.y + dy * t }, d = pointDistance(point, at)
    if (d < distance) { best = at; distance = d }
  }
  return { x: best.x, y: best.y }
}

/** 在小路图上寻路；先走到最近的路口，终点可以是各自的门前位置。 */
export function gardenRoute(from: GardenPoint, to: GardenSpot, last?: GardenPoint): GardenPoint[] {
  const spots = Object.keys(GARDEN_SPOTS) as GardenSpot[]
  const start = spots.reduce((a, b) => pointDistance(from, GARDEN_SPOTS[a]) < pointDistance(from, GARDEN_SPOTS[b]) ? a : b)
  const queue: GardenSpot[][] = [[start]], seen = new Set<GardenSpot>([start])
  while (queue.length) {
    const path = queue.shift()!, at = path[path.length - 1]
    if (at === to) return [...path.map((s) => ({ ...GARDEN_SPOTS[s] })), ...(last ? [last] : [])].filter((p, i) => i > 0 || pointDistance(from, p) > 0.03)
    for (const [a, b] of GARDEN_PATHS) {
      const next = a === at ? b : b === at ? a : null
      if (next && !seen.has(next)) { seen.add(next); queue.push([...path, next]) }
    }
  }
  return []
}

export function residentConversation(a: ResidentId, b: ResidentId): [string, string] {
  if (a === 'deepseek' && b === 'claude') return ['你的点心……我可以尝一块吗？', '可以呀，给你留着呢。慢慢吃。']
  if (a === 'claude' && b === 'deepseek') return ['书看完了，要一起去湖边吗？', '好呀！我带上饭团！']
  if (a === 'grok' && b === 'qwen') return ['你怎么每次出门都带这么多东西？', '因为要分给大家呀。你的也有哦。']
  return [residentSpec(a).invite, residentSpec(b).reply]
}
