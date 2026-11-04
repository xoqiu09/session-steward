import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { TownStructure } from './TownStructure'
import { STRUCTURE_PAGES } from './structureContent'

it('默认说明以 SS 样本和源码证据为边界，没有业务动作或文件链接', () => {
  const html = renderToStaticMarkup(<TownStructure onClose={() => {}} />)
  for (const text of ['Session Steward 结构说明', '首版样本', '整体结构', '暂停提醒', 'WorkItem', 'Session', 'Run', 'Approval', '查看源码依据', '源码核对', '2e452a1']) expect(html).toContain(text)
  expect(html).toContain('aria-selected="true"')
  expect(html).not.toMatch(/<a\b|<form\b|<input\b|<select\b|<textarea\b|\/Users\/|SES-021|确认暂停|确认验收/)
})

it('暂停图保留条件读取与实测边界；每条线都有明确端点', () => {
  const pause = STRUCTURE_PAGES.find(p => p.id === 'pause')!
  expect(pause.edges.find(e => e.to === 'router')?.conditional).toBe(true)
  expect(pause.notes.map(n => n.text).join('')).toContain('未通过正式任务触发实测')
  for (const page of STRUCTURE_PAGES) {
    const ids = [...page.nodes, ...(page.readers ?? [])].map(n => n.id)
    for (const edge of page.edges) { expect(ids).toContain(edge.from); expect(ids).toContain(edge.to) }
  }
})
