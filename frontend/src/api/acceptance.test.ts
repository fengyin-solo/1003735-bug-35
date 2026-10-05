import { beforeEach, describe, expect, it } from 'vitest'

import {
  acceptMaintenanceBatch,
  acceptanceCheckpoint,
  getAcceptanceDetail,
  listEntries,
  listLedgerEntries,
  listMaintenanceEntries,
  listStationhousePanel,
  listTodoEntries,
  resumeAcceptanceBatch,
  runAction,
} from '@/api/local-service'
import { clearAcceptanceCheckpoint, listRows, saveAll } from '@/data/local-store'
import { SEED_ROWS } from '@/data/seed'
import type { EntryRow, Operator } from '@/data/types'

const ACCEPTOR: Operator = { name: '值班管理员', roles: ['值班员', '验收员'] }
const OUTSIDER: Operator = { name: '实习员', roles: ['值班员'] }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function rowById(key: string, id: number): EntryRow {
  const row = listRows(key).find((item) => Number(item.id) === id)
  if (!row) {
    throw new Error(`测试数据缺失：${key}#${id}`)
  }
  return row
}

beforeEach(() => {
  saveAll(clone(SEED_ROWS))
  clearAcceptanceCheckpoint()
})

describe('验收权限', () => {
  it('越权验收必须拒绝，数据保持原样', () => {
    const before = clone(listRows('stationhouse'))
    const result = acceptMaintenanceBatch([4], OUTSIDER)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('越权')
    expect(listRows('stationhouse')).toEqual(before)
    expect(listLedgerEntries()).toHaveLength(0)
  })

  it('有验收员角色才能验收', () => {
    const result = acceptMaintenanceBatch([4], ACCEPTOR)
    expect(result.ok).toBe(true)
    expect(result.accepted).toEqual([4])
  })
})

describe('验收事务与关联写入', () => {
  it('验收通过：主记录、费用状态、关联待办、台账一次同步', () => {
    const result = acceptMaintenanceBatch([4, 5], ACCEPTOR)
    expect(result.ok).toBe(true)
    expect(result.accepted).toEqual([4, 5])
    expect(rowById('stationhouse', 4).status).toBe('已验收')
    expect(rowById('stationhouse', 5).status).toBe('已验收')

    const detail = getAcceptanceDetail(4)
    expect(detail?.record['费用状态']).toBe('已结算')
    expect(detail?.fees[0]['费用状态']).toBe('已结算')
    expect(detail?.fees[0]['费用金额']).toBe(50)
    expect(detail?.todos.every((todo) => todo['待办状态'] === '已完成')).toBe(true)

    const ledger = listLedgerEntries()
    expect(ledger).toHaveLength(2)
    expect(ledger.map((row) => row['来源编号']).sort()).toEqual(['STAT-0004', 'STAT-0005'])
  })

  it('未完工项混入批次：整批回退，一条都不验收', () => {
    const result = acceptMaintenanceBatch([4, 3], ACCEPTOR) // 3 施工中，未完工
    expect(result.ok).toBe(false)
    expect(result.failedId).toBe(3)
    expect(result.message).toContain('未完工')
    // 整批回退：4 也不能被一并改成已验收
    expect(rowById('stationhouse', 4).status).toBe('已完成')
    expect(rowById('stationhouse', 3).status).toBe('施工中')
    expect(listLedgerEntries()).toHaveLength(0)
    expect(listTodoEntries().filter((todo) => todo['待办状态'] === '已完成')).toHaveLength(0)
  })

  it('批次失败留下断点，修复数据后从断点续做', () => {
    const failed = acceptMaintenanceBatch([4, 3, 5], ACCEPTOR, 'BATCH-1')
    expect(failed.ok).toBe(false)
    const checkpoint = acceptanceCheckpoint()
    expect(checkpoint?.batchId).toBe('BATCH-1')
    expect(checkpoint?.failedId).toBe(3)
    expect(checkpoint?.remainingIds).toEqual([4, 3, 5])

    // 修复数据：3 走完施工流程变成已完成
    const state = clone(SEED_ROWS)
    const target = state['stationhouse'].find((row) => Number(row.id) === 3)
    if (target) {
      target.status = '已完成'
    }
    saveAll(state)

    const resumed = resumeAcceptanceBatch(ACCEPTOR)
    expect(resumed.ok).toBe(true)
    expect(resumed.resumedFromCheckpoint).toBe(true)
    expect(resumed.accepted.sort()).toEqual([3, 4, 5])
    expect(acceptanceCheckpoint()).toBeNull()
    expect(rowById('stationhouse', 3).status).toBe('已验收')
    expect(listLedgerEntries()).toHaveLength(3)
  })
})

describe('幂等', () => {
  it('重复执行只生效一次：状态、费用、待办、台账都不重复写', () => {
    const first = acceptMaintenanceBatch([4], ACCEPTOR)
    expect(first.ok).toBe(true)
    const second = acceptMaintenanceBatch([4], ACCEPTOR)
    expect(second.ok).toBe(true)
    expect(second.accepted).toEqual([])
    expect(second.skipped).toEqual([4])
    expect(listLedgerEntries()).toHaveLength(1)
    expect(getAcceptanceDetail(4)?.fees).toHaveLength(1)
  })

  it('既有已验收记录再验收：跳过且不产生新台账', () => {
    const result = acceptMaintenanceBatch([6], ACCEPTOR) // 种子里的已验收记录
    expect(result.ok).toBe(true)
    expect(result.skipped).toEqual([6])
    expect(listLedgerEntries()).toHaveLength(0)
  })
})

describe('费用记录兼容', () => {
  it('旧格式费用记录（金额字段、缺费用状态）能正常读出', () => {
    const detail = getAcceptanceDetail(3) // 种子里费用记录用旧字段「金额」
    expect(detail?.fees[0]['费用金额']).toBe(37.5)
    expect(detail?.fees[0]['费用状态']).toBe('待结算')
  })

  it('没有费用记录的维护单按费用支出派生，已验收的结算状态不残留', () => {
    const detail = getAcceptanceDetail(6) // 已验收但无费用记录
    expect(detail?.record['费用状态']).toBe('已结算')
    expect(detail?.fees[0]['费用金额']).toBe(75)
  })

  it('验收时既有费用记录就地结转，不另起重复行', () => {
    const state = clone(SEED_ROWS)
    const target = state['stationhouse'].find((row) => Number(row.id) === 3)
    if (target) {
      target.status = '已完成'
    }
    saveAll(state)
    const result = acceptMaintenanceBatch([3], ACCEPTOR)
    expect(result.ok).toBe(true)
    const fees = listRows('stationhouse_fee').filter((row) => row['记录编号'] === 'STAT-0003')
    expect(fees).toHaveLength(1)
    expect(fees[0]['费用状态']).toBe('已结算')
    expect(fees[0]['费用金额']).toBe(37.5)
  })
})

describe('读取去重', () => {
  it('维护列表、验收详情、巡检面板对重复 id 只显示一条', () => {
    const dirty = clone(SEED_ROWS)
    const dup = clone(dirty['stationhouse'][0])
    dirty['stationhouse'].push(dup)
    saveAll(dirty)

    const list = listMaintenanceEntries()
    expect(list.items.filter((row) => Number(row.id) === 1)).toHaveLength(1)

    const panel = listStationhousePanel()
    expect(panel.filter((row) => Number(row.id) === 1)).toHaveLength(1)

    const generic = listEntries('stationhouse')
    expect(generic.items.filter((row) => Number(row.id) === 1)).toHaveLength(1)
  })
})

describe('其余巡检页面补台账', () => {
  it('巡检记录走到终态时自动登记台账', () => {
    const result = runAction('inspection', 3, '确认处置') // 发现故障 → 已处置（终态）
    expect(result.ok).toBe(true)
    const ledger = listLedgerEntries()
    expect(ledger).toHaveLength(1)
    expect(ledger[0]['来源模块']).toBe('inspection')
    expect(ledger[0]['摘要']).toContain('确认处置')
  })

  it('未达终态的巡检动作不登记台账', () => {
    const result = runAction('inspection', 1, '完成巡检') // 待巡检 → 已巡检（非终态）
    expect(result.ok).toBe(true)
    expect(listLedgerEntries()).toHaveLength(0)
  })

  it('站房维护通用动作不再放行「通过验收」', () => {
    const result = runAction('stationhouse', 4, '通过验收')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('验收流程')
    expect(rowById('stationhouse', 4).status).toBe('已完成')
  })
})
