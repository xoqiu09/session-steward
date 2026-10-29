import { describe, expect, it } from 'vitest'
import { conversationURL, processingSession } from './conversationModel'
import { synthSnapshot } from './fixtures'

const uuid = '11111111-2222-4333-8444-555555555555'
describe('original conversation selection', () => {
  it('prefers the notification request owner and rejects a different work item', () => {
    const s = structuredClone(synthSnapshot), item = s.work_items![0]
    expect(processingSession(s, item)?.id).toBe(88)
    expect(processingSession(s, item, 87)?.id).toBe(87)
    expect(processingSession(s, item, 90)?.id).toBe(88)
  })
  it('returns no session when the item is unbound', () => {
    const s = structuredClone(synthSnapshot); s.sessions = []
    expect(processingSession(s, s.work_items![0])).toBeNull()
  })
  it('accepts only matching desktop conversation URLs', () => {
    const codex = { ...synthSnapshot.sessions![2], client: 'desktop', provider_session_id: uuid }
    const link = `codex://threads/${uuid}`
    expect(conversationURL(codex, link)).toBe(link)
    for (const bad of ['https://example.invalid', `${link}?command=run`, `${link}#anything`, link.replace('11111111', '99999999'), 'claude://code/continue?session=local_test']) expect(conversationURL(codex, bad)).toBeNull()
    expect(conversationURL({ ...codex, client: 'cli' }, link)).toBeNull()
    const claude = { ...codex, provider: 'claude' }
    for (const valid of [`claude://resume?session=${uuid}`, 'claude://code/continue?session=local_synthetic']) expect(conversationURL(claude, valid)).toBe(valid)
    expect(conversationURL(claude, 'claude://code/continue?session=local_synthetic&command=run')).toBeNull()
  })
})
