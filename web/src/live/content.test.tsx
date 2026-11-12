import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveNote, PublicLiveContent } from '../api'
import { demoSnapshot } from '../town/fixtures'
import { LiveScreen } from './LiveView'
import { contentAt, publicLiveContent } from './content'
import { createLiveFeed } from './feed'
import { contentProblem } from './LiveContentSettings'

const anchor = '2026-11-12T00:00:00Z'
const content: PublicLiveContent = { playing: true, interval_seconds: 20, selected_id: 'a', anchor, focus: 'town', items: [
  { id: 'a', source: 'kuangye', title: '旷野之心的公开想法', body: '旷野之心的一段合成正文', credit: '来自旷野之心' },
  { id: 'b', source: 'shufang', title: '合成阅读笔记', body: '一张独立公开卡', credit: '合成出处' },
] }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe('小镇放映角', () => {
  it('随机窗口断网后停在最后一句，重新读取无缝接上；手动清单仍循环', () => {
    const random: PublicLiveContent = { ...content, mode: 'random' }
    const now = Date.parse(anchor)
    expect(contentAt(random, now + 60_000).item?.id).toBe('b')
    expect(contentAt(random, now + 86400_000).item?.id).toBe('b')
    expect(contentAt(random, now + 86400_000).progress).toBe(1)
    expect(contentAt(content, now + 40_000).item?.id).toBe('a')
    expect(publicLiveContent({ ...random, random_seed: 'SECRET', pool: ['PRIVATE'] })).toEqual(random)
    expect(publicLiveContent({ ...random, mode: 'other' })).toBeUndefined()
    const nextWindow = { ...random, anchor: '2026-11-12T00:00:20Z', selected_id: 'b', items: [content.items[1]] }
    expect(contentAt(nextWindow, now + 20_000).item).toEqual(contentAt(random, now + 20_000).item)
  })
  it('随机摘句在横竖屏都只呈现短句与主题，没有原库名字和误导的窗口页码', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(anchor))
    const random: PublicLiveContent = { ...content, mode: 'random', items: [{ id: 'synthetic', source: 'kuangye', title: '合成的思考：选择的边界，在哪里？', body: '', credit: '摘句', topic: 'thinking' }], selected_id: 'synthetic' }
    for (const layout of ['portrait', 'landscape'] as const) {
      const html = renderToStaticMarkup(<LiveScreen snap={demoSnapshot} note={{ doing: '', thinking: '', contact: '', presentation: 'studio', content: random, updated_at: '' }} stale={false} bubble={null} layout={layout} />)
      expect(html).toContain('合成的思考'); expect(html).toContain('偶然读到'); expect(html).toContain('认知与思维')
      for (const hidden of ['旷野之心', 'Morris', '01 /', '<button', '<input']) expect(html).not.toContain(hidden)
    }
  })
  it('阅读来源在横竖屏和两种重心中都只显示中性标题，不附带书名或来源提示', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(anchor))
    const reading: PublicLiveContent = { ...content, items: [{ id: 'reading', source: 'kuangye', title: '合成阅读标题', body: '合成阅读摘意', credit: '阅读摘意 · 非逐字原文' }], selected_id: 'reading' }
    for (const layout of ['portrait', 'landscape'] as const) for (const focus of ['town', 'reading'] as const) {
      const html = renderToStaticMarkup(<LiveScreen snap={demoSnapshot} note={{ doing: '', thinking: '', contact: '', presentation: 'studio', content: { ...reading, focus }, updated_at: '' }} stale={false} bubble={null} layout={layout} />)
      expect(html).toContain('随读片段'); expect(html).toContain('合成阅读标题'); expect(html).toContain('阅读摘意 · 非逐字原文')
      for (const hidden of ['旷野之心', '想法便笺', 'Morris', '来源：']) expect(html).not.toContain(hidden)
    }
  })
  it('编辑器按字符校验，允许空草稿，不能把未填好的卡片确认为公开', () => {
    const draft = { ...content, revision: '', sources: ['compass'] as const, items: [{ ...content.items[0], enabled: true, approved: false }] }
    expect(contentProblem({ ...draft, sources: [...draft.sources], items: [{ ...draft.items[0], title: '', body: '' }] })).toBe('')
    expect(contentProblem({ ...draft, sources: [...draft.sources], items: [{ ...draft.items[0], title: '', approved: true }] })).toContain('缺少标题')
    expect(contentProblem({ ...draft, sources: [...draft.sources], items: [{ ...draft.items[0], title: '字'.repeat(49) }] })).toContain('48 字')
    expect(contentProblem({ ...draft, sources: [...draft.sources], items: [{ ...draft.items[0], credit: 'a\nb' }] })).toContain('不能包含换行')
  })
  it('横屏从完整渲染结果移除特定品牌，竖屏保留；两种布局和重心都只展示脱敏数据、没有操作入口', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(anchor))
    const note: LiveNote = { presentation: 'studio', doing: '旷野之心的夜晚', thinking: '旷野之心', contact: '旷野之心留言', content, updated_at: '', resident_control: { resident: 'claude', mode: 'fixed', interval_seconds: 120, anchor } }
    const snap = { ...demoSnapshot, repos: demoSnapshot.repos!.map(r => ({ ...r, name: 'PRIVATE_CANARY', common_dir: '/Users/private/canary' })) }
    for (const layout of ['portrait', 'landscape'] as const) for (const focus of ['town', 'reading'] as const) {
      const html = renderToStaticMarkup(<LiveScreen snap={snap} note={{ ...note, content: { ...content, focus } }} stale={false} bubble={null} layout={layout} recent={{ key: '1', kind: 'started', repoId: 1, text: '旷野之心的公开动态' }} />)
      expect(html).toContain('studio-scene'); expect(html).toContain('town-svg'); expect(html).toContain('Claude')
      expect(html).toContain(layout === 'landscape' ? '想法便笺' : '旷野之心')
      for (const hidden of ['PRIVATE_CANARY', '/Users/private', '<button', '<a ', '<input', '<textarea', 'tabindex', 'role="button"', '<iframe']) expect(html).not.toContain(hidden)
      if (layout === 'landscape') expect(html).not.toContain('旷野之心')
    }
  })
  it('公共解析器拒绝不合法卡片，只重建已有字段，两个窗口用同一时钟换页', () => {
    const safe = publicLiveContent({ ...content, revision: 'SECRET', items: content.items.map(i => ({ ...i, draft: 'SECRET', path: '/private' })) })
    expect(JSON.stringify(safe)).not.toContain('SECRET'); expect(JSON.stringify(safe)).not.toContain('/private')
    const now = Date.parse(anchor)
    expect(contentAt(safe, now + 19_000).item?.id).toBe('a')
    expect(contentAt(safe, now + 20_000).item?.id).toBe('b')
    expect(contentAt(safe, now + 40_000).item?.id).toBe('a')
    expect(contentAt({ ...content, playing: false, selected_id: 'b' }, now + 86400_000).item?.id).toBe('b')
    expect(publicLiveContent({ ...content, interval_seconds: 0 })).toBeUndefined()
    expect(publicLiveContent({ ...content, items: [{ ...content.items[0], source: 'private-path' }] })).toBeUndefined()
    expect(publicLiveContent({ ...content, items: [content.items[0], content.items[0]] })).toBeUndefined()
  })
  it('空清单与连接失败不编造作品或正在生产的任务，页面不读写本地存储', () => {
    const storage = { getItem: vi.fn(() => { throw new Error('must not read') }), setItem: vi.fn(() => { throw new Error('must not write') }) }
    vi.stubGlobal('localStorage', storage)
    const html = renderToStaticMarkup(<LiveScreen snap={demoSnapshot} note={{ doing: '', thinking: '', contact: '', presentation: 'studio', updated_at: '' }} stale bubble={null} layout="landscape" />)
    expect(html).toContain('把日子，过成'); expect(html).toContain('重新连接')
    expect(html).not.toContain('正在制作短片'); expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled()
  })
  it('公开轮播仍只请求两个只读接口', async () => {
    const paths: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (path: string) => { paths.push(path); return { ok: true, json: async () => path.endsWith('snapshot') ? demoSnapshot : { doing: '', thinking: '', contact: '', presentation: 'studio', content, updated_at: '' } } }))
    const feed = createLiveFeed({ onState: () => {}, timers: { set: () => 1, clear: () => {} } })
    feed.start(); for (let i = 0; i < 12; i++) await Promise.resolve()
    expect(paths.sort()).toEqual(['/api/live/note', '/api/live/snapshot'])
    expect(feed.state.note?.content?.items).toHaveLength(2); feed.stop()
  })
})
