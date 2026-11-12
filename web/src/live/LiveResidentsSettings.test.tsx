import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

// Exercise the real asynchronous component callbacks without adding a DOM test dependency.
const host = vi.hoisted(() => {
  let index = 0, mounted = false
  const slots: any[] = [], effects: (() => void | (() => void))[] = [], cleanups: (() => void)[] = []
  return {
    begin() { index = 0 },
    commit() { if (!mounted) { mounted = true; effects.forEach(fn => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) }) } },
    reset() { cleanups.forEach(fn => fn()); slots.length = 0; effects.length = 0; cleanups.length = 0; mounted = false },
    state(initial: any) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    ref(value: any) { const i = index++; if (!(i in slots)) slots[i] = { current: value }; return slots[i] },
    effect(fn: () => void | (() => void)) { if (!mounted) effects.push(fn) },
  }
})
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useContext: () => undefined, useState: host.state, useRef: host.ref, useEffect: host.effect, useCallback: (fn: unknown) => fn }))
import { beforeEach } from 'vitest'
import { api } from '../api'
import { LiveResidentsSettings } from './LiveResidentsSettings'
const nodes = (node: any): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : []
const render = () => { host.begin(); const tree = LiveResidentsSettings(); host.commit(); return tree }
const clickResident = (tree: ReactElement<any>, name: string) => nodes(tree).find(n => n.type === 'button' && n.props['aria-label'] === `让 ${name} 出场`)!
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const control = { resident: 'gpt' as const, mode: 'auto' as const, interval_seconds: 120 as const, anchor: '2026-11-11T00:00:00Z' }
const note = { doing: '', thinking: '', contact: '', updated_at: '', resident_control: control }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse(control.anchor)); vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn() }) })
afterEach(() => { host.reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
describe('居民出场设置的反馈与恢复', () => {
 it('读取失败时不能以默认值覆盖，重新读取成功才开放七位选择', async () => {
  vi.spyOn(api, 'liveNote').mockRejectedValueOnce(new Error('合成读取失败')).mockResolvedValueOnce(note)
  const write = vi.spyOn(api, 'setLiveResidents')
  render(); await flush()
  let tree = render()
  expect(nodes(tree).find(n => n.type === 'fieldset')!.props.disabled).toBe(true)
  clickResident(tree, 'Claude').props.onClick(); await flush()
  expect(write).not.toHaveBeenCalled()
  nodes(tree).find(n => n.type === 'button' && n.props.children === '重新读取出场设置')!.props.onClick(); await flush()
  tree = render()
  expect(nodes(tree).find(n => n.type === 'fieldset')!.props.disabled).toBe(false)
  expect(nodes(tree).filter(n => n.type === 'button' && n.props['aria-label']?.startsWith('让 '))).toHaveLength(7)
 })
 it('慢请求去重，未收到确认不自动重写；重新读取可以确认服务端已切换的角色', async () => {
  const claude = { ...control, resident: 'claude' as const }
  vi.spyOn(api, 'liveNote').mockResolvedValueOnce(note).mockResolvedValueOnce({ ...note, resident_control: claude })
  let reject!: (e: Error) => void
  const write = vi.spyOn(api, 'setLiveResidents').mockImplementation(() => new Promise((_, fail) => { reject = fail }))
  render(); await flush()
  const click = clickResident(render(), 'Claude').props.onClick
  click(); click()
  expect(write).toHaveBeenCalledOnce()
  expect(write).toHaveBeenCalledWith({ resident: 'claude', mode: 'auto', interval_seconds: 120 })
  expect(nodes(render()).find(n => n.type === 'fieldset')!.props.disabled).toBe(true)
  reject(new Error('合成回执中断')); await flush()
  let tree = render()
  expect(renderToStaticMarkup(tree)).toContain('未能确认出场设置')
  nodes(tree).find(n => n.type === 'button' && n.props.children === '重新读取出场设置')!.props.onClick(); await flush()
  tree = render()
  expect(clickResident(tree, 'Claude').props['aria-pressed']).toBe(true)
  expect(write).toHaveBeenCalledOnce()
 })
})
