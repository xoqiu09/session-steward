import { expect, it } from 'vitest'
import { panelScope } from './panelScope'

it('daily inbox and history use the same whole-device scope without modifying the saved selection', () => {
  for (const view of ['today', 'history'] as const) {
    expect(panelScope(view, 42, 'codex', 'selected text', true)).toMatchObject({ global: true, repoId: 'all', provider: 'all', query: '', showDone: false })
  }
  expect(panelScope('town', 42, 'codex', 'selected text', true)).toMatchObject({ global: false, repoId: 42, provider: 'codex', query: '', showDone: false })
  expect(panelScope('list', 42, 'codex', 'selected text', true)).toMatchObject({ repoId: 42, provider: 'codex', query: 'selected text', showDone: true })
})
