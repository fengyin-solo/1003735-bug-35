import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type {
  AcceptanceBatch,
  AuditLogEntry,
  EntryRow,
  FeeRecord,
  InspectionTodo,
} from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
const STORE_VERSION = 2

export type StoreState = {
  version: number
  modules: Record<string, EntryRow[]>
  feeRecords: FeeRecord[]
  inspectionTodos: InspectionTodo[]
  acceptanceBatches: AcceptanceBatch[]
  auditLogs: AuditLogEntry[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowText(): string {
  return new Date().toISOString()
}

/**
 * 按业务键去重：维护列表、验收详情、巡检面板共用这一份读取结果，
 * 同一条站房维护（同一记录编号）无论被导入/写入多少次，都只显示一条。
 * 返回去重后的数组与被折叠的条数。
 */
export function dedupeRows(key: string, rows: EntryRow[]): { rows: EntryRow[]; removed: number } {
  const meta = MODULE_BY_KEY.get(key)
  const keyField = meta?.businessKey
  const seen = new Set<string>()
  const result: EntryRow[] = []
  for (const row of rows) {
    const identity = keyField
      ? `${keyField}=${String(row[keyField] ?? '')}`
      : `id=${String(row.id)}`
    // 业务键缺失时退回 id，避免把空编号的行误合并。
    const dedupeKey = keyField && String(row[keyField] ?? '').trim() === '' ? `id=${String(row.id)}` : identity
    if (seen.has(dedupeKey)) {
      continue
    }
    seen.add(dedupeKey)
    result.push(row)
  }
  return { rows: result, removed: rows.length - result.length }
}

/** 从旧版行内「费用支出」迁移费用记录；一条站房维护至多一条，重复执行不重复生成。 */
function migrateLegacyFees(rows: EntryRow[], existing: FeeRecord[]): FeeRecord[] {
  const fees = [...existing]
  const byKey = new Map(fees.map((fee) => [fee.key, fee]))
  for (const row of rows) {
    const key = String(row.id)
    if (byKey.has(key)) {
      continue
    }
    const raw = row['费用支出']
    const amount = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(amount) || amount <= 0) {
      continue
    }
    const accepted = String(row.status) === '已验收'
    const fee: FeeRecord = {
      key,
      stationhouseId: Number(row.id),
      recordNo: String(row['记录编号'] ?? ''),
      stationNo: String(row['站点编号'] ?? ''),
      amount,
      // 旧数据里已验收的费用按已结算承接，其余一律未结算，验收时再联动。
      status: accepted ? '已结算' : '未结算',
      settledAt: accepted ? (row['维护日期'] ? String(row['维护日期']) : nowText()) : null,
      legacy: true,
    }
    fees.push(fee)
    byKey.set(key, fee)
  }
  return fees
}

/**
 * 为既有站房维护补关联待办：完工即应有「现场复核」待办，验收后关闭。
 * 用业务键 stationhouse:${id} 幂等 upsert，迁移和后续重跑都不会产生重复待办。
 */
function migrateLegacyTodos(rows: EntryRow[], existing: InspectionTodo[]): InspectionTodo[] {
  const todos = [...existing]
  const byKey = new Map(todos.map((todo) => [todo.key, todo]))
  for (const row of rows) {
    const status = String(row.status)
    if (status !== '已完成' && status !== '已验收') {
      continue
    }
    const key = `stationhouse:${row.id}`
    const hit = byKey.get(key)
    if (hit) {
      continue
    }
    const todo: InspectionTodo = {
      key,
      sourceModule: 'stationhouse',
      sourceId: Number(row.id),
      recordNo: String(row['记录编号'] ?? ''),
      stationNo: String(row['站点编号'] ?? ''),
      title: `现场复核：${String(row['维护类型'] ?? '站房维护')}（${String(row['站点编号'] ?? '')}）`,
      status: status === '已验收' ? '已关闭' : '待复核',
      createdAt: nowText(),
      closedAt: status === '已验收' ? nowText() : null,
    }
    todos.push(todo)
    byKey.set(key, todo)
  }
  return todos
}

/**
 * 读时对账：费用结算状态、待办关闭状态必须与站房维护状态一致。
 * 旧版本残留的「未结算 + 已验收」在这里被纠正，验收回退导致的反向不一致同理还原。
 */
function reconcile(state: StoreState): void {
  const rows = state.modules['stationhouse'] ?? []
  const statusById = new Map(rows.map((row) => [Number(row.id), String(row.status)]))
  for (const fee of state.feeRecords) {
    const accepted = statusById.get(fee.stationhouseId) === '已验收'
    if (accepted && fee.status !== '已结算') {
      fee.status = '已结算'
      fee.settledAt = fee.settledAt ?? nowText()
    } else if (!accepted && fee.status === '已结算') {
      fee.status = '未结算'
      fee.settledAt = null
    }
  }
  for (const todo of state.inspectionTodos) {
    const accepted = statusById.get(todo.sourceId) === '已验收'
    if (accepted && todo.status !== '已关闭') {
      todo.status = '已关闭'
      todo.closedAt = todo.closedAt ?? nowText()
    } else if (!accepted && todo.status === '已关闭') {
      todo.status = '待复核'
      todo.closedAt = null
    }
  }
}

function seedState(): StoreState {
  const modules = clone(SEED_ROWS)
  const stationhouse = modules['stationhouse'] ?? []
  return {
    version: STORE_VERSION,
    modules,
    feeRecords: migrateLegacyFees(stationhouse, []),
    inspectionTodos: migrateLegacyTodos(stationhouse, []),
    acceptanceBatches: [],
    auditLogs: [],
  }
}

/** 旧版 localStorage 直接是 Record<模块key, 行数组>，识别后迁移到带版本的新结构。 */
function fromLegacyPayload(parsed: Record<string, unknown>): StoreState {
  const modules = clone(parsed) as unknown as Record<string, EntryRow[]>
  for (const key of Object.keys(modules)) {
    modules[key] = dedupeRows(key, modules[key] ?? []).rows
  }
  const state: StoreState = {
    version: STORE_VERSION,
    modules,
    feeRecords: migrateLegacyFees(modules['stationhouse'] ?? [], []),
    inspectionTodos: migrateLegacyTodos(modules['stationhouse'] ?? [], []),
    acceptanceBatches: [],
    auditLogs: [],
  }
  reconcile(state)
  return state
}

function readStorage(): StoreState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = seedState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    let state: StoreState
    if (Number(parsed['version']) === STORE_VERSION && parsed['modules']) {
      state = parsed as unknown as StoreState
    } else {
      state = fromLegacyPayload(parsed)
    }
    // 每次加载都跑一次对账 + 去重：自愈残留状态，并折叠历史重复行。
    for (const key of Object.keys(state.modules)) {
      state.modules[key] = dedupeRows(key, state.modules[key] ?? []).rows
    }
    state.feeRecords = migrateLegacyFees(state.modules['stationhouse'] ?? [], state.feeRecords)
    state.inspectionTodos = migrateLegacyTodos(
      state.modules['stationhouse'] ?? [],
      state.inspectionTodos,
    )
    reconcile(state)
    return state
  } catch {
    const seeded = seedState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

let cache: StoreState | null = null

export function getState(): StoreState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function persist(): void {
  const state = getState()
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
  // 缓存始终指向当前这份状态：服务层（getState）与直接修改集合后调 persist
  // 的调用方（验收/费用/待办）看到同一对象，避免关联写入分叉、待办不同步。
  cache = state
}

export function allRows(): Record<string, EntryRow[]> {
  return getState().modules
}

export function listRows(key: string): EntryRow[] {
  return getState().modules[key] ?? []
}

/** 写入即按业务键压实：第一次状态流转后，存储里的重复行也被清掉。 */
export function saveRows(key: string, rows: EntryRow[]): void {
  const state = getState()
  state.modules = { ...state.modules, [key]: dedupeRows(key, rows).rows }
  cache = state
  persist()
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// --- 验收链路关联集合 -------------------------------------------------------

export function getFees(): FeeRecord[] {
  return getState().feeRecords
}

export function saveFees(fees: FeeRecord[]): void {
  const state = getState()
  state.feeRecords = fees
  cache = state
  persist()
}

export function getTodos(): InspectionTodo[] {
  return getState().inspectionTodos
}

export function saveTodos(todos: InspectionTodo[]): void {
  const state = getState()
  state.inspectionTodos = todos
  cache = state
  persist()
}

export function getBatches(): AcceptanceBatch[] {
  return getState().acceptanceBatches
}

export function saveBatches(batches: AcceptanceBatch[]): void {
  const state = getState()
  state.acceptanceBatches = batches
  cache = state
  persist()
}

export function getLogs(): AuditLogEntry[] {
  return getState().auditLogs
}

export function nextLogId(): number {
  return getLogs().reduce((max, item) => Math.max(max, item.id), 0) + 1
}

export function appendLog(entry: Omit<AuditLogEntry, 'id' | 'at'>): AuditLogEntry {
  const state = getState()
  const full: AuditLogEntry = { id: nextLogId(), at: nowText(), ...entry }
  state.auditLogs = [full, ...state.auditLogs].slice(0, 500)
  cache = state
  persist()
  return full
}

/** 测试与「重置模块」使用：丢弃内存缓存，下次读取重新走迁移/对账。 */
export function invalidateCache(): void {
  cache = null
}

export function storageKey(): string {
  return STORAGE_KEY
}
