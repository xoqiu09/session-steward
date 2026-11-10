// 室内房间的大小：随摆上台的工作项伸缩，工作项少时不再留下大片空地板。
import { createContext } from 'react'

export interface RoomSize { w: number; d: number }

/** 最大的房间：三排工作台，或者分区时两排。旧版房间一直是这么大。 */
export const FULL_ROOM: RoomSize = { w: 16, d: 12 }

/** 室内场景把当前房间大小传给在屋里走动的居民，她们沿前面的过道走，不会走出墙外。 */
export const RoomSizeContext = createContext<RoomSize>(FULL_ROOM)
