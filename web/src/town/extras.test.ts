import { describe, expect, it } from 'vitest'
import { DEFAULT_EXTRAS, EXTRAS_KEY, readExtras, writeExtras } from './extras'

describe('小镇显示开关', () => {
  it('没存过、存坏了或读不到时全部收起', () => {
    expect(readExtras({ getItem: () => null })).toEqual(DEFAULT_EXTRAS)
    expect(readExtras({ getItem: () => '{bad' })).toEqual(DEFAULT_EXTRAS)
    expect(readExtras({ getItem: () => { throw Error('blocked') } })).toEqual(DEFAULT_EXTRAS)
    expect(readExtras(undefined)).toEqual(DEFAULT_EXTRAS)
  })

  it('只认明确的 true，写进去能原样读回', () => {
    const store = new Map<string, string>()
    writeExtras({ chips: true, replay: false, parcels: true, inactive: true }, { setItem: (k, v) => store.set(k, v) })
    expect(readExtras({ getItem: (k) => store.get(k) ?? null })).toEqual({ chips: true, replay: false, parcels: true, inactive: true })
    expect(readExtras({ getItem: (k) => (k === EXTRAS_KEY ? '{"chips":"yes"}' : null) }).chips).toBe(false)
  })
})
