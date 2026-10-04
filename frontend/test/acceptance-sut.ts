// 测试装配层：暴露验收链路所需的内部函数与可重复构造的夹具。
// 生产代码不感知测试；这里只做再导出与种子构造。
import { acceptStationhouse, listAcceptanceBatches } from '../src/api/acceptance'
import { listEntries, runAction } from '../src/api/local-service'
import {
  dedupeRows,
  getFees,
  getLogs,
  getState,
  getTodos,
  invalidateCache,
  listRows,
  persist,
} from '../src/data/local-store'
import type { EntryRow } from '../src/data/types'

// 夹具基于 seed 的 3 条站房维护，并额外注入重复行：
// STAT-0002 再重复两次（维护列表/验收详情/巡检面板重复显示的同一根因）。
export function stationhouseFixtureRows(): EntryRow[] {
  return [
    {
      id: 1,
      status: '待安排',
      pending: true,
      abnormal: false,
      记录编号: 'STAT-0001',
      站点编号: 'ST-001',
      维护类型: '屋面防水',
      维护内容: '站房屋面防水修补',
      维护单位: '甲维修队',
      维护日期: '2026-09-01',
      费用支出: 1200,
      维护状态: '待安排',
    },
    {
      id: 2,
      status: '已安排',
      pending: true,
      abnormal: true,
      记录编号: 'STAT-0002',
      站点编号: 'ST-002',
      维护类型: '门窗更换',
      维护内容: '门窗密封更换',
      维护单位: '乙维修队',
      维护日期: '2026-09-02',
      费用支出: 2500,
      维护状态: '已安排',
    },
    // 同一业务键 STAT-0002 的重复导入行（不同 id）
    {
      id: 20,
      status: '已安排',
      pending: true,
      abnormal: true,
      记录编号: 'STAT-0002',
      站点编号: 'ST-002',
      维护类型: '门窗更换',
      维护内容: '门窗密封更换',
      维护单位: '乙维修队',
      维护日期: '2026-09-02',
      费用支出: 2500,
      维护状态: '已安排',
    },
    {
      id: 21,
      status: '已安排',
      pending: true,
      abnormal: true,
      记录编号: 'STAT-0002',
      站点编号: 'ST-002',
      维护类型: '门窗更换',
      维护内容: '门窗密封更换',
      维护单位: '乙维修队',
      维护日期: '2026-09-02',
      费用支出: 2500,
      维护状态: '已安排',
    },
    {
      id: 3,
      status: '施工中',
      pending: true,
      abnormal: false,
      记录编号: 'STAT-0003',
      站点编号: 'ST-003',
      维护类型: '墙体修缮',
      维护内容: '站房墙体修缮',
      维护单位: '丙维修队',
      维护日期: '2026-09-03',
      费用支出: 3750,
      维护状态: '施工中',
    },
  ]
}

export function seedStationhouseFixtureRaw(): EntryRow[] {
  return JSON.parse(JSON.stringify(stationhouseFixtureRows())) as EntryRow[]
}

export function seedStationhouseFixture(): void {
  invalidateCache()
  installRows(stationhouseFixtureRows())
}

// 残留态夹具：旧版本数据——记录已验收，但费用只有行内字段（曾残留未结算）。
export function seedResidualFixture(): void {
  invalidateCache()
  const rows: EntryRow[] = [
    {
      id: 99,
      status: '已验收',
      pending: false,
      abnormal: false,
      记录编号: 'STAT-0099',
      站点编号: 'ST-099',
      维护类型: '电路检修',
      维护内容: '站房电路检修',
      维护单位: '丁维修队',
      维护日期: '2026-08-20',
      费用支出: 800,
      维护状态: '已验收',
    },
  ]
  installRows(rows)
}

function installRows(rows: EntryRow[]): void {
  // 通过 localStorage 写入旧版结构，强制走迁移/对账路径，顺便验证兼容逻辑。
  const payload = JSON.parse(JSON.stringify({ stationhouse: rows }))
  globalThis.window.localStorage.setItem('hydrology-monitor-station:entries', JSON.stringify(payload))
  invalidateCache()
}

// 测试专用：直接推进状态（绕过闸门），用于制造「修复后续做」等前置数据。
export function runActionDirect(key: string, id: number, status: string): void {
  invalidateCache()
  const state = getState()
  const row = state.modules[key].find((item: EntryRow) => Number(item.id) === id)
  if (row) {
    row.status = status
    row.pending = status !== '已验收'
  }
  persist()
  invalidateCache()
}

export {
  acceptStationhouse,
  dedupeRows,
  getFees,
  getLogs,
  getTodos,
  invalidateCache,
  listAcceptanceBatches,
  listEntries,
  listRows,
  runAction,
}
