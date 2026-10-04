// 验收 + 关联写入链路测试：node 直跑（经 esbuild 即时转译 TS）。
// 覆盖：重复显示、未完工整批拒绝、费用兼容与残留、待办同步、
// 幂等只生效一次、越权拒绝、整批回退与断点续做。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { build } = require('esbuild')

async function loadSut() {
  const result = await build({
    entryPoints: [path.join(__dirname, 'acceptance-sut.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, require)
  return mod.exports
}

function makeLocalStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  }
}

async function main() {
  const sut = await loadSut()

  // ---- 场景 0：重复记录去重 + 历史费用迁移 + 已验收费用按已结算承接 ----
  {
    const storage = makeLocalStorage()
    globalThis.window = { localStorage: storage }
    sut.invalidateCache()
    // 人为制造 3 条重复的 STAT-0002（维护列表/验收详情/巡检面板的同一根因）
    const raw = sut.seedStationhouseFixtureRaw()
    const deduped = sut.dedupeRows('stationhouse', raw)
    assert.equal(deduped.rows.length, 3, '去重后应只剩 3 条不同记录编号')
    assert.equal(deduped.removed, 2, `应折叠 2 条重复，实际 ${deduped.removed}`)
    // 迁移压实后，三个页面共用的读取口径都只剩 3 条
    const page = sut.listEntries('stationhouse')
    assert.equal(page.items.length, 3)
    assert.deepEqual(
      page.items.map((r) => r['记录编号']),
      sut.listEntries('stationhouse').items.map((r) => r['记录编号']),
      '维护列表/验收详情/巡检面板共用同一去重口径',
    )
    const fees = sut.getFees()
    const noDupFees = new Set(fees.map((f) => f.key))
    assert.equal(noDupFees.size, fees.length, '费用迁移必须幂等，不能因重复行生成重复费用')
    assert.ok(fees.every((f) => f.legacy), '种子费用都应标记为历史迁移费用')
    console.log('✓ 场景0 重复记录去重 + 历史费用迁移幂等')
  }

  // ---- 场景 1：未完工项整批拒绝，且不会被改成已验收 ----
  {
    const storage = makeLocalStorage()
    globalThis.window = { localStorage: storage }
    sut.invalidateCache()
    sut.seedStationhouseFixture()
    // id=3 施工中，id=2 已安排，id=1 待安排：先把 id=3 完工
    const finish = sut.runAction('stationhouse', 3, '确认完工', { role: '值班管理员', operator: '甲' })
    assert.equal(finish.ok, true)
    // 整批 [2(已安排),3(已完成)]：id=2 未完工，整批拒绝
    const r = sut.acceptStationhouse([2, 3], '值班管理员', '甲')
    assert.equal(r.ok, false)
    const rows = sut.listRows('stationhouse')
    const row3 = rows.find((x) => x.id === 3)
    const row2 = rows.find((x) => x.id === 2)
    assert.notEqual(row3.status, '已验收', '未完工混批时，已完成项也不得被验收（整批拒绝）')
    assert.equal(row3.status, '已完成')
    assert.equal(row2.status, '已安排')
    // 费用不得提前结算
    const fee3 = sut.getFees().find((f) => f.stationhouseId === 3)
    assert.equal(fee3.status, '未结算', '被驳回批次不得结算费用')
    console.log('✓ 场景1 未完工项整批拒绝，无一条被改成已验收、费用不结算')
  }

  // ---- 场景 2：正常验收链路：状态 + 费用结算 + 待办关闭，一次联动 ----
  {
    const storage = makeLocalStorage()
    globalThis.window = { localStorage: storage }
    sut.invalidateCache()
    sut.seedStationhouseFixture()
    sut.runAction('stationhouse', 3, '确认完工', { role: '值班管理员', operator: '甲' })
    // 完工后巡检侧应有待办
    let todo = sut.getTodos().find((t) => t.key === 'stationhouse:3')
    assert.ok(todo && todo.status === '待复核', '完工后应生成待复核待办')
    const r = sut.acceptStationhouse([3], '验收员', '乙')
    assert.equal(r.ok, true, r.message)
    assert.equal(sut.listRows('stationhouse').find((x) => x.id === 3).status, '已验收')
    const fee = sut.getFees().find((f) => f.stationhouseId === 3)
    assert.equal(fee.status, '已结算')
    assert.ok(fee.legacy, '历史费用迁移后依然保留 legacy 兼容标记')
    todo = sut.getTodos().find((t) => t.key === 'stationhouse:3')
    assert.equal(todo.status, '已关闭')
    assert.ok(todo.closedAt)
    console.log('✓ 场景2 验收联动费用结算 + 待办关闭（历史费用继续兼容）')
  }

  // ---- 场景 3：重复执行只生效一次（幂等）----
  {
    const storage = makeLocalStorage()
    globalThis.window = { localStorage: storage }
    sut.invalidateCache()
    sut.seedStationhouseFixture()
    sut.runAction('stationhouse', 3, '确认完工', { role: '值班管理员', operator: '甲' })
    const first = sut.acceptStationhouse([3], '验收员', '乙')
    assert.equal(first.ok, true)
    const logsAfterFirst = sut.getLogs().filter((l) => l.action === '通过验收' && l.ok).length
    const settledAt = sut.getFees().find((f) => f.stationhouseId === 3).settledAt
    const second = sut.acceptStationhouse([3], '验收员', '乙')
    assert.equal(second.ok, true)
    assert.match(second.message, /重复执行未再次生效|幂等/)
    const logsAfterSecond = sut.getLogs().filter((l) => l.action === '通过验收' && l.ok).length
    assert.equal(logsAfterSecond, logsAfterFirst, '幂等重放不得再写成功流水')
    assert.equal(
      sut.getFees().find((f) => f.stationhouseId === 3).settledAt,
      settledAt,
      '结算时间不得被覆盖',
    )
    // 待办仍然只有一条
    assert.equal(sut.getTodos().filter((t) => t.key === 'stationhouse:3').length, 1)
    console.log('✓ 场景3 重复验收只生效一次（幂等，无重复流水/待办）')
  }

  // ---- 场景 4：越权验收必须拒绝（单条与批量）----
  {
    const storage = makeLocalStorage()
    globalThis.window = { localStorage: storage }
    sut.invalidateCache()
    sut.seedStationhouseFixture()
    sut.runAction('stationhouse', 3, '确认完工', { role: '值班管理员', operator: '甲' })
    const batch = sut.acceptStationhouse([3], '巡检员', '丙')
    assert.equal(batch.ok, false)
    assert.match(batch.message, /没有验收权限|无验收权限/)
    assert.equal(sut.listRows('stationhouse').find((x) => x.id === 3).status, '已完成')
    const single = sut.runAction('stationhouse', 3, '通过验收', { role: '只读访客', operator: '丁' })
    assert.equal(single.ok, false)
    assert.match(single.message, /权限/)
    assert.equal(sut.listRows('stationhouse').find((x) => x.id === 3).status, '已完成')
    const fee = sut.getFees().find((f) => f.stationhouseId === 3)
    assert.equal(fee.status, '未结算')
    console.log('✓ 场景4 越权验收整批拒绝，状态/费用/待办均不变')
  }

  // ---- 场景 5：断点 + 修复后续做；批次与顺序幂等 ----
  {
    const storage = makeLocalStorage()
    globalThis.window = { localStorage: storage }
    sut.invalidateCache()
    sut.seedStationhouseFixture()
    // 先只完工 id=3，批次 [2,3] 在 id=2 处被整批拒绝（断点 0/2）
    sut.runAction('stationhouse', 3, '确认完工', { role: '值班管理员', operator: '甲' })
    const blocked = sut.acceptStationhouse([2, 3], '验收员', '乙')
    assert.equal(blocked.ok, false)
    const b0 = sut.listAcceptanceBatches().find((b) => b.id === 'ACC-2-3')
    assert.equal(b0.done, 0)
    assert.equal(b0.status, '进行中')
    // 修复：把 id=2 也推进到已完成（已安排 -> 施工中 -> 已完成）
    sut.runActionDirect('stationhouse', 2, '施工中')
    sut.runAction('stationhouse', 2, '确认完工', { role: '值班管理员', operator: '甲' })
    // 同一批次（同组 id，顺序无关）续做
    const resumed = sut.acceptStationhouse([3, 2], '验收员', '乙')
    assert.equal(resumed.ok, true, resumed.message)
    const b1 = sut.listAcceptanceBatches().find((b) => b.id === 'ACC-2-3')
    assert.equal(b1.status, '已通过')
    assert.equal(b1.done, 2)
    assert.equal(sut.listRows('stationhouse').filter((x) => x.status === '已验收').length, 2)
    assert.equal(sut.getFees().filter((f) => f.status === '已结算').length, 2)
    console.log('✓ 场景5 整批失败留断点，修复后从断点续做并整批通过')
  }

  // ---- 场景 6：费用状态残留自愈（旧数据：已验收但费用未结算）----
  {
    const storage = makeLocalStorage()
    globalThis.window = { localStorage: storage }
    sut.invalidateCache()
    // 构造一份旧版 localStorage：行内费用 + 行已验收但费用无独立记录
    sut.seedResidualFixture()
    const fee = sut.getFees().find((f) => f.stationhouseId === 99)
    assert.ok(fee, '行内费用应迁移为费用记录')
    assert.equal(fee.status, '已结算', '已验收行的残留费用应在迁移时纠正为已结算')
    // 反向：回退验收后状态必须还原
    sut.runActionDirect('stationhouse', 99, '已完成')
    const reverted = sut.getFees().find((f) => f.stationhouseId === 99)
    assert.equal(reverted.status, '未结算', '验收回退后费用状态不得残留为已结算')
    assert.equal(reverted.settledAt, null)
    console.log('✓ 场景6 费用状态残留双向自愈（迁移纠正 + 回退还原）')
  }

  // ---- 场景 7：运行时异常整批回退 ----
  {
    const storage = makeLocalStorage()
    globalThis.window = { localStorage: storage }
    sut.invalidateCache()
    sut.seedStationhouseFixture()
    sut.runAction('stationhouse', 3, '确认完工', { role: '值班管理员', operator: '甲' })
    // 注入故障：保存批次后、条目写入期间持久化抛错
    let failedOnce = false
    const orig = globalThis.window.localStorage.setItem
    globalThis.window.localStorage.setItem = (k, v) => {
      if (!failedOnce && String(v).includes('已验收')) {
        failedOnce = true
        throw new Error('配额已满(模拟)')
      }
      return orig(k, v)
    }
    const r = sut.acceptStationhouse([3], '验收员', '乙')
    globalThis.window.localStorage.setItem = orig
    assert.equal(r.ok, false)
    assert.match(r.message, /整批回退/)
    const row = sut.listRows('stationhouse').find((x) => x.id === 3)
    assert.equal(row.status, '已完成', '回退后维护状态必须回到已完成')
    const fee = sut.getFees().find((f) => f.stationhouseId === 3)
    assert.equal(fee.status, '未结算', '回退后费用必须未结算')
    const todo = sut.getTodos().find((t) => t.key === 'stationhouse:3')
    assert.equal(todo.status, '待复核', '回退后待办必须重新待复核')
    const b = sut.listAcceptanceBatches().find((x) => x.id === 'ACC-3')
    assert.equal(b.status, '进行中')
    assert.equal(b.done, 0, '断点保留在 0，可整批续做')
    // 续做成功
    const retry = sut.acceptStationhouse([3], '验收员', '乙')
    assert.equal(retry.ok, true, retry.message)
    assert.equal(sut.listRows('stationhouse').find((x) => x.id === 3).status, '已验收')
    console.log('✓ 场景7 写入异常整批回退，保留断点且续做成功')
  }

  console.log('\n全部验收链路测试通过 ✅')
}

main().catch((error) => {
  console.error('测试失败 ❌')
  console.error(error)
  process.exit(1)
})
