import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ReplayBar, maxMinute, minuteLabel, replayISO, startPos } from './ReplayBar'

it('回放位置换成本地时间；过去的日子从 9 点开始，今天最多到现在', () => {
  expect(minuteLabel(9 * 60 + 5)).toBe('09:05')
  expect(startPos('2026-01-02')).toEqual({ day: '2026-01-02', minute: 540 })
  expect(new Date(replayISO({ day: '2026-01-02', minute: 90 })).getHours()).toBe(1)
  expect(maxMinute('2026-01-02')).toBe(24 * 60 - 5)
  const today = startPos()
  expect(today.minute).toBeLessThanOrEqual(maxMinute(today.day))
})

it('时间条有日期、拖动条、播放和回到现在', () => {
  const html = renderToStaticMarkup(<ReplayBar pos={{ day: '2026-01-02', minute: 600 }} playing={false} loading={false} onChange={() => {}} onPlay={() => {}} onExit={() => {}} />)
  expect(html).toContain('回放 01/02 10:00')
  expect(html).toContain('type="range"')
  expect(html).toContain('播放')
  expect(html).toContain('回到现在')
})
