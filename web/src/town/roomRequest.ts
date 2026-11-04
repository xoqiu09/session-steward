// 从小镇外（右键菜单等）请求进入某个项目房间，并可直接展开房间里的某个区块。
// 小镇还没挂载时先记下，挂载后读取；已挂载时通过事件立即处理。
export type RoomFocus = 'organize' | 'housekeeping'
export interface RoomRequest { repoId: number; focus?: RoomFocus; nonce: number }

const EVENT = 'steward:room-request'
let pending: RoomRequest | null = null
let seq = 0

export function requestRoom(repoId: number, focus?: RoomFocus): void {
  pending = { repoId, focus, nonce: ++seq }
  globalThis.window?.dispatchEvent(new CustomEvent<RoomRequest>(EVENT, { detail: pending }))
}

/** 取走还没处理的请求（只取一次）。 */
export function takeRoomRequest(): RoomRequest | null {
  const p = pending
  pending = null
  return p
}

export function onRoomRequest(handler: (r: RoomRequest) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<RoomRequest>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
