import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  clearAcceptanceCheckpoint,
  listRows,
  readAcceptanceCheckpoint,
  resetRows,
  saveAll,
  saveRows,
  snapshotRows,
  writeAcceptanceCheckpoint,
} from '@/data/local-store'
import type {
  AcceptanceCheckpoint,
  AcceptanceDetail,
  ActionResult,
  BatchAcceptResult,
  EntryRow,
  ModuleMeta,
  Operator,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 站房维护验收涉及的几个集合：主记录、费用记录、关联待办、台账。
const STATIONHOUSE_KEY = 'stationhouse'
const FEE_KEY = 'stationhouse_fee'
const TODO_KEY = 'todo'
const LEDGER_KEY = 'ledger'

// 验收动作只认这个角色，越权调用直接拒绝。
const ACCEPT_ROLE = '验收员'
// 只有「已完成」才允许验收；验收通过后费用状态结转到「已结算」。
const ACCEPTABLE_STATUS = '已完成'
const ACCEPTED_STATUS = '已验收'
const FEE_OPEN = '待结算'
const FEE_SETTLED = '已结算'
const TODO_DONE = '已完成'
const LEDGER_SUMMARY = '站房维护验收通过'

// 巡检类模块：记录走到终态时补登台账，和站房维护验收共用同一条台账写入。
const LEDGER_MODULES = new Set(['inspection', 'calibration', 'telemetry', 'communication', 'cableway'])

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

/** 读路径统一去重：同一 id 只保留一条，历史脏数据也不会在页面上重复显示。 */
function dedupeById(rows: EntryRow[]): EntryRow[] {
  const seen = new Map<number, EntryRow>()
  for (const row of rows) {
    const id = Number(row.id)
    if (!seen.has(id)) {
      seen.set(id, row)
    }
  }
  return [...seen.values()]
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = dedupeById(filterRows(listRows(key), filters))
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function now(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ')
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// ===== 费用记录兼容层 =====
// 既有费用记录有三种形态：新格式（费用金额+费用状态）、旧格式（金额、缺费用状态）、
// 以及没有费用记录只有主记录上的「费用支出」。这里统一归一成新格式读取，不写回。

function normalizeFeeRow(fee: EntryRow | undefined, record: EntryRow): EntryRow {
  const accepted = String(record.status) === ACCEPTED_STATUS
  const amount = Number(fee?.['费用金额'] ?? fee?.['金额'] ?? record['费用支出'] ?? 0)
  // 主记录已验收而费用状态还停在待结算的，属于历史残留，读取时按已结算纠正。
  const feeStatus = accepted ? FEE_SETTLED : String(fee?.['费用状态'] ?? FEE_OPEN)
  return {
    id: Number(fee?.id ?? 0),
    status: feeStatus,
    pending: feeStatus !== FEE_SETTLED,
    abnormal: false,
    记录编号: String(record['记录编号']),
    费用金额: amount,
    费用状态: feeStatus,
    维护日期: String(record['维护日期'] ?? ''),
  }
}

/** 每条维护记录归并出一条费用记录；同一记录编号有多条费用记录时取最新一条。 */
function feeRowsFor(records: EntryRow[], fees: EntryRow[]): EntryRow[] {
  const latestByCode = new Map<string, EntryRow>()
  for (const fee of dedupeById(fees)) {
    latestByCode.set(String(fee['记录编号']), fee)
  }
  return records.map((record) => normalizeFeeRow(latestByCode.get(String(record['记录编号'])), record))
}

function feeStatusMap(records: EntryRow[], fees: EntryRow[]): Map<string, string> {
  return new Map(feeRowsFor(records, fees).map((fee) => [String(fee['记录编号']), String(fee['费用状态'])]))
}

function todosFor(record: EntryRow, todos: EntryRow[]): EntryRow[] {
  const code = String(record['记录编号'])
  return dedupeById(todos).filter(
    (todo) => String(todo['关联模块']) === STATIONHOUSE_KEY && String(todo['关联编号']) === code,
  )
}

function ledgerFor(record: EntryRow, ledger: EntryRow[]): EntryRow[] {
  const code = String(record['记录编号'])
  return dedupeById(ledger).filter(
    (entry) => String(entry['来源模块']) === STATIONHOUSE_KEY && String(entry['来源编号']) === code,
  )
}

function withFeeStatus(record: EntryRow, feeStatus: Map<string, string>): EntryRow {
  return {
    ...record,
    费用状态: feeStatus.get(String(record['记录编号'])) ?? FEE_OPEN,
  }
}

/** 维护列表：主记录去重后带上归一化的费用状态。 */
export function listMaintenanceEntries(filters: Record<string, string> = {}): PageResult {
  const records = dedupeById(filterRows(listRows(STATIONHOUSE_KEY), filters))
  const feeStatus = feeStatusMap(records, listRows(FEE_KEY))
  const items = records.map((record) => withFeeStatus(record, feeStatus))
  return { items, total: items.length, page: 1, size: items.length }
}

/** 验收详情：一条记录 + 它的费用记录、关联待办、台账流水，各归并一份。 */
export function getAcceptanceDetail(id: number): AcceptanceDetail | null {
  const record = dedupeById(listRows(STATIONHOUSE_KEY)).find((row) => Number(row.id) === id)
  if (!record) {
    return null
  }
  const feeStatus = feeStatusMap([record], listRows(FEE_KEY))
  return {
    record: withFeeStatus(record, feeStatus),
    fees: feeRowsFor([record], listRows(FEE_KEY)),
    todos: todosFor(record, listRows(TODO_KEY)),
    ledger: ledgerFor(record, listRows(LEDGER_KEY)),
  }
}

/** 巡检面板里的站房记录：去重后每条只出现一次，带费用状态和未办结待办数。 */
export function listStationhousePanel(): EntryRow[] {
  const records = dedupeById(listRows(STATIONHOUSE_KEY))
  const feeStatus = feeStatusMap(records, listRows(FEE_KEY))
  const todos = listRows(TODO_KEY)
  return records.map((record) => {
    const openTodos = todosFor(record, todos).filter((todo) => String(todo['待办状态']) !== TODO_DONE)
    return {
      ...withFeeStatus(record, feeStatus),
      待办提醒: openTodos.length,
    }
  })
}

export function listLedgerEntries(): EntryRow[] {
  return dedupeById(listRows(LEDGER_KEY))
}

export function listTodoEntries(): EntryRow[] {
  return dedupeById(listRows(TODO_KEY))
}

function appendLedgerRow(
  ledger: EntryRow[],
  entry: { 来源模块: string; 来源编号: string; 摘要: string; 金额: number; 操作人: string; 批次?: string },
): EntryRow[] {
  const duplicated = ledger.some(
    (row) =>
      String(row['来源模块']) === entry.来源模块 &&
      String(row['来源编号']) === entry.来源编号 &&
      String(row['摘要']) === entry.摘要,
  )
  if (duplicated) {
    return ledger
  }
  const id = nextId(ledger)
  ledger.push({
    id,
    status: '已登记',
    pending: false,
    abnormal: false,
    台账编号: `TZ-${String(id).padStart(4, '0')}`,
    来源模块: entry.来源模块,
    来源编号: entry.来源编号,
    摘要: entry.摘要,
    金额: entry.金额,
    操作人: entry.操作人,
    登记时间: now(),
    批次: entry.批次 ?? '',
  })
  return ledger
}

// ===== 验收管线 =====
// 权限校验 → 幂等跳过 → 状态守卫 → 主记录/费用/待办/台账同事务写入。
// 任何一步失败整批回退并记下断点，修复数据后从断点续做。

function failBatch(
  batchId: string,
  remainingIds: number[],
  failedId: number | undefined,
  reason: string,
): BatchAcceptResult {
  const checkpoint: AcceptanceCheckpoint = {
    batchId,
    remainingIds,
    failedId,
    reason,
    updatedAt: now(),
  }
  writeAcceptanceCheckpoint(checkpoint)
  return {
    ok: false,
    message: `${reason}。本批已整批回退，修复数据后可从断点续做（批次 ${batchId}）`,
    accepted: [],
    skipped: [],
    failedId,
  }
}

export function acceptMaintenanceBatch(
  ids: number[],
  operator: Operator,
  batchId?: string,
): BatchAcceptResult {
  if (!operator.roles.includes(ACCEPT_ROLE)) {
    return {
      ok: false,
      message: `越权验收被拒绝：${operator.name} 没有「${ACCEPT_ROLE}」权限`,
      accepted: [],
      skipped: [],
    }
  }
  const uniqueIds = [...new Set(ids.map(Number))]
  if (uniqueIds.length === 0) {
    return { ok: false, message: '没有选中要验收的站房维护记录', accepted: [], skipped: [] }
  }
  const batch = batchId ?? `ACC-${Date.now()}`
  // 工作副本上校验并写入，全部通过才一次性提交；中途任何失败都不会落库。
  const working = snapshotRows()
  const records = working[STATIONHOUSE_KEY] ?? []
  const fees = working[FEE_KEY] ?? []
  const todos = working[TODO_KEY] ?? []
  const ledger = working[LEDGER_KEY] ?? []
  const accepted: number[] = []
  const skipped: number[] = []

  for (const id of uniqueIds) {
    const record = records.find((row) => Number(row.id) === id)
    if (!record) {
      return failBatch(batch, uniqueIds, id, `没有找到编号为 ${id} 的站房维护记录`)
    }
    if (String(record.status) === ACCEPTED_STATUS) {
      // 幂等：已验收的记录直接跳过，费用、待办、台账都不重复写。
      skipped.push(id)
      continue
    }
    if (String(record.status) !== ACCEPTABLE_STATUS) {
      return failBatch(
        batch,
        uniqueIds.filter((item) => !skipped.includes(item)),
        id,
        `记录「${String(record['记录编号'])}」当前为「${String(record.status)}」，未完工不能验收`,
      )
    }
    record.status = ACCEPTED_STATUS
    record.pending = false
    record.abnormal = false
    // 费用记录：没有就按「费用支出」补登一条，有就把状态结转到已结算。
    const code = String(record['记录编号'])
    const fee = fees.find((row) => String(row['记录编号']) === code)
    if (fee) {
      fee['费用金额'] = Number(fee['费用金额'] ?? fee['金额'] ?? record['费用支出'] ?? 0)
      fee['费用状态'] = FEE_SETTLED
      fee.status = FEE_SETTLED
      fee.pending = false
    } else {
      fees.push({
        id: nextId(fees),
        status: FEE_SETTLED,
        pending: false,
        abnormal: false,
        记录编号: code,
        费用金额: Number(record['费用支出'] ?? 0),
        费用状态: FEE_SETTLED,
        维护日期: String(record['维护日期'] ?? ''),
      })
    }
    // 关联待办同步办结。
    for (const todo of todos) {
      if (String(todo['关联模块']) === STATIONHOUSE_KEY && String(todo['关联编号']) === code) {
        todo['待办状态'] = TODO_DONE
        todo.status = TODO_DONE
        todo.pending = false
      }
    }
    // 台账：按 来源模块+来源编号+摘要 去重，重复执行只生效一次。
    appendLedgerRow(ledger, {
      来源模块: STATIONHOUSE_KEY,
      来源编号: code,
      摘要: LEDGER_SUMMARY,
      金额: Number(record['费用支出'] ?? 0),
      操作人: operator.name,
      批次: batch,
    })
    accepted.push(id)
  }

  if (accepted.length > 0) {
    working[FEE_KEY] = fees
    working[TODO_KEY] = todos
    working[LEDGER_KEY] = ledger
    try {
      saveAll(working)
    } catch (error) {
      return failBatch(
        batch,
        uniqueIds.filter((item) => !skipped.includes(item)),
        undefined,
        `台账写入失败（${error instanceof Error ? error.message : '存储异常'}）`,
      )
    }
  }
  // 只清掉本批次的断点，别的失败批次的断点保留给续做。
  const pendingCheckpoint = readAcceptanceCheckpoint()
  if (pendingCheckpoint && pendingCheckpoint.batchId === batch) {
    clearAcceptanceCheckpoint()
  }
  const parts: string[] = []
  if (accepted.length > 0) {
    parts.push(`本次验收 ${accepted.length} 条，费用、待办、台账已同步`)
  }
  if (skipped.length > 0) {
    parts.push(`${skipped.length} 条此前已验收，重复执行未重复生效`)
  }
  return { ok: true, message: parts.join('；') || '没有需要验收的记录', accepted, skipped }
}

export function acceptMaintenance(id: number, operator: Operator): BatchAcceptResult {
  return acceptMaintenanceBatch([id], operator)
}

/** 断点续做：接着上次失败的批次继续，已验收的记录会被幂等跳过。 */
export function resumeAcceptanceBatch(operator: Operator): BatchAcceptResult {
  const checkpoint = readAcceptanceCheckpoint()
  if (!checkpoint) {
    return { ok: false, message: '没有待续做的验收批次', accepted: [], skipped: [] }
  }
  const result = acceptMaintenanceBatch(checkpoint.remainingIds, operator, checkpoint.batchId)
  return { ...result, resumedFromCheckpoint: true }
}

export function acceptanceCheckpoint(): AcceptanceCheckpoint | null {
  return readAcceptanceCheckpoint()
}

export function runAction(key: string, id: number, action: string, operator = '值班管理员'): ActionResult {
  const meta = moduleMeta(key)
  if (key === STATIONHOUSE_KEY && action === '通过验收') {
    return { ok: false, message: '站房维护验收须走验收流程（验收详情页），通用动作不放开' }
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  // 巡检类模块走到终态时补登台账：和主记录同一个提交里写，不写半截。
  if (LEDGER_MODULES.has(key) && target === lastStatus) {
    const working = snapshotRows()
    working[key] = next
    const ledger = working[LEDGER_KEY] ?? []
    appendLedgerRow(ledger, {
      来源模块: key,
      来源编号: String(updated[meta.fields[0]] ?? updated.id),
      摘要: `${meta.name}·${action}`,
      金额: 0,
      操作人: operator,
    })
    working[LEDGER_KEY] = ledger
    saveAll(working)
  } else {
    saveRows(key, next)
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of dedupeById(listRows(key))) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = dedupeById(rows[meta.key] ?? [])
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
