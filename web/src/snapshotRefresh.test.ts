import { describe, expect, it, vi } from 'vitest'
import { snapshotRefresher } from './snapshotRefresh'
import type { Snapshot } from './types'

const snap = (cursor: number) => ({ cursor } as Snapshot)
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

describe('snapshot refresh ordering', () => {
  it('coalesces changes during a slow request and reads again before finishing', async () => {
    const first = deferred<Snapshot>(), second = deferred<Snapshot>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const apply = vi.fn(), failed = vi.fn()
    const reader = snapshotRefresher(load, apply, failed)
    const pending = reader.request(); void reader.request(); void reader.request()
    expect(load).toHaveBeenCalledTimes(1)
    first.resolve(snap(1)); await Promise.resolve(); await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    second.resolve(snap(2)); await pending
    expect(apply.mock.calls.map(x => x[0].cursor)).toEqual([1, 2])
    expect(failed).not.toHaveBeenCalled()
  })
  it('never overwrites a newer snapshot with an older response', async () => {
    const load = vi.fn().mockResolvedValueOnce(snap(20)).mockResolvedValueOnce(snap(19))
    const apply = vi.fn(); const reader = snapshotRefresher(load, apply, vi.fn())
    await reader.request(); await reader.request()
    expect(apply).toHaveBeenCalledTimes(1)
  })
  it('a reset discards an outstanding old response and accepts the new lower cursor', async () => {
    const old = deferred<Snapshot>(), apply = vi.fn()
    const load = vi.fn().mockResolvedValueOnce(snap(20)).mockReturnValueOnce(old.promise).mockResolvedValueOnce(snap(1))
    const reader = snapshotRefresher(load, apply, vi.fn())
    await reader.request(); const pending = reader.request(); void reader.reset()
    old.resolve(snap(21)); await pending
    expect(apply.mock.calls.map(x => [x[0].cursor, x[1]])).toEqual([[20, false], [1, true]])
  })
  it('keeps the existing state on failure and stops delivery after unmount', async () => {
    const next = deferred<Snapshot>(), failed = vi.fn(), apply = vi.fn()
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(next.promise)
    const reader = snapshotRefresher(load, apply, failed)
    await reader.request(); expect(failed).toHaveBeenCalledTimes(1)
    const pending = reader.request(); reader.dispose(); next.resolve(snap(2)); await pending; await reader.request()
    expect(apply).not.toHaveBeenCalled(); expect(load).toHaveBeenCalledTimes(2)
  })
})
