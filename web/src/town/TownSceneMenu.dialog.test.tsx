import { beforeEach, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// This file also exercises actual trigger/radio/cancel/apply callbacks. Native
// focus containment remains covered by useNativeDialog tests and browser QA.
const host = vi.hoisted(() => {
  const contexts = new Map<string, { index: number; slots: { current: any }[] }>()
  let active: { index: number; slots: { current: any }[] }
  return {
    reset() { contexts.clear() },
    begin(name: string) { if (!contexts.has(name)) contexts.set(name, { index: 0, slots: [] }); active = contexts.get(name)!; active.index = 0 },
    ref(initial: any) { const index = active.index++; return active.slots[index] ?? (active.slots[index] = { current: initial }) },
    id() { const index = active.index++; return (active.slots[index] ?? (active.slots[index] = { current: `synthetic-scene-${index}` })).current },
  }
})
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useRef: host.ref, useId: host.id, useEffect: () => {} }))
import { TownSceneMenu } from './TownSceneMenu'
import { APPEARANCE_KEY, createAppearanceStore, readAppearance, TOWN_THEMES } from './appearance'

type Node = ReactElement<any>
const nodes = (node: any): Node[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : []
const words = (node: any): string => Array.isArray(node) ? node.map(words).join('') : typeof node === 'string' ? node : node?.props ? words(node.props.children) : ''
beforeEach(() => { host.reset(); host.begin('ssr') })

it.each(TOWN_THEMES)('当前为$name时首屏只有明确画风入口，完整选择仍在对话框中', theme => {
  const store = createAppearanceStore(undefined, `?town-art=${theme.id}`, async () => {})
  const appearance = { ...store.getSnapshot(), preview: store.preview, cancel: store.cancel, apply: store.apply }
  const html = renderToStaticMarkup(<TownSceneMenu appearance={appearance} open={false} onOpenChange={() => {}} />)
  expect(html.match(/<button\b/g)).toHaveLength(1)
  expect(html).toContain(`aria-label="画风：${theme.name}"`)
  expect(html).toContain('aria-haspopup="dialog" aria-expanded="false"')
  expect(html).not.toContain('<dialog')
  expect(html).not.toContain('role="radio"')
})

it('六种画风预览使用原生模态层，保留单选语义与确认/取消入口',()=> {
  const store=createAppearanceStore(undefined,'',async()=>{})
  const appearance={...store.getSnapshot(),preview:store.preview,cancel:store.cancel,apply:store.apply}
  const html=renderToStaticMarkup(<TownSceneMenu appearance={appearance} open onOpenChange={()=>{}} />)
  expect(html).toContain('<dialog ')
  expect(html).toContain('role="dialog" aria-modal="true"')
  // showModal, rather than an open attribute, supplies native background inertness and Tab containment.
  expect(html).not.toMatch(/<dialog[^>]*\sopen(?:=|\s|>)/)
  expect(html.match(/role="radio"/g)).toHaveLength(6)
  for(const theme of TOWN_THEMES) expect(html).toContain(`data-scene-id="${theme.id}"`)
  expect(html).toContain('使用并记住')
  expect(html).toContain('关闭场景菜单，取消预览')
})

function interactive() {
  const values = new Map([[APPEARANCE_KEY, '{"version":1,"theme":"miniature"}']])
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const store = createAppearanceStore(storage, '', async () => {})
  const preview = vi.fn(store.preview), cancel = vi.fn(store.cancel), apply = vi.fn(store.apply)
  const onOpenChange = vi.fn((next: boolean) => { open = next })
  const trigger = { focus: vi.fn(), isConnected: true }
  let open = false
  const menu = () => {
    host.begin('menu')
    return TownSceneMenu({ appearance: { ...store.getSnapshot(), preview, cancel, apply }, open, onOpenChange })
  }
  const panel = () => {
    const child = nodes(menu()).find(node => typeof node.type === 'function' && node.type.name === 'SceneDialog')!
    host.begin('dialog')
    return (child.type as (props: any) => Node)(child.props)
  }
  const enter = () => { nodes(menu()).find(node => node.type === 'button')!.props.onClick({ currentTarget: trigger }) }
  const choose = async (id: string) => {
    nodes(panel()).find(node => node.props['data-scene-id'] === id)!.props.onClick()
    await preview.mock.results.at(-1)!.value
  }
  const press = (label: string) => nodes(panel()).find(node => node.type === 'button' && words(node) === label)!.props.onClick()
  return { store, storage, preview, cancel, apply, trigger, menu, panel, enter, choose, press, onOpenChange, isOpen: () => open }
}

it('从唯一入口预览后取消：恢复原画风、不写偏好并返回入口焦点', async () => {
  const ui = interactive()
  ui.enter(); expect(ui.isOpen()).toBe(true)
  await ui.choose('cozy-night')
  expect(ui.store.getSnapshot().theme).toBe('cozy-night')
  expect(readAppearance(ui.storage)).toBe('miniature')
  expect(nodes(ui.panel()).filter(node => node.props.role === 'radio')).toHaveLength(6)
  ui.press('取消')
  expect(ui.cancel).toHaveBeenCalledExactlyOnceWith('miniature')
  expect(ui.store.getSnapshot().theme).toBe('miniature')
  expect(readAppearance(ui.storage)).toBe('miniature')
  expect(ui.isOpen()).toBe(false)
  expect(ui.trigger.focus).toHaveBeenCalledOnce()
})

it('使用并记住保存选择，收起后入口显示新画风且重新打开仍选择它', async () => {
  const ui = interactive()
  ui.enter(); await ui.choose('storybook-day')
  ui.press('使用并记住')
  expect(ui.apply).toHaveBeenCalledOnce()
  expect(readAppearance(ui.storage)).toBe('storybook-day')
  expect(ui.isOpen()).toBe(false)
  expect(nodes(ui.menu()).find(node => node.type === 'button')!.props['aria-label']).toBe('画风：清新绘本')
  expect(ui.trigger.focus).toHaveBeenCalledOnce()
  ui.enter()
  const radios = nodes(ui.panel()).filter(node => node.props.role === 'radio')
  expect(radios).toHaveLength(6)
  expect(radios.filter(node => node.props.tabIndex === 0).map(node => node.props['data-scene-id'])).toEqual(['storybook-day'])
})

it('原生取消事件只关闭画风预览，并恢复基线与入口', async () => {
  const ui = interactive()
  ui.enter(); await ui.choose('ai-studio')
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
  ui.panel().props.onCancel(event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(event.stopPropagation).toHaveBeenCalledOnce()
  expect(ui.isOpen()).toBe(false)
  expect(ui.store.getSnapshot().theme).toBe('miniature')
  expect(ui.trigger.focus).toHaveBeenCalledOnce()
})

it('六种选择继续支持方向键预览并把焦点移到对应选项', async () => {
  const ui = interactive()
  ui.enter()
  const panel = ui.panel(), focus = vi.fn(), querySelector = vi.fn(() => ({ focus }))
  panel.props.ref.current = { querySelector }
  const preventDefault = vi.fn()
  nodes(panel).find(node => node.props.role === 'radiogroup')!.props.onKeyDown({ key: 'ArrowRight', preventDefault, target: { closest: () => ({ dataset: { sceneId: 'miniature' } }) } })
  await ui.preview.mock.results.at(-1)!.value
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(querySelector).toHaveBeenCalledExactlyOnceWith('[data-scene-id="storybook"]')
  expect(focus).toHaveBeenCalledOnce()
  expect(ui.store.getSnapshot().theme).toBe('storybook')
  expect(readAppearance(ui.storage)).toBe('miniature')
})
