import { expect, it } from 'vitest'
import { mergeSyncText } from './Queue'

const now = '2026-10-31T03:00:00Z'

it('没核对过、核对成功、核对失败分别说清楚', () => {
  expect(mergeSyncText(undefined, 'main', now)).toMatchObject({ warn: false })
  expect(mergeSyncText(undefined, 'main', now).text).toContain('还没有去远端核对过')
  const ok = mergeSyncText({ repo_id: 1, state: 'checked', checked_at: '2026-10-31T02:58:00Z', remote: 'origin', target_ref: 'main', target_sha: 'x' }, 'main', now)
  expect(ok.warn).toBe(false)
  expect(ok.text).toContain('main里还没有这组改动')
  const failed = mergeSyncText({ repo_id: 1, state: 'failed', checked_at: '2026-10-31T02:58:00Z', remote: 'origin', target_ref: 'main', target_sha: '', error: '读取远端超时（超过 45 秒），稍后会自动重试', failures: 3, last_ok: '2026-10-30T03:00:00Z' }, 'main', now)
  expect(failed.warn).toBe(true)
  expect(failed.text).toContain('连续 3 次')
  expect(failed.text).toContain('超时')
  expect(failed.text).toContain('上次成功')
})
