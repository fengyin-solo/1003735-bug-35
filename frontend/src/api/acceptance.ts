import {
  appendLog,
  getBatches,
  getState,
  getTodos,
  listRows,
  persist,
  saveBatches,
} from '@/data/local-store'
import type {
  AcceptanceBatch,
  AcceptanceItemResult,
  AcceptanceResult,
  AuditLogEntry,
  EntryRow,
  FeeRecord,
  InspectionTodo,
  Role,
} from '@/data/types'
import { roleCanAccept } from '@/stores/session'

// 站房维护验收：唯一的「验收 + 费用结算 + 巡检待办」写入调用链，
// 列表单条验收、批量验收、断点续跑都走这里，根因只修这一处。

const MODULE = 'stationhouse'
const ACCEPTED_STATUS = '已验收'
const DONE_STATUS = '已完成'

function nowText(): string {
  return new Date().toISOString()
}

function makeBatchId(ids: number[]): string {
  return `ACC-${ids.join('-')}`
}

function todoKey(row: EntryRow): string {
  return `stationhouse:${row.id}`
}

/** 完工时同步巡检待办（确认完工调用）；业务键幂等 upsert，重复执行只留一条。 */
export function syncCompletionTodo(row: EntryRow): InspectionTodo {
  const todos = getTodos()
  const key = todoKey(row)
  const hit = todos.find((todo) => todo.key === key)
  if (hit) {
    let changed = false
    if (hit.status === '已关闭') {
      hit.status = '待复核'
      hit.closedAt = null
      changed = true
    }
    if (changed) {
      persist()
    }
    return hit
  }
  const todo: InspectionTodo = {
    key,
    sourceModule: 'stationhouse',
    sourceId: Number(row.id),
    recordNo: String(row['记录编号'] ?? ''),
    stationNo: String(row['站点编号'] ?? ''),
    title: `现场复核：${String(row['维护类型'] ?? '站房维护')}（${String(row['站点编号'] ?? '')}）`,
    status: '待复核',
    createdAt: nowText(),
    closedAt: null,
  }
  todos.push(todo)
  persist()
  return todo
}

/** 验收通过后联动：费用置为已结算（兼容历史费用）、巡检待办关闭。 */
function applyLinkedWrites(row: EntryRow, at: string): void {
  const state = getState()

  const fees = state.feeRecords
  const fee = fees.find((item) => item.key === String(row.id))
  if (fee) {
    fee.status = '已结算'
    fee.settledAt = at
    // legacy 标记保持不变：迁移来的费用记录继续被兼容，不覆盖、不重写。
  }

  const todos = state.inspectionTodos
  const key = todoKey(row)
  const todo = todos.find((item) => item.key === key)
  if (todo) {
    todo.status = '已关闭'
    todo.closedAt = at
  } else {
    todos.push({
      key,
      sourceModule: 'stationhouse',
      sourceId: Number(row.id),
      recordNo: String(row['记录编号'] ?? ''),
      stationNo: String(row['站点编号'] ?? ''),
      title: `现场复核：${String(row['维护类型'] ?? '站房维护')}（${String(row['站点编号'] ?? '')}）`,
      status: '已关闭',
      createdAt: at,
      closedAt: at,
    })
  }
}

function recordNo(row: EntryRow | undefined, id: number): string {
  return row ? String(row['记录编号'] ?? id) : `#${id}`
}

function buildItemResults(
  ids: number[],
  rowsById: Map<number, EntryRow>,
  acceptedIds: Set<number>,
): AcceptanceItemResult[] {
  return ids.map((id) => {
    const row = rowsById.get(id)
    if (!row) {
      return { id, recordNo: `#${id}`, ok: false, message: '记录不存在' }
    }
    if (acceptedIds.has(id) || String(row.status) === ACCEPTED_STATUS) {
      return { id, recordNo: recordNo(row, id), ok: true, message: '已验收（幂等跳过）' }
    }
    return { id, recordNo: recordNo(row, id), ok: false, message: `当前状态「${row.status}」` }
  })
}

/**
 * 整批验收。
 *
 * 顺序：越权预检 → 幂等命中直接返回 → 未完工/不存在整批拒绝（不做任何写入）
 * → 逐条提交并落断点 → 全部通过后批次关闭。
 * 中途异常按本轮开始时的快照整批回退，批次断点保留，重跑只处理断点之后的条目。
 */
export function acceptStationhouse(
  rawIds: number[],
  role: Role,
  operator: string = role,
): AcceptanceResult {
  const ids = [...new Set(rawIds.map(Number))].sort((a, b) => a - b)
  const batchId = makeBatchId(ids)

  // 1) 越权验收必须拒绝：发生在任何写入之前，且对整批生效。
  if (!roleCanAccept(role)) {
    appendLog({
      operator,
      module: MODULE,
      action: '通过验收(拒绝)',
      targetId: batchId,
      detail: `角色「${role}」无验收权限，整批 ${ids.length} 条被拒绝`,
      ok: false,
    })
    return {
      ok: false,
      reapplied: false,
      batchId,
      status: '已回退',
      processed: [],
      message: `当前角色「${role}」没有验收权限，整批验收已拒绝`,
    }
  }

  if (ids.length === 0) {
    return {
      ok: false,
      reapplied: false,
      batchId,
      status: '已回退',
      processed: [],
      message: '未选择任何站房维护记录',
    }
  }

  const batches = getBatches()
  let batch = batches.find((item) => item.id === batchId)

  // 2) 幂等：同一组记录已经整批通过，重复执行只生效一次，直接回传既有结果。
  if (batch && batch.status === '已通过') {
    const rows = listRows(MODULE)
    const rowsById = new Map(rows.map((row) => [Number(row.id), row]))
    return {
      ok: true,
      reapplied: false,
      batchId,
      status: '已通过',
      processed: buildItemResults(ids, rowsById, new Set(ids)),
      message: `批次 ${batchId} 已验收通过，重复执行未再次生效`,
    }
  }

  const rows = listRows(MODULE)
  const rowsById = new Map(rows.map((row) => [Number(row.id), row]))
  const start = batch?.done ?? 0
  const remaining = ids.slice(start)

  // 3) 预检（仅针对断点之后的条目）：不存在 / 未完工，任意一条不满足即整批拒绝。
  //    plan 为每一条给出处置方式：accept=本轮写入，skip=已验收幂等跳过。
  type PlanItem = AcceptanceItemResult & { mode: 'accept' | 'skip' }
  const plan: PlanItem[] = []
  let blocked: AcceptanceItemResult | null = null
  for (const id of remaining) {
    const row = rowsById.get(id)
    if (!row) {
      const item = { id, recordNo: `#${id}`, ok: false, message: '站房维护记录不存在' }
      blocked ??= item
      continue
    }
    const status = String(row.status)
    if (status === ACCEPTED_STATUS) {
      plan.push({ id, recordNo: recordNo(row, id), ok: true, message: '已验收，跳过', mode: 'skip' })
      continue
    }
    if (status !== DONE_STATUS) {
      const item = {
        id,
        recordNo: recordNo(row, id),
        ok: false,
        message: `只有「${DONE_STATUS}」才能验收，当前为「${status}」（未完工）`,
      }
      blocked ??= item
      continue
    }
    plan.push({ id, recordNo: recordNo(row, id), ok: true, message: '验收通过', mode: 'accept' })
  }

  if (blocked) {
    // 整批拒绝：不写任何业务数据；批次记录保留在断点处，修复后可直接续做。
    const now = nowText()
    const applied = ids.slice(0, start)
    if (!batch) {
      batch = {
        id: batchId,
        operator,
        ids,
        done: 0,
        status: '进行中',
        createdAt: now,
        updatedAt: now,
        error: blocked.message,
      }
      batches.push(batch)
    } else {
      batch.error = blocked.message
      batch.updatedAt = now
    }
    saveBatches(batches)
    appendLog({
      operator,
      module: MODULE,
      action: '通过验收(驳回)',
      targetId: batchId,
      detail: `断点 ${start}/${ids.length}：${blocked.message}，整批未写入`,
      ok: false,
    })
    return {
      ok: false,
      reapplied: false,
      batchId,
      status: '进行中',
      processed: [
        ...applied.map((id) => ({
          id,
          recordNo: recordNo(rowsById.get(id), id),
          ok: true,
          message: '断点前已通过',
        })),
        ...remaining.map((id) => {
          const planned = plan.find((item) => item.id === id)
          if (planned) {
            return { id, recordNo: planned.recordNo, ok: true, message: planned.message }
          }
          return blocked && blocked.id === id
            ? { id, recordNo: blocked.recordNo, ok: false, message: blocked.message }
            : { id, recordNo: `#${id}`, ok: false, message: '未通过预检' }
        }),
      ],
      message: `存在未完工或不存在的记录，整批验收已拒绝：${blocked.message}。完工后可从断点（${start}/${ids.length}）续做`,
    }
  }

  // 4) 建立/续用批次（断点）。本轮写入前先快照，异常时整批回退到本轮开始状态。
  const now0 = nowText()
  if (!batch) {
    batch = {
      id: batchId,
      operator,
      ids,
      done: start,
      status: '进行中',
      createdAt: now0,
      updatedAt: now0,
      error: null,
    }
    batches.push(batch)
    saveBatches(batches)
  }

  const state = getState()
  const snapshot = JSON.parse(JSON.stringify({
    modules: { stationhouse: state.modules[MODULE] },
    feeRecords: state.feeRecords,
    inspectionTodos: state.inspectionTodos,
    auditLogs: state.auditLogs,
  })) as {
    modules: { stationhouse: EntryRow[] }
    feeRecords: FeeRecord[]
    inspectionTodos: InspectionTodo[]
    auditLogs: AuditLogEntry[]
  }

  const processed: AcceptanceItemResult[] = ids.slice(0, start).map((id) => ({
    id,
    recordNo: recordNo(rowsById.get(id), id),
    ok: true,
    message: '断点前已通过',
  }))

  try {
    let done = start
    for (const item of plan) {
      const id = item.id
      const row = state.modules[MODULE].find((candidate) => Number(candidate.id) === id)
      // 预检保证 row 存在；skip 条目（已验收）只推进断点，不再产生任何写入（幂等）。
      if (row && item.mode === 'accept') {
        const at = nowText()
        row.status = ACCEPTED_STATUS
        row.pending = false
        row.abnormal = false
        applyLinkedWrites(row, at)
        appendLog({
          operator,
          module: MODULE,
          action: '通过验收',
          targetId: id,
          detail: `${item.recordNo} 验收通过；费用联动已结算、巡检待办联动关闭；批次 ${batchId}`,
          ok: true,
        })
        processed.push({ id, recordNo: item.recordNo, ok: true, message: '验收通过' })
      } else if (row) {
        processed.push({ id, recordNo: item.recordNo, ok: true, message: '已验收，跳过' })
      }
      done += 1
      // batch 是 state.acceptanceBatches 里的同一引用：原地推进断点，
      // 与本条的维护状态/费用/待办一起单次落盘，崩溃时断点与业务数据一致。
      batch.done = done
      batch.updatedAt = nowText()
      batch.error = null
      persist()
    }

    batch.status = '已通过'
    batch.done = ids.length
    batch.error = null
    batch.updatedAt = nowText()
    persist()

    const acceptedCount = plan.filter((item) => item.mode === 'accept').length
    const resumed = start > 0
    return {
      ok: true,
      reapplied: acceptedCount > 0,
      batchId,
      status: '已通过',
      processed,
      message: resumed
        ? `已从断点续做并整批通过（新验收 ${acceptedCount} 条，断点 ${start}/${ids.length}）`
        : `整批验收通过 ${acceptedCount} 条，费用已结算、巡检待办已同步关闭`,
    }
  } catch (error) {
    // 5) 本轮任何写入异常：整批回退到本轮开始快照，断点保留在 start，可直接续做。
    state.modules[MODULE] = snapshot.modules.stationhouse
    state.feeRecords = snapshot.feeRecords
    state.inspectionTodos = snapshot.inspectionTodos
    state.auditLogs = snapshot.auditLogs
    const message = error instanceof Error ? error.message : '验收写入失败'
    // 快照恢复后批次集合也回到本轮开始：重新取回本批次并把断点钉回 start。
    const mark = state.acceptanceBatches.find((item) => item.id === batchId)
    if (mark) {
      mark.status = '进行中'
      mark.done = start
      mark.error = message
      mark.updatedAt = nowText()
    }
    persist()
    appendLog({
      operator,
      module: MODULE,
      action: '通过验收(回退)',
      targetId: batchId,
      detail: `写入异常，本轮已整批回退，保留断点 ${start}/${ids.length}：${message}`,
      ok: false,
    })
    return {
      ok: false,
      reapplied: false,
      batchId,
      status: '进行中',
      processed,
      message: `验收失败，本轮写入已整批回退，可从断点（${start}/${ids.length}）续做：${message}`,
    }
  }
}

export function listAcceptanceBatches(): AcceptanceBatch[] {
  return [...getBatches()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
