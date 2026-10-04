<template>
  <section class="link-panel" data-panel="stationhouse-link">
    <header class="ledger-head">
      <h3>站房维护关联面板</h3>
      <button class="btn ghost" type="button" @click="reload">刷新</button>
    </header>
    <p class="accept-tip">
      与站房维护列表、验收详情共用同一份去重数据；完工记录在此生成「现场复核」待办，验收后自动关闭。
    </p>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">站房维护记录</span>
        <strong class="stat-value">{{ rows.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待复核</span>
        <strong class="stat-value">{{ openTodos.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已关闭</span>
        <strong class="stat-value">{{ todos.length - openTodos.length }}</strong>
      </article>
    </div>

    <div class="ledger-block">
      <h4>站房记录（按记录编号去重）</h4>
      <table class="data-table">
        <thead>
          <tr><th>记录编号</th><th>站点编号</th><th>维护类型</th><th>维护单位</th><th>维护日期</th><th>维护状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td>{{ row['记录编号'] }}</td>
            <td>{{ row['站点编号'] }}</td>
            <td>{{ row['维护类型'] }}</td>
            <td>{{ row['维护单位'] }}</td>
            <td>{{ row['维护日期'] }}</td>
            <td>{{ row.status }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="ledger-block">
      <h4>关联待办</h4>
      <table class="data-table" v-if="todos.length">
        <thead>
          <tr><th>待办</th><th>来源记录</th><th>站点编号</th><th>状态</th><th>生成时间</th><th>关闭时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="todo in todos" :key="todo.key">
            <td>{{ todo.title }}</td>
            <td>{{ todo.recordNo }}</td>
            <td>{{ todo.stationNo }}</td>
            <td :class="todo.status === '已关闭' ? 'ledger-ok' : 'ledger-warn'">{{ todo.status }}</td>
            <td>{{ todo.createdAt }}</td>
            <td>{{ todo.closedAt ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">暂无关联待办：站房维护确认完工后会自动生成</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listEntries } from '@/api/local-service'
import { getTodos } from '@/data/local-store'
import type { EntryRow, InspectionTodo } from '@/data/types'

const rows = ref<EntryRow[]>([])
const todos = ref<InspectionTodo[]>([])
const openTodos = computed(() => todos.value.filter((todo) => todo.status === '待复核'))

function reload() {
  rows.value = listEntries('stationhouse').items
  todos.value = getTodos()
}

defineExpose({ reload })
onMounted(reload)
</script>

<style scoped>
.link-panel {
  margin-top: 20px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.accept-tip {
  font-size: 12px;
  color: var(--muted);
  margin: 6px 0;
}
.ledger-block {
  margin-top: 12px;
}
.ledger-block h4 {
  margin: 0 0 6px;
  font-size: 13px;
}
.ledger-ok {
  color: #067647;
}
.ledger-warn {
  color: #b42318;
}
</style>
