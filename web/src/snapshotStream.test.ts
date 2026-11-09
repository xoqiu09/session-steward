import { expect, it, vi } from 'vitest'
import { snapshotStream } from './snapshotStream'

class FakeStream {
  readyState = 0
  onopen: ((event: Event) => unknown) | null = null
  onerror: ((event: Event) => unknown) | null = null
  listeners = new Map<string, (event: Event) => void>()
  close = vi.fn(() => { this.readyState = 2 })
  addEventListener(type: string, listener: (event: Event) => void) { this.listeners.set(type, listener) }
  emit(type: string) { this.listeners.get(type)?.(new Event(type)) }
}

it('recreates a stream closed by an initial HTTP error, but coalesces retries while connecting or live', () => {
  const streams: FakeStream[] = []
  const create = vi.fn(() => { const stream = new FakeStream(); streams.push(stream); return stream })
  const handlers = { open: vi.fn(), error: vi.fn(), change: vi.fn(), reset: vi.fn() }
  const controller = snapshotStream(create, handlers)
  controller.reconnect(); expect(create).toHaveBeenCalledTimes(1)
  streams[0].readyState = 2; streams[0].onerror?.(new Event('error'))
  controller.reconnect(); controller.reconnect()
  expect(create).toHaveBeenCalledTimes(2)
  expect(streams[0].close).toHaveBeenCalledTimes(1)
  streams[1].readyState = 1; streams[1].onopen?.(new Event('open'))
  controller.reconnect(); streams[1].emit('changes'); streams[1].emit('reset')
  expect(create).toHaveBeenCalledTimes(2)
  expect(handlers.open).toHaveBeenCalledTimes(1)
  expect(handlers.error).toHaveBeenCalledTimes(1)
  expect(handlers.change).toHaveBeenCalledTimes(1)
  expect(handlers.reset).toHaveBeenCalledTimes(1)
  controller.dispose()
})

it('ignores late events from replaced or disposed streams and never reconnects after unmount', () => {
  const streams: FakeStream[] = []
  const create = vi.fn(() => { const stream = new FakeStream(); streams.push(stream); return stream })
  const handlers = { open: vi.fn(), error: vi.fn(), change: vi.fn(), reset: vi.fn() }
  const controller = snapshotStream(create, handlers)
  const oldOpen = streams[0].onopen
  streams[0].readyState = 2; controller.reconnect()
  oldOpen?.(new Event('open')); streams[0].emit('changes')
  expect(handlers.open).not.toHaveBeenCalled(); expect(handlers.change).not.toHaveBeenCalled()
  const nextOpen = streams[1].onopen
  controller.dispose(); controller.reconnect(); nextOpen?.(new Event('open')); streams[1].emit('reset')
  expect(create).toHaveBeenCalledTimes(2)
  expect(streams[1].close).toHaveBeenCalledTimes(1)
  expect(handlers.open).not.toHaveBeenCalled(); expect(handlers.reset).not.toHaveBeenCalled()
})
