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
  /** 列表/面板去重使用的业务键字段（如「记录编号」），缺省时退回 id。 */
  businessKey?: string
  /** 各动作要求的前置状态；不满足即拒绝，避免跳状态（如未完工直接验收）。 */
  actionGuards?: Record<string, string[]>
  /** 需要验收权限才能执行的动作。 */
  acceptanceActions?: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
  /** 去重时被折叠掉的重复记录条数（同一业务键只保留一条）。 */
  duplicatesRemoved?: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ---------------------------------------------------------------------------
// 验收 + 关联写入链路
// ---------------------------------------------------------------------------

/** 费用记录：从站房维护行内「费用支出」迁移而来，验收时状态随业务一起流转。 */
export type FeeRecord = {
  /** 业务键：${stationhouseId}，一条站房维护至多一条费用，天然幂等。 */
  key: string
  stationhouseId: number
  recordNo: string
  stationNo: string
  amount: number
  /** 未结算（兼容历史数据）→ 已结算（验收通过时联动写入）。 */
  status: '未结算' | '已结算'
  settledAt: string | null
  /** true 表示从旧版行内「费用支出」迁移而来，迁移与后续读取都必须继续兼容。 */
  legacy: boolean
}

/** 巡检侧待办：站房维护关联写入的现场复核任务。 */
export type InspectionTodo = {
  /** 业务键：stationhouse:${stationhouseId}，重复执行只 upsert 一次。 */
  key: string
  sourceModule: 'stationhouse'
  sourceId: number
  recordNo: string
  stationNo: string
  title: string
  status: '待复核' | '已关闭'
  createdAt: string
  closedAt: string | null
}

export type AuditLogEntry = {
  id: number
  at: string
  operator: string
  module: string
  action: string
  targetId: number | string
  detail: string
  ok: boolean
}

/** 整批验收的断点游标：done 之前的条目都已提交，失败后重跑从 done 续做。 */
export type AcceptanceBatch = {
  id: string
  operator: string
  ids: number[]
  done: number
  status: '进行中' | '已通过' | '已回退'
  createdAt: string
  updatedAt: string
  error: string | null
}

export type AcceptanceItemResult = {
  id: number
  recordNo: string
  ok: boolean
  message: string
}

export type AcceptanceResult = {
  ok: boolean
  /** 本次是否真的执行了写入；false 表示命中幂等，直接返回既有结果。 */
  reapplied: boolean
  batchId: string
  status: AcceptanceBatch['status']
  processed: AcceptanceItemResult[]
  message: string
}

export type Role = '值班管理员' | '验收员' | '巡检员' | '只读访客'

export type LedgerSummary = {
  module: string
  total: number
  pending: number
  accepted: number
  feeCount: number
  feeSettled: number
  feeUnsettled: number
  feeTotal: number
  openTodos: number
}

export type LedgerSnapshot = {
  summary: LedgerSummary
  feeRecords: FeeRecord[]
  todos: InspectionTodo[]
  logs: AuditLogEntry[]
}
