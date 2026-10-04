<template>
  <section class="ledger" :data-ledger="moduleKey">
    <header class="ledger-head">
      <h3>{{ title }}</h3>
      <button class="btn ghost" type="button" @click="reload">刷新台账</button>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">台账总量</span>
        <strong class="stat-value">{{ snapshot?.summary.total ?? 0 }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待处理</span>
        <strong class="stat-value">{{ snapshot?.summary.pending ?? 0 }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">终态（已验收/已通过等）</span>
        <strong class="stat-value">{{ snapshot?.summary.accepted ?? 0 }}</strong>
      </article>
      <article v-if="showFee" class="stat-card">
        <span class="stat-label">费用记录（已结算/未结算）</span>
        <strong class="stat-value">
          {{ snapshot?.summary.feeSettled ?? 0 }}/{{ snapshot?.summary.feeUnsettled ?? 0 }}
        </strong>
      </article>
      <article v-if="showFee" class="stat-card">
        <span class="stat-label">费用总额（元）</span>
        <strong class="stat-value">{{ feeTotalText }}</strong>
      </article>
      <article v-if="showTodos" class="stat-card">
        <span class="stat-label">关联待办（待复核）</span>
        <strong class="stat-value">{{ snapshot?.summary.openTodos ?? 0 }}</strong>
      </article>
    </div>

    <div v-if="showTodos && (snapshot?.todos.length ?? 0) > 0" class="ledger-block">
      <h4>关联待办</h4>
      <table class="data-table">
        <thead>
          <tr><th>待办</th><th>来源记录</th><th>站房/站点</th><th>状态</th><th>关闭时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="todo in snapshot?.todos" :key="todo.key">
            <td>{{ todo.title }}</td>
            <td>{{ todo.recordNo }}</td>
            <td>{{ todo.stationNo }}</td>
            <td>{{ todo.status }}</td>
            <td>{{ todo.closedAt ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showFee && (snapshot?.feeRecords.length ?? 0) > 0" class="ledger-block">
      <h4>费用台账<span class="ledger-tip">（含历史迁移费用，验收联动结算）</span></h4>
      <table class="data-table">
        <thead>
          <tr><th>维护记录</th><th>站点编号</th><th>金额（元）</th><th>费用状态</th><th>结算时间</th><th>来源</th></tr>
        </thead>
        <tbody>
          <tr v-for="fee in snapshot?.feeRecords" :key="fee.key">
            <td>{{ fee.recordNo }}</td>
            <td>{{ fee.stationNo }}</td>
            <td>{{ fee.amount.toFixed(2) }}</td>
            <td :class="fee.status === '已结算' ? 'ledger-ok' : 'ledger-warn'">{{ fee.status }}</td>
            <td>{{ fee.settledAt ?? '—' }}</td>
            <td>{{ fee.legacy ? '历史费用迁移' : '验收链路写入' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="ledger-block">
      <h4>操作流水</h4>
      <table class="data-table" v-if="(snapshot?.logs.length ?? 0) > 0">
        <thead>
          <tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>结果</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="log in snapshot?.logs" :key="log.id">
            <td>{{ log.at }}</td>
            <td>{{ log.operator }}</td>
            <td>{{ log.action }}</td>
            <td>{{ log.targetId }}</td>
            <td :class="log.ok ? 'ledger-ok' : 'ledger-warn'">{{ log.ok ? '成功' : '拒绝/回退' }}</td>
            <td>{{ log.detail }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">暂无台账流水</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { loadLedger } from '@/api/local-service'
import type { LedgerSnapshot } from '@/data/types'

const props = withDefaults(
  defineProps<{
    moduleKey: string
    title?: string
    showFee?: boolean
    showTodos?: boolean
  }>(),
  {
    title: '业务台账',
    showFee: false,
    showTodos: false,
  },
)

const snapshot = ref<LedgerSnapshot | null>(null)
// 外部动作（验收/流转）后可调 reload，用 key 触发也行，这里显式暴露。
const feeTotalText = computed(() => (snapshot.value?.summary.feeTotal ?? 0).toFixed(2))

function reload() {
  snapshot.value = loadLedger(props.moduleKey)
}

defineExpose({ reload })

onMounted(reload)
</script>

<style scoped>
.ledger {
  margin-top: 20px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.ledger-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.ledger-head h3 {
  margin: 0;
  font-size: 15px;
}
.ledger-block {
  margin-top: 12px;
}
.ledger-block h4 {
  margin: 0 0 6px;
  font-size: 13px;
}
.ledger-tip {
  font-weight: 400;
  color: var(--muted);
  font-size: 12px;
}
.ledger-ok {
  color: #067647;
}
.ledger-warn {
  color: #b42318;
}
</style>
