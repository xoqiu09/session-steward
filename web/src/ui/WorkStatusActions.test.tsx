import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { WorkItem } from '../types'
import { WorkManagementForm, WorkStatusActions } from './WorkStatusActions'

const item = { id: 'TEST-1', title: '合成状态测试', status: 'in_progress', ready: true, waiting: [], agents: [], management: undefined } as unknown as WorkItem
it('lets the user review the exact item and explicitly record acceptance, delegation, pause or resume', () => {
  const html = renderToStaticMarkup(<WorkManagementForm item={item} onClose={() => {}} />)
  expect(html).toContain('TEST-1 · 合成状态测试')
  for (const text of ['标记已处理', '记录已转交', '暂停提醒', '继续处理', '确认已处理']) expect(html).toContain(text)
  expect(html).toContain('验证结果、核心功能确认和代码合并分别记录')
  expect(html).toContain('说明（可选）')
})
it('makes paused and delegated work recoverable with its existing owner note visible', () => {
  const html = renderToStaticMarkup(<WorkManagementForm item={{ ...item, management: { state: 'delegated', owner: '测试接手人', note: '已在另一个会话安排', at: '' } }} onClose={() => {}} />)
  expect(html).toContain('已转交给 测试接手人')
  expect(html).toContain('已在另一个会话安排')
  expect(html).toContain('<option value="active" selected="">继续处理')
  expect(html).toContain('确认继续处理')
})
it('does not offer write actions in the remote panel', () => {
  vi.stubGlobal('window', { location: { protocol: 'https:', hostname: 'fixture.example' } })
  try {
    expect(renderToStaticMarkup(<WorkStatusActions item={item} />)).toBe('')
    expect(renderToStaticMarkup(<WorkManagementForm item={item} onClose={() => {}} />)).toBe('')
  } finally { vi.unstubAllGlobals() }
})
