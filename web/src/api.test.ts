import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

const respond = (status: number, body: string, type = 'application/json') =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': type } })))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError)
    return e as ApiError
  }
  throw new Error('expected ApiError')
}

describe('api error handling', () => {
  it('recognises a JSON 401 as unauthorized', async () => {
    respond(401, '{"error":"unauthorized"}\n')
    const e = await failure(api.snapshot())
    expect(e.status).toBe(401)
    expect(e.message).toBe('unauthorized')
  })
  it('keeps JSON error details on 403', async () => {
    respond(403, '{"error":"missing X-Steward header"}')
    const e = await failure(api.scanMerges())
    expect(e.status).toBe(403)
    expect(e.message).toBe('missing X-Steward header')
  })
  it('keeps the error payload for callers that read extra fields', async () => {
    respond(409, '{"error":"dirty","dirty":["a.txt"]}')
    const e = await failure(api.archiveManaged('m1'))
    expect(e.data.dirty).toEqual(['a.txt'])
  })
  it('turns a plain-text error into ApiError with its status', async () => {
    respond(401, 'unauthorized\n', 'text/plain; charset=utf-8')
    const e = await failure(api.snapshot())
    expect(e.status).toBe(401)
    expect(e.message).toBe('unauthorized')
  })
  it('turns a proxy HTML error page into ApiError instead of SyntaxError', async () => {
    respond(502, '<html><body>Bad Gateway</body></html>', 'text/html')
    const e = await failure(api.snapshot())
    expect(e.status).toBe(502)
    expect(e.message).toContain('Bad Gateway')
  })
  it('rejects a non-JSON success body', async () => {
    respond(200, '<!doctype html><html></html>', 'text/html')
    const e = await failure(api.snapshot())
    expect(e.status).toBe(200)
  })
  it('falls back to the status when an error body is empty', async () => {
    respond(500, '')
    const e = await failure(api.snapshot())
    expect(e.status).toBe(500)
    expect(e.message).not.toBe('')
  })
  it('returns parsed JSON and treats an empty success body as {}', async () => {
    respond(200, '{"ok":true}')
    await expect(api.scanMerges()).resolves.toEqual({ ok: true })
    respond(200, '')
    await expect(api.scanMerges()).resolves.toEqual({})
  })
})
