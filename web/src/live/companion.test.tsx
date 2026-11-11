import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveScreen } from './LiveView'
import { demoSnapshot } from '../town/fixtures'
import { activeCompanionAction, COMPANION_ACTION_MS, livePresentation, publicCompanionAction, requestedPresentation } from './companion'
import { createLiveFeed } from './feed'

afterEach(() => vi.unstubAllGlobals())
describe('陪伴与真实小镇的展示', () => {
 it('右上角信息与下方真实小镇同屏，无控制入口或私人字段；两种布局均可用', () => {
  const snap = { ...demoSnapshot, repos: demoSnapshot.repos!.map(r => ({ ...r, name: 'PRIVATE_PROJECT_CANARY', common_dir: '/Users/private/canary' })) }
  for (const layout of ['portrait', 'landscape'] as const) {
   const html = renderToStaticMarkup(<LiveScreen snap={snap} note={{ doing: '公开主题', thinking: '公开思考', contact: '在直播间留言', presentation: 'companion', updated_at: '' }} stale={false} bubble={null} recent={{ key: 'synthetic', kind: 'started', repoId: 1, text: '一位助手开始干活' }} layout={layout} />)
   for (const shown of ['小镇刚刚发生', '给团子留句话', '现有小镇实况', '一位助手开始干活', '公开主题', '公开思考', '在直播间留言', 'town-svg', '项目 A', '/residents/gpt/idle.webp']) expect(html).toContain(shown)
   for (const hidden of ['PRIVATE_PROJECT_CANARY', '/Users/private', '<button', '<a ', '<input', '<textarea', 'tabindex', '<iframe']) expect(html).not.toContain(hidden)
  }
  const town = renderToStaticMarkup(<LiveScreen snap={snap} note={{ doing: '', thinking: '', contact: '', presentation: 'town', updated_at: '' }} stale={false} bubble={null} layout="portrait" />)
  expect(town).not.toContain('companion-hero')
  expect(town).toContain('town-svg')
 })
 it('首次加载和断线不编造进展，不把团子动作算成真实工作', () => {
  const html = renderToStaticMarkup(<LiveScreen snap={null} note={null} stale bubble={null} layout="portrait" />)
  expect(html).toContain('正在连接小镇')
  expect(html).toContain('小镇画面正在重连')
  expect(html).not.toContain('完成一项交付')
 })
 it('动作严格白名单，过期动作与未来时间不重播，预览布局也只接受枚举', () => {
  const now = Date.parse('2026-11-11T20:00:00Z')
  const a = { id: 'a'.repeat(32), kind: 'walk', at: new Date(now).toISOString() }
  expect(activeCompanionAction(a, now)?.kind).toBe('walk')
  expect(activeCompanionAction(a, now + COMPANION_ACTION_MS)).toBeNull()
  expect(activeCompanionAction(a, now - 1)).toBeNull()
  expect(publicCompanionAction({ ...a, kind: 'approve', text: 'private' })).toBeUndefined()
  expect(publicCompanionAction({ ...a, id: '/Users/private' })).toBeUndefined()
  expect(publicCompanionAction({ ...a, text: 'private' })).toEqual(a)
  expect(livePresentation('__proto__')).toBe('companion')
  expect(requestedPresentation('?live-layout=town')).toBe('town')
  expect(requestedPresentation('?live-layout=<script>')).toBeNull()
 })
 it('OBS 数据只请求两个只读接口，动作响应不会夹带其他字段', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { calls.push(path); return { ok: true, json: async () => path.endsWith('snapshot') ? demoSnapshot : { doing: '公开', private: 'canary', companion: { id: 'a'.repeat(32), kind: 'home', at: '2026-11-11T20:00:00Z', private: 'canary' } } } }))
  const f = createLiveFeed({ onState: () => {}, timers: { set: () => 1, clear: () => {} } })
  f.start()
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(calls.sort()).toEqual(['/api/live/note', '/api/live/snapshot'])
  expect(JSON.stringify(f.state)).not.toContain('canary')
  expect(f.state.note?.companion?.kind).toBe('home')
  f.stop()
 })
})
