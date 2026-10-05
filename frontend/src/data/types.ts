/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 操作员：验收等敏感动作按角色鉴权，越权调用必须被拒绝。 */
export type Operator = {
  name: string
  roles: string[]
}

/** 验收详情：一条维护记录 + 归并后的费用记录、关联待办、台账流水。 */
export type AcceptanceDetail = {
  record: EntryRow
  fees: EntryRow[]
  todos: EntryRow[]
  ledger: EntryRow[]
}

/** 批量验收结果：accepted 本次新验收，skipped 幂等跳过（此前已生效）。 */
export type BatchAcceptResult = {
  ok: boolean
  message: string
  accepted: number[]
  skipped: number[]
  failedId?: number
  resumedFromCheckpoint?: boolean
}

/** 验收断点：批次失败整批回落后记录现场，修复数据后从断点续做。 */
export type AcceptanceCheckpoint = {
  batchId: string
  remainingIds: number[]
  failedId?: number
  reason: string
  updatedAt: string
}
