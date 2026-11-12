import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { LiveContent } from '../api'

// Use the same hook harness as the other live settings tests; no extra browser dependency.
const host = vi.hoisted(() => {
  let index = 0, mounted = false
  const slots: any[] = [], effects: (() => void | (() => void))[] = [], cleanups: (() => void)[] = []
  return {
    begin() { index = 0 },
    commit() { if (!mounted) { mounted = true; effects.forEach(fn => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) }) } },
    reset() { cleanups.forEach(fn => fn()); slots.length = 0; effects.length = 0; cleanups.length = 0; mounted = false },
    state(initial: any) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    ref(value: any) { const i = index++; if (!(i in slots)) slots[i] = { current: value }; return slots[i] },
    effect(fn: () => void | (() => void)) { if (!mounted) effects.push(fn) },
  }
})
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: host.state, useRef: host.ref, useEffect: host.effect }))
import { api } from '../api'
import { LiveContentSettings } from './LiveContentSettings'

const nodes = (node: any): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : []
const render = () => { host.begin(); const tree = LiveContentSettings({ onDirty: () => {}, onBusy: () => {} }); host.commit(); return tree }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const fixture: LiveContent = { revision: 'synthetic', playing: true, interval_seconds: 40, focus: 'town', selected_id: 'a', anchor: '', sources: ['kuangye'], items: [{ id: 'a', source: 'kuangye', title: '合成标题', body: '合成正文', credit: '合成出处', enabled: true, approved: true }] }
afterEach(() => { host.reset(); vi.restoreAllMocks() })

describe('公开卡片的主题选择', () => {
  it('改联动小屋后需要重新确认，保存保留原文案、来源过滤和播放节奏', async () => {
    vi.spyOn(api, 'liveContent').mockResolvedValue(structuredClone(fixture))
    const write = vi.spyOn(api, 'saveLiveContent').mockImplementation(async input => input)
    render(); await flush()
    let tree = render()
    const select = nodes(tree).find(n => n.type === 'select' && n.props['aria-label'] === '内容 1 的联动小屋')!
    expect(nodes(select).filter(n => n.type === 'option')).toHaveLength(14)
    select.props.onChange({ target: { value: 'emotion' } })
    tree = render()
    const label = nodes(tree).find(n => n.type === 'label' && n.props.children?.includes?.('我已检查内容，可以公开'))!
    const approval = nodes(label).find(n => n.type === 'input')!
    expect(approval.props.checked).toBe(false)
    expect(write).not.toHaveBeenCalled()
    approval.props.onChange({ target: { checked: true } })
    tree = render()
    const save = nodes(tree).find(n => n.type === 'button' && n.props.children === '保存公开清单')!
    expect(save.props.disabled).toBe(false)
    save.props.onClick(); await flush()
    expect(write).toHaveBeenCalledWith({ ...fixture, items: [{ ...fixture.items[0], topic: 'emotion' }] }, 'save')
  })
})
