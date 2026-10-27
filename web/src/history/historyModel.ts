// 历史日历的纯计算：热力图按周排列、颜色分档、区间合计、状态变化的说法。不碰网络和 DOM。
import type { DayChange, DayStat, Tokens } from '../types'

export type Metric = 'work' | 'tokens' | 'accepted'

export const METRIC_LABEL: Record<Metric, string> = { work: '干活量', tokens: 'token', accepted: '验收' }

export const tokenTotal = (t: Tokens) => t.input + t.output + t.cache_read + t.cache_write

/** 一天的数值：干活量 = 对话轮数 + 工具次数的一半（工具多但轮数少的日子不至于看不见）。 */
export function metricOf(d: DayStat | undefined, m: Metric): number {
  if (!d) return 0
  if (m === 'tokens') return tokenTotal(d.tokens)
  if (m === 'accepted') return d.accepted
  return d.prompts + Math.ceil(d.tools / 2)
}

export const fmtNum = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))

const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const parseDay = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }

/** 热力图：从 to 往前 weeks 周，按列（周）排，每列周一到周日。超出 to 的格子为空。 */
export function heatmapWeeks(to: string, weeks = 53): (string | null)[][] {
  const end = parseDay(to)
  const dow = (end.getDay() + 6) % 7 // 周一=0
  const start = new Date(end)
  start.setDate(end.getDate() - dow - (weeks - 1) * 7)
  const cols: (string | null)[][] = []
  for (let w = 0; w < weeks; w++) {
    const col: (string | null)[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + w * 7 + i)
      col.push(d > end ? null : dayKey(d))
    }
    cols.push(col)
  }
  return cols
}

/** 颜色分档 0-4：按有数据日子的分位数分，避免一天特别多把其余全压成浅色。 */
export function levels(values: number[]): (v: number) => 0 | 1 | 2 | 3 | 4 {
  const xs = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (!xs.length) return () => 0
  const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))]
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.8)
  return (v) => (v <= 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4)
}

export interface RangeSum { label: string; days: number; work: number; prompts: number; delivered: number; accepted: number; returned: number; tokens: number; active: number }

/** 本周（周一起）、近 7 天、近 30 天的合计。 */
export function rangeSums(days: readonly DayStat[], to: string): RangeSum[] {
  const end = parseDay(to)
  const monday = new Date(end)
  monday.setDate(end.getDate() - ((end.getDay() + 6) % 7))
  const since = (n: number) => { const d = new Date(end); d.setDate(end.getDate() - (n - 1)); return dayKey(d) }
  const ranges: [string, string][] = [['本周', dayKey(monday)], ['近 7 天', since(7)], ['近 30 天', since(30)]]
  return ranges.map(([label, from]) => {
    const xs = days.filter((d) => d.day >= from && d.day <= to)
    const sum = (f: (d: DayStat) => number) => xs.reduce((n, d) => n + f(d), 0)
    return {
      label, days: Math.round((end.getTime() - parseDay(from).getTime()) / 86400_000) + 1,
      work: sum((d) => metricOf(d, 'work')), prompts: sum((d) => d.prompts), delivered: sum((d) => d.delivered), accepted: sum((d) => d.accepted),
      returned: sum((d) => d.returned), tokens: sum((d) => tokenTotal(d.tokens)), active: xs.filter((d) => d.prompts + d.tools > 0).length,
    }
  })
}

/** 连续有活动的天数（到 to 为止）。 */
export function streak(days: readonly DayStat[], to: string): number {
  const active = new Set(days.filter((d) => d.prompts + d.tools > 0).map((d) => d.day))
  let n = 0
  const d = parseDay(to)
  if (!active.has(to)) d.setDate(d.getDate() - 1) // 今天还没开工不算断
  while (active.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1) }
  return n
}

const STATUS: Record<string, string> = { todo: '待开始', in_progress: '进行中', blocked: '受阻', review: '待验收', done: '已完成', abandoned: '已放弃' }

/** 状态变化翻成人话。 */
export function changeText(c: DayChange): { text: string; tone: 'good' | 'warn' | 'bad' | 'plain' } {
  if (c.to === 'done') return { text: c.from === 'review' ? '你验收通过' : '标为完成', tone: 'good' }
  if (c.to === 'review') return { text: '交付，等你验收', tone: 'plain' }
  if (c.from === 'review' && c.to === 'in_progress') return { text: '你退回修改', tone: 'warn' }
  if (c.to === 'blocked') return { text: '受阻', tone: 'bad' }
  if (c.to === 'abandoned') return { text: '放弃', tone: 'bad' }
  if (c.to === 'in_progress') return { text: c.from === 'todo' ? '开始做' : `回到进行中（原为${STATUS[c.from] ?? c.from}）`, tone: 'plain' }
  return { text: `${STATUS[c.from] ?? c.from} → ${STATUS[c.to] ?? c.to}`, tone: 'plain' }
}

/** 按 Agent 堆叠的每日柱：最近 n 天，每天各 Agent 的 token。 */
export function providerBars(days: readonly DayStat[], to: string, n = 30): { day: string; parts: { provider: string; value: number }[] }[] {
  const byDay = new Map(days.map((d) => [d.day, d]))
  const end = parseDay(to)
  const out = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end)
    d.setDate(end.getDate() - i)
    const key = dayKey(d)
    const s = byDay.get(key)
    out.push({ day: key, parts: Object.entries(s?.by_provider ?? {}).map(([provider, value]) => ({ provider, value })).sort((a, b) => a.provider.localeCompare(b.provider)) })
  }
  return out
}
