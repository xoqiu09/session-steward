import { useEffect, type RefObject } from 'react'
import { residentStatus, type ResidentActor, type ResidentStore } from './residentLife'
import { useResidentLife } from './residentPresence'
import { residentImage, residentSpec, type ResidentId } from './residents'

/** 仅订阅被跟随的居民生活；相机沿用世界场景原有的动画与导航。 */
export function ResidentFollow({ store, id, following, active, controls = true, onFrame, onFollow, onStop }: {
  store: ResidentStore; id: ResidentId | null; following: boolean; active: boolean; controls?: boolean
  onFrame: RefObject<(actor: ResidentActor | null) => void>; onFollow: (id: ResidentId) => void; onStop: () => void
}) {
  const life = useResidentLife(store), actor = id ? life.actors[id] : null
  useEffect(() => { if (id && active) onFrame.current(life.enabled ? actor : null) }, [life, id, following, active, onFrame])
  if (!controls || !active || !life.enabled || !actor?.trip) return null
  return <div className="town-resident-follow town-world-ui" aria-label="居民镜头跟随" onPointerDown={(e) => e.stopPropagation()}>
    <img src={residentImage(actor.id, 'avatar')} alt="" width="34" height="34" />
    <div role="status" aria-live="polite"><strong>{following ? '正在跟随' : '跟随已暂停'} · {residentSpec(actor.id).name}</strong><small>{residentStatus(actor)}</small></div>
    <button type="button" onClick={() => following ? onStop() : onFollow(actor.id)} title={following ? '停止镜头跟随；拖动或缩放地图也可以暂停跟随' : '重新跟上这位居民'}>{following ? '停止跟随' : '继续跟随'}</button>
  </div>
}
