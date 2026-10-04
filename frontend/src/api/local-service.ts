import { acceptStationhouse, syncCompletionTodo } from '@/api/acceptance'
import {
  allRows,
  appendLog,
  dedupeRows,
  getFees,
  getLogs,
  getTodos,
  listRows,
  resetRows,
  saveRows,
} from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type {
  ActionResult,
  EntryRow,
  LedgerSnapshot,
  LedgerSummary,
  ModuleMeta,
  OverviewResult,
  PageResult,
  Role,
} from '@/data/types'
import { roleCanAccept } from '@/stores/session'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export type Actor = { role: Role; operator: string }

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
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
  // 先按业务键去重再筛选：维护列表、验收详情、巡检面板共用同一读取口径，重复行不重复显示。
  const { rows: unique, removed } = dedupeRows(key, listRows(key))
  const matched = filterRows(unique, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length, duplicatesRemoved: removed }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  actor: Actor = { role: '值班管理员', operator: '值班管理员' },
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  // 验收类动作必须走统一的验收调用链（闸门 / 权限 / 幂等 / 关联写入都在那条链里）。
  if (key === 'stationhouse' && action === '通过验收') {
    const result = acceptStationhouse([id], actor.role, actor.operator)
    const first = result.processed.find((item) => item.id === id)
    return {
      ok: result.ok,
      message: result.ok
        ? `${meta.entity}${first?.recordNo ?? ''} 已通过验收，费用已结算、巡检待办已关闭`
        : result.message,
    }
  }

  // 越权拦截：需要验收权限的动作，非验收角色直接拒绝（任何写入之前）。
  if (meta.acceptanceActions?.includes(action) && !roleCanAccept(actor.role)) {
    appendLog({
      operator: actor.operator,
      module: key,
      action: `${action}(拒绝)`,
      targetId: id,
      detail: `角色「${actor.role}」无权限执行「${action}」`,
      ok: false,
    })
    return { ok: false, message: `当前角色「${actor.role}」没有权限执行「${action}」` }
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

  // 前置状态闸门：例如站房维护只有「施工中」能确认完工、只有「已完成」能验收，
  // 从链头上拦住「未完工项被一并改成已验收」。
  const guard = meta.actionGuards?.[action]
  if (guard && !guard.includes(current)) {
    appendLog({
      operator: actor.operator,
      module: key,
      action: `${action}(驳回)`,
      targetId: id,
      detail: `前置状态不满足：当前「${current}」，要求 ${guard.join(' / ')}`,
      ok: false,
    })
    return {
      ok: false,
      message: `只有「${guard.join('、')}」状态才能${action}，当前为「${current}」`,
    }
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
  saveRows(key, next)

  // 关联写入：站房维护确认完工后，巡检面板同步生成/恢复一条「现场复核」待办。
  if (key === 'stationhouse' && action === '确认完工') {
    syncCompletionTodo(updated)
  }

  appendLog({
    operator: actor.operator,
    module: key,
    action,
    targetId: id,
    detail: `${meta.entity} ${String(updated[meta.businessKey ?? 'id'] ?? id)}：${current} → ${target}`,
    ok: true,
  })
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
  for (const row of listEntries(key).items) {
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
    const entries = rows[meta.key] ?? []
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

// --- 台账 ------------------------------------------------------------------

/**
 * 模块台账：汇总条目/费用/关联待办/操作流水。
 * 所有巡检相关页面都挂同一份口径，费用数据始终从 feeRecords 读（含 legacy 迁移记录）。
 */
export function loadLedger(key: string): LedgerSnapshot {
  const meta = moduleMeta(key)
  const { rows } = dedupeRows(key, listRows(key))
  const fees = getFees()
  const todos = getTodos()
  const logs = getLogs().filter((log) => log.module === key)

  const relatedFees = key === 'stationhouse' ? fees : []
  const relatedTodos = key === 'inspection' ? todos : []

  const summary: LedgerSummary = {
    module: meta.name,
    total: rows.length,
    pending: rows.filter((row) => row.pending).length,
    accepted: rows.filter((row) => String(row.status) === meta.statuses[meta.statuses.length - 1]).length,
    feeCount: relatedFees.length,
    feeSettled: relatedFees.filter((fee) => fee.status === '已结算').length,
    feeUnsettled: relatedFees.filter((fee) => fee.status === '未结算').length,
    feeTotal: relatedFees.reduce((sum, fee) => sum + fee.amount, 0),
    openTodos: relatedTodos.filter((todo) => todo.status === '待复核').length,
  }
  return { summary, feeRecords: relatedFees, todos: relatedTodos, logs }
}
