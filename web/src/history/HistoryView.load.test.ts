import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import type { DayDetail } from '../types'
import { readHistoryDay, type HistoryDayRead } from './HistoryView'

const detail=(day:string):DayDetail=>({day,items:[],sessions:[]})
function deferred() {
  let resolve!:(value:DayDetail)=>void, reject!:(reason:unknown)=>void
  const promise=new Promise<DayDetail>((yes,no)=> {resolve=yes;reject=no})
  return {promise,resolve,reject}
}
const flush=async()=> {await Promise.resolve();await Promise.resolve()}
afterEach(()=>vi.restoreAllMocks())

it('某日失败后切换日期会清除旧错，成功结果只属于新日期',async()=> {
  const first=deferred(), second=deferred()
  vi.spyOn(api,'historyDay').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  let state:HistoryDayRead|undefined
  const stop=readHistoryDay('2026-11-10',value=> {state=value})
  first.reject(new Error('synthetic first day failure'));await flush()
  expect(state).toMatchObject({day:'2026-11-10',status:'error'})
  stop();readHistoryDay('2026-11-11',value=> {state=value})
  expect(state).toEqual({day:'2026-11-11',status:'loading'})
  second.resolve(detail('2026-11-11'));await flush()
  expect(state).toEqual({day:'2026-11-11',status:'ready',detail:detail('2026-11-11')})
})

it.each(['resolve','reject'] as const)('旧日请求晚到 %s 不能覆盖当前日',async outcome=> {
  const first=deferred(), second=deferred()
  vi.spyOn(api,'historyDay').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  let state:HistoryDayRead|undefined
  const stop=readHistoryDay('2026-11-10',value=> {state=value})
  stop();readHistoryDay('2026-11-11',value=> {state=value})
  second.resolve(detail('2026-11-11'));await flush()
  if(outcome==='resolve') first.resolve(detail('2026-11-10'))
  else first.reject(new Error('synthetic stale error'))
  await flush()
  expect(state).toEqual({day:'2026-11-11',status:'ready',detail:detail('2026-11-11')})
})

it('同一天重新读取也先进入加载态，成功后不保留旧错误',async()=> {
  vi.spyOn(api,'historyDay').mockRejectedValueOnce(new Error('synthetic unavailable')).mockResolvedValueOnce(detail('2026-11-11'))
  let state:HistoryDayRead|undefined
  const stop=readHistoryDay('2026-11-11',value=> {state=value});await flush()
  expect(state).toMatchObject({status:'error'})
  stop();readHistoryDay('2026-11-11',value=> {state=value})
  expect(state).toEqual({day:'2026-11-11',status:'loading'})
  await flush()
  expect(state).toEqual({day:'2026-11-11',status:'ready',detail:detail('2026-11-11')})
})
