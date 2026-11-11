import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

afterEach(() => vi.unstubAllGlobals())
describe('解绑 API 身份契约', () => {
  it('将已观察的运行与工作项一并发送', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await api.unbind(88, 'delivered', { expected_run_id: 3, expected_work_item_id: 'SYN-12' })
    expect(fetch).toHaveBeenCalledWith('/api/sessions/88/unbind', expect.objectContaining({ method: 'POST', body: JSON.stringify({ outcome: 'delivered', expected_run_id: 3, expected_work_item_id: 'SYN-12' }) }))
  })
  it('保留服务端身份冲突的恢复说明，不自动重试', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"error":"会话绑定或运行已变化，请刷新后重新选择；未结束任何运行"}', { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    await expect(api.unbind(88, 'delivered', { expected_run_id: 3, expected_work_item_id: 'SYN-12' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('刷新后重新选择') })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
