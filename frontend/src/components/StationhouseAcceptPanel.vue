<template>
  <section class="accept-panel" data-accept="stationhouse">
    <header class="ledger-head">
      <h3>验收详情与批量验收</h3>
      <button class="btn ghost" type="button" @click="reload">刷新</button>
    </header>

    <p class="accept-tip">
      当前角色：<strong :class="store.canAccept ? 'ledger-ok' : 'ledger-warn'">{{ store.role }}</strong>
      ；只有「值班管理员 / 验收员」可执行验收，且仅「已完成」的记录可通过。
      勾选多条即整批验收：重复执行幂等、失败整批回退、可从断点续做。
    </p>

    <div class="accept-toolbar">
      <button class="btn primary" type="button" :disabled="selected.size === 0" @click="submit">
        批量验收所选（{{ selected.size }}）
      </button>
      <button class="btn" type="button" @click="selectAllDone">全选已完成</button>
      <button class="btn ghost" type="button" @click="clearSelection">清空选择</button>
    </div>

    <p v-if="message" :class="lastOk ? 'ledger-ok' : 'error-text'" class="accept-message">{{ message }}</p>

    <table class="data-table">
      <thead>
        <tr>
          <th>选择</th>
          <th>记录编号</th>
          <th>站点编号</th>
          <th>维护类型</th>
          <th>维护日期</th>
          <th>费用支出</th>
          <th>费用状态</th>
          <th>关联待办</th>
          <th>维护状态</th>
        </tr>
      </thead>
      <tbody>
        <!-- 列表与维护主表共用去重后的读取口径，重复导入的记录只出现一次。 -->
        <tr v-for="row in rows" :key="String(row.id)">
          <td>
            <input
              type="checkbox"
              :checked="selected.has(Number(row.id))"
              :disabled="String(row.status) === '已验收'"
              @change="toggle(Number(row.id))"
            />
          </td>
          <td>{{ row['记录编号'] }}</td>
          <td>{{ row['站点编号'] }}</td>
          <td>{{ row['维护类型'] }}</td>
          <td>{{ row['维护日期'] }}</td>
          <td>{{ feeOf(Number(row.id))?.amount.toFixed(2) ?? (row['费用支出'] ?? '—') }}</td>
          <td :class="feeOf(Number(row.id))?.status === '已结算' ? 'ledger-ok' : 'ledger-warn'">
            {{ feeOf(Number(row.id))?.status ?? '未登记' }}
          </td>
          <td :class="todoOf(Number(row.id))?.status === '已关闭' ? 'ledger-ok' : ''">
            {{ todoOf(Number(row.id))?.status ?? '—' }}
          </td>
          <td>{{ row.status }}</td>
        </tr>
      </tbody>
    </table>

    <div v-if="lastResult" class="ledger-block">
      <h4>本次验收明细</h4>
      <table class="data-table">
        <thead>
          <tr><th>记录</th><th>结果</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in lastResult.processed" :key="item.id">
            <td>{{ item.recordNo }}</td>
            <td :class="item.ok ? 'ledger-ok' : 'ledger-warn'">{{ item.ok ? '通过' : '未通过' }}</td>
            <td>{{ item.message }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="batches.length" class="ledger-block">
      <h4>验收批次（断点续做）</h4>
      <table class="data-table">
        <thead>
          <tr><th>批次</th><th>进度</th><th>状态</th><th>最近更新</th><th>断点/失败原因</th></tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="batch.id">
            <td>{{ batch.id }}</td>
            <td>{{ batch.done }}/{{ batch.ids.length }}</td>
            <td :class="batch.status === '已通过' ? 'ledger-ok' : batch.status === '已回退' ? 'ledger-warn' : ''">
              {{ batch.status }}
            </td>
            <td>{{ batch.updatedAt }}</td>
            <td>{{ batch.error ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { acceptStationhouse, listAcceptanceBatches } from '@/api/acceptance'
import { listEntries } from '@/api/local-service'
import { getFees, getTodos } from '@/data/local-store'
import type {
  AcceptanceBatch,
  AcceptanceResult,
  EntryRow,
  FeeRecord,
  InspectionTodo,
} from '@/data/types'
import { useSessionStore } from '@/stores/session'

const emit = defineEmits<{ (e: 'changed'): void }>()

const store = useSessionStore()
const rows = ref<EntryRow[]>([])
const fees = ref<FeeRecord[]>([])
const todos = ref<InspectionTodo[]>([])
const batches = ref<AcceptanceBatch[]>([])
const selected = ref<Set<number>>(new Set())
const message = ref('')
const lastOk = ref(false)
const lastResult = ref<AcceptanceResult | null>(null)

function feeOf(id: number): FeeRecord | undefined {
  return fees.value.find((fee) => fee.stationhouseId === id)
}

function todoOf(id: number): InspectionTodo | undefined {
  return todos.value.find((todo) => todo.sourceId === id)
}

function reload() {
  rows.value = listEntries('stationhouse').items
  fees.value = getFees()
  todos.value = getTodos()
  batches.value = listAcceptanceBatches()
}

function toggle(id: number) {
  const next = new Set(selected.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selected.value = next
}

function selectAllDone() {
  selected.value = new Set(
    rows.value.filter((row) => String(row.status) === '已完成').map((row) => Number(row.id)),
  )
}

function clearSelection() {
  selected.value = new Set()
}

function submit() {
  const ids = [...selected.value]
  const result = acceptStationhouse(ids, store.role, store.operator)
  lastResult.value = result
  lastOk.value = result.ok
  message.value = result.message
  // 幂等命中时不做清退提示；整批通过才清空选择，失败/断点保留所选以便修复后续做。
  if (result.ok) {
    clearSelection()
  }
  reload()
  emit('changed')
}

defineExpose({ reload })
onMounted(reload)
</script>

<style scoped>
.accept-panel {
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
.accept-toolbar {
  display: flex;
  gap: 8px;
  margin: 8px 0;
}
.accept-message {
  font-size: 13px;
  margin: 6px 0;
}
.ledger-ok {
  color: #067647;
}
.ledger-warn,
.error-text {
  color: #b42318;
}
.ledger-block {
  margin-top: 12px;
}
.ledger-block h4 {
  margin: 0 0 6px;
  font-size: 13px;
}
</style>
