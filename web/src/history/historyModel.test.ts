import { describe, expect, it } from 'vitest'
import { changeText, heatmapWeeks, levels, metricOf, providerBars, rangeSums, streak } from './historyModel'
import type { DayStat } from '../types'

const day = (d: string, p: Partial<DayStat> = {}): DayStat => ({
  day: d, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, by_provider: {}, by_model: {},
  sessions: 1, prompts: 0, tools: 0, subagents: 0, delivered: 0, accepted: 0, returned: 0, blocked: 0, failed: 0, ...p,
})

describe('历史日历', () => {
  it('热力图按周排列，周一在上，今天之后为空', () => {
    const w = heatmapWeeks('2026-10-27') // 周二
    expect(w).toHaveLength(53)
    const last = w[52]
    expect(last[0]).toBe('2026-10-26') // 周一
    expect(last[1]).toBe('2026-10-27')
    expect(last[2]).toBeNull()
  })

  it('颜色按分位数分档，0 永远是最浅', () => {
    const lv = levels([1, 2, 3, 4, 100])
    expect(lv(0)).toBe(0)
    expect(lv(100)).toBe(4)
    expect(lv(1)).toBe(1)
  })

  it('区间合计和连续天数', () => {
    const days = [day('2026-10-20', { prompts: 3 }), day('2026-10-26', { prompts: 2, accepted: 1, delivered: 2 }), day('2026-10-27', { prompts: 1, tools: 4 })]
    const [week, d7, d30] = rangeSums(days, '2026-10-27')
    expect(week.prompts).toBe(3) // 10/26 是周一
    expect(d7.prompts).toBe(3)
    expect(d7.accepted).toBe(1)
    expect(d30.active).toBe(3)
    expect(streak(days, '2026-10-27')).toBe(2)
    expect(metricOf(days[2], 'work')).toBe(3)
  })

  it('状态变化翻成人话', () => {
    expect(changeText({ from: 'review', to: 'done', at: '' }).text).toBe('你验收通过')
    expect(changeText({ from: 'review', to: 'in_progress', at: '' }).text).toBe('你退回修改')
    expect(changeText({ from: 'in_progress', to: 'review', at: '' }).text).toBe('交付，等你验收')
  })

  it('近 30 天按 Agent 堆叠，缺的日子补空', () => {
    const bars = providerBars([day('2026-10-27', { by_provider: { codex: 5, claude: 10 } })], '2026-10-27')
    expect(bars).toHaveLength(30)
    expect(bars[29].parts.map((p) => p.provider)).toEqual(['claude', 'codex'])
    expect(bars[0].parts).toEqual([])
  })
})
