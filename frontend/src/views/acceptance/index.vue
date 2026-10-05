<template>
  <section class="page" data-module="acceptance">
    <header class="page-head">
      <div>
        <h2>站房维护验收详情</h2>
        <p class="page-desc">按记录归并展示维护单、费用记录、关联待办与台账流水；验收走统一流程：鉴权、状态守卫、幂等与整批事务。</p>
      </div>
      <div class="page-actions">
        <label class="operator-switch">
          当前操作员
          <select :value="session.operator" @change="switchOperator">
            <option value="值班管理员">值班管理员（含验收员）</option>
            <option value="实习员">实习员（无验收权限）</option>
          </select>
        </label>
      </div>
    </header>

    <div v-if="checkpoint" class="checkpoint-banner">
      <span>
        批次 {{ checkpoint.batchId }} 在记录 {{ checkpoint.failedId ?? '—' }} 处中断：{{ checkpoint.reason }}。
        修复数据后可从断点续做，剩余 {{ checkpoint.remainingIds.length }} 条。
      </span>
      <button class="btn primary" type="button" @click="resumeBatch">从断点续做</button>
    </div>

    <div class="batch-bar">
      <span>已选 {{ selectedIds.length }} 条待验收记录</span>
      <button class="btn primary" type="button" :disabled="!selectedIds.length" @click="acceptSelected">
        批量通过验收
      </button>
      <span class="batch-hint">仅「已完成」可验收；重复验收自动跳过；任一条失败整批回退。</span>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>验收</th>
          <th>记录编号</th>
          <th>站点编号</th>
          <th>维护类型</th>
          <th>维护日期</th>
          <th>费用支出</th>
          <th>费用状态</th>
          <th>关联待办</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="String(row.id)">
          <tr>
            <td>
              <input
                v-if="row.status === '已完成'"
                type="checkbox"
                :checked="selectedIds.includes(Number(row.id))"
                @change="toggleSelect(Number(row.id))"
              />
              <span v-else>—</span>
            </td>
            <td>{{ row['记录编号'] }}</td>
            <td>{{ row['站点编号'] }}</td>
            <td>{{ row['维护类型'] }}</td>
            <td>{{ row['维护日期'] }}</td>
            <td>{{ row['费用支出'] }}</td>
            <td>{{ row['费用状态'] }}</td>
            <td>{{ todoSummary(row) }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="toggleDetail(Number(row.id))">
                {{ expandedId === Number(row.id) ? '收起详情' : '查看详情' }}
              </button>
              <button
                v-if="row.status === '已完成'"
                class="link"
                type="button"
                @click="accept([Number(row.id)])"
              >
                通过验收
              </button>
            </td>
          </tr>
          <tr v-if="expandedId === Number(row.id)" class="detail-row">
            <td colspan="10">
              <div class="detail-grid">
                <section>
                  <h3>费用记录</h3>
                  <ul>
                    <li v-for="fee in detailOf(row).fees" :key="String(fee.id)">
                      {{ fee['记录编号'] }} · 金额 {{ fee['费用金额'] }} · {{ fee['费用状态'] }}
                    </li>
                    <li v-if="!detailOf(row).fees.length">暂无费用记录</li>
                  </ul>
                </section>
                <section>
                  <h3>关联待办</h3>
                  <ul>
                    <li v-for="todo in detailOf(row).todos" :key="String(todo.id)">
                      {{ todo['待办内容'] }} · {{ todo['待办状态'] }}
                    </li>
                    <li v-if="!detailOf(row).todos.length">暂无关联待办</li>
                  </ul>
                </section>
                <section>
                  <h3>台账流水</h3>
                  <ul>
                    <li v-for="entry in detailOf(row).ledger" :key="String(entry.id)">
                      {{ entry['台账编号'] }} · {{ entry['摘要'] }} · {{ entry['登记时间'] }} · {{ entry['操作人'] }}
                    </li>
                    <li v-if="!detailOf(row).ledger.length">暂无台账流水</li>
                  </ul>
                </section>
              </div>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td colspan="10" class="empty-state">暂无站房维护记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条站房维护记录（按记录归并，不重复显示）</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import {
  acceptMaintenanceBatch,
  acceptanceCheckpoint,
  getAcceptanceDetail,
  listMaintenanceEntries,
  resumeAcceptanceBatch,
} from '@/api/local-service'
import type { AcceptanceCheckpoint, AcceptanceDetail, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const selectedIds = ref<number[]>([])
const expandedId = ref<number | null>(null)
const checkpoint = ref<AcceptanceCheckpoint | null>(null)
const errorMessage = ref('')
const noticeMessage = ref('')
const detailCache = ref<Map<number, AcceptanceDetail>>(new Map())

function switchOperator(event: Event) {
  session.switchOperator((event.target as HTMLSelectElement).value)
}

function toggleSelect(id: number) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function toggleDetail(id: number) {
  expandedId.value = expandedId.value === id ? null : id
}

function detailOf(row: EntryRow): AcceptanceDetail {
  const cached = detailCache.value.get(Number(row.id))
  if (cached) {
    return cached
  }
  const detail = getAcceptanceDetail(Number(row.id))
  if (detail) {
    detailCache.value.set(Number(row.id), detail)
    return detail
  }
  return { record: row, fees: [], todos: [], ledger: [] }
}

function todoSummary(row: EntryRow): string {
  const todos = detailOf(row).todos
  if (!todos.length) {
    return '无'
  }
  const open = todos.filter((todo) => todo['待办状态'] !== '已完成').length
  return open > 0 ? `${open} 条待处理` : '已同步完成'
}

function acceptSelected() {
  accept(selectedIds.value)
}

function accept(ids: number[]) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = acceptMaintenanceBatch(ids, session.operatorProfile)
  showResult(result.ok, result.message)
}

function resumeBatch() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = resumeAcceptanceBatch(session.operatorProfile)
  showResult(result.ok, result.message)
}

function showResult(ok: boolean, message: string) {
  if (ok) {
    noticeMessage.value = message
    selectedIds.value = []
  } else {
    errorMessage.value = message
  }
  reload()
}

function reload() {
  try {
    const payload = listMaintenanceEntries()
    rows.value = payload.items
    total.value = payload.total
    checkpoint.value = acceptanceCheckpoint()
    detailCache.value = new Map()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '验收详情读取失败'
  }
}

onMounted(reload)
</script>
