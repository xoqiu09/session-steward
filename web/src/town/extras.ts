// 小镇首屏默认只留看进度用的东西；状态筛选、回放、包裹/退件筐这些不常用的，由你在“显示”里打开。
// 只记在这个浏览器里，读不到时按默认（全部收起）。
export interface TownExtras { chips: boolean; replay: boolean; parcels: boolean; inactive: boolean }

export const EXTRAS_KEY = 'ss.town.extras.v1'
export const DEFAULT_EXTRAS: TownExtras = { chips: false, replay: false, parcels: false, inactive: false }

export const EXTRA_LABELS: { key: keyof TownExtras; label: string; help: string }[] = [
  { key: 'chips', label: '状态筛选', help: '顶部的工作中、等你决定、失败等高亮按钮' },
  { key: 'replay', label: '回放', help: '拖到过去某个时刻看当时的小镇' },
  { key: 'parcels', label: '包裹和退件筐', help: '每次运行的小纸箱、验收台上的箱子、失败的退件筐' },
  { key: 'inactive', label: '不活跃的项目', help: '7 天以上没有会话、待办都已暂停或处理的项目；有新会话会自动回来' },
]

export function readExtras(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): TownExtras {
  try {
    const v = JSON.parse(storage?.getItem(EXTRAS_KEY) || 'null')
    return { chips: v?.chips === true, replay: v?.replay === true, parcels: v?.parcels === true, inactive: v?.inactive === true }
  } catch { return DEFAULT_EXTRAS }
}

export function writeExtras(v: TownExtras, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(EXTRAS_KEY, JSON.stringify(v)) } catch { /* 存不下时只在本页有效 */ }
}
