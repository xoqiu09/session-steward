import { afterEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'

// 沿用项目已有的小型 hook 宿主；执行真实组件的异步加载和刷新回调，不新增 DOM 依赖。
const host = vi.hoisted(() => {
  let index = 0, mounted = false
  const slots: any[] = [], effects: (() => void | (() => void))[] = [], cleanups: (() => void)[] = []
  return {
    begin() { index = 0 },
    commit() { if (!mounted) { mounted = true; effects.forEach(fn => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) }) } },
    reset() { cleanups.forEach(fn => fn()); slots.length = 0; effects.length = 0; cleanups.length = 0; mounted = false },
    state(initial: any) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { slots[i] = value }] },
    ref(value: any) { const i = index++; if (!(i in slots)) slots[i] = { current: value }; return slots[i] },
    effect(fn: () => void | (() => void)) { if (!mounted) effects.push(fn) },
  }
})
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: host.state, useRef: host.ref, useEffect: host.effect, useCallback: (fn: unknown) => fn }))
import { api } from './api'
import { HooksSettings } from './HooksSettings'

const nodes = (node: any): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : []
const render = () => { host.begin(); const tree = HooksSettings({ onClose() {} }); host.commit(); return tree }
afterEach(() => { host.reset(); vi.restoreAllMocks() })

it('成功显示后刷新失败会移除旧覆盖结果，不把上次齐全显示为当前事实', async () => {
  vi.spyOn(api, 'hookCoverage').mockResolvedValueOnce([{ provider: 'claude', version: '2.1.310', installed: ['Stop'], missing: [], skipped: [] }]).mockRejectedValueOnce(new Error('401'))
  render()
  await Promise.resolve()
  let tree = render()
  expect(renderToStaticMarkup(tree)).toContain('当前已核实支持的事件均已接入')
  const refresh = nodes(tree).find(node => node.type === 'button' && node.props.children === '刷新')!
  refresh.props.onClick()
  await Promise.resolve()
  tree = render()
  const html = renderToStaticMarkup(tree)
  expect(html).toContain('采集设置暂时无法读取')
  expect(html).not.toContain('均已接入')
  expect(html).not.toContain('Claude Code · 2.1.310')
})
