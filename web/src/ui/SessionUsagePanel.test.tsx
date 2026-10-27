import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { SessionUsagePanel } from './SessionUsagePanel'

const t = (n: number) => ({ input: n, output: n, cache_read: n, cache_write: n })

it('有用量时显示合计、模型和子 Agent；关闭统计时什么都不画', () => {
  const html = renderToStaticMarkup(<SessionUsagePanel usage={{
    enabled: true, found: true,
    self: { models: { 'claude-a': t(100), 'claude-b': t(10) }, turns: [], total: t(110) },
    subagents: [{ id: 'x', type: 'Explore', description: '查数据来源', finished: true, start: '', end: '', total: t(25) }],
    with_subagents: t(135),
  }} />)
  expect(html).toContain('消耗')
  expect(html).toContain('540')
  expect(html).toContain('子 Agent · 1 个')
  expect(html).toContain('查数据来源')
  expect(html).toContain('claude-b')
  expect(renderToStaticMarkup(<SessionUsagePanel usage={{ enabled: false, found: false, self: { models: {}, turns: [], total: t(0) }, subagents: [], with_subagents: t(0) }} />)).toBe('')
})
