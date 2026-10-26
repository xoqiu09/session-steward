import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import TownScene, { TownChips, TownLegend, type Selection } from './TownScene'
import { buildTown } from './townModel'
import { demoSnapshot, fakeSession } from './fixtures'
import type { Snapshot } from '../types'

const render = (snap: Snapshot, opts: { selected?: Selection | null; offline?: boolean; changed?: Set<string> } = {}) =>
  renderToStaticMarkup(<TownScene model={buildTown(snap)} selected={opts.selected ?? null} highlight={null} onSelect={() => {}} offline={opts.offline} changed={opts.changed} />)

describe('TownScene', () => {
  test('画出建筑、角色、包裹、告示卡和验收台', () => {
    const html = render(demoSnapshot)
    expect(html).toContain('项目建筑 pixel-ledger')
    expect(html).toContain('Codex #21，等你决定')
    expect((html.match(/town-parcel/g) ?? []).length).toBe(7)
    expect(html).toContain('待决定 A-1')
    expect(html).toContain('只有你能验收 · 1 件待验收')
    expect(html).not.toContain('另有')
  })

  test('包裹按 run id 固定顺序渲染', () => {
    const ids = [...render(demoSnapshot).matchAll(/运行 #(\d+)/g)].map((m) => Number(m[1]))
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
  })

  test('一栋超过 3 个会话时只画前 3 个，并标出另有几位', () => {
    const extra = [51, 52].map((id) => fakeSession({ id, provider: 'codex', state: 'running', repo_id: 1 }))
    const html = render({ ...demoSnapshot, sessions: [...demoSnapshot.sessions!, ...extra] })
    expect(html).toContain('Codex #51')
    expect(html).not.toContain('Codex #52，')
    expect(html).toContain('另有 1 位')
    expect(html).toContain('另有 1 个会话不在画面中')
  })

  test('超过 3 个项目时提示去列表视图', () => {
    const repos = [...demoSnapshot.repos!, { id: 4, name: 'extra-repo', common_dir: '', is_git: true, target_ref: 'main' }]
    const sessions = [...demoSnapshot.sessions!, fakeSession({ id: 60, provider: 'claude', state: 'running', repo_id: 4 })]
    expect(render({ ...demoSnapshot, repos, sessions })).toContain('另有 1 个项目在列表视图')
  })

  test('长项目名在招牌上截断，全名留在 aria-label', () => {
    const name = 'an-extremely-long-repository-name-for-testing'
    const repos = demoSnapshot.repos!.map((r) => (r.id === 1 ? { ...r, name } : r))
    const html = render({ ...demoSnapshot, repos })
    expect(html).toContain(`项目建筑 ${name}`)
    expect(html).toContain('>an-extremely-long…</text>')
  })

  test('断线时场景变灰，工作中改称断线前', () => {
    const html = render(demoSnapshot, { offline: true })
    expect(html).toContain('town-svg is-offline')
    expect(html).toContain('断线前·工作中')
  })

  test('选中与刚变化的对象带上对应 class', () => {
    const html = render(demoSnapshot, { selected: { kind: 'character', key: 'session-22' }, changed: new Set(['run-202']) })
    expect(html).toMatch(/town-char is-working is-selected/)
    expect(html).toMatch(/town-parcel is-moving is-changed/)
  })

  test('图例与状态按钮', () => {
    expect(renderToStaticMarkup(<TownLegend />)).toContain('角色 = 一个会话')
    const chips = renderToStaticMarkup(<TownChips counts={buildTown(demoSnapshot).counts} highlight="waiting" onHighlight={() => {}} />)
    expect(chips).toContain('town-chip is-waiting is-on')
    expect(chips).toMatch(/等你决定<b>2<\/b>/)
  })
})

describe('TownScene 分页与竖屏', () => {
  test('传入本页建筑时只画这几栋，退件架和验收台仍汇总全部项目', () => {
    const model = buildTown(demoSnapshot)
    const page = model.buildings.filter((b) => b.name === 'town-workshop')
    const html = renderToStaticMarkup(<TownScene model={model} buildings={page} selected={null} highlight={null} onSelect={() => {}} />)
    expect(html).toContain('项目建筑 town-workshop')
    expect(html).not.toContain('项目建筑 pixel-ledger')
    expect(html).toContain('退件架：1 个失败运行')
    expect(html).toContain('待决定 A-1')
    expect(html).not.toContain('另有')
  })

  test('竖屏版式只框住一栋，视野随告示卡片数变高', () => {
    const model = buildTown(demoSnapshot)
    const html = renderToStaticMarkup(<TownScene model={model} layout="portrait" selected={null} highlight={null} onSelect={() => {}} />)
    expect(html).toContain('town-svg is-portrait')
    expect((html.match(/项目建筑 /g) ?? []).length).toBe(1)
    const height = (m: typeof model) => Number(/viewBox="-222 -100 392 (\d+)"/.exec(renderToStaticMarkup(<TownScene model={m} layout="portrait" selected={null} highlight={null} onSelect={() => {}} />))![1])
    expect(height({ ...model, pendingApprovals: [] })).toBeLessThan(height(model))
  })
})
