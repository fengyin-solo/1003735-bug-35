<template>
  <section class="page" data-module="ledger">
    <header class="page-head">
      <div>
        <h2>台账</h2>
        <p class="page-desc">站房维护验收与各巡检类模块终态动作的台账流水，同一来源只登记一次。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新台账</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">台账条目</span>
        <strong class="stat-value">{{ rows.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">验收登记</span>
        <strong class="stat-value">{{ acceptanceCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">巡检类登记</span>
        <strong class="stat-value">{{ inspectionCount }}</strong>
      </article>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>台账编号</th>
          <th>来源模块</th>
          <th>来源编号</th>
          <th>摘要</th>
          <th>金额</th>
          <th>操作人</th>
          <th>登记时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>{{ row['台账编号'] }}</td>
          <td>{{ row['来源模块'] }}</td>
          <td>{{ row['来源编号'] }}</td>
          <td>{{ row['摘要'] }}</td>
          <td>{{ row['金额'] }}</td>
          <td>{{ row['操作人'] }}</td>
          <td>{{ row['登记时间'] }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="7" class="empty-state">暂无台账流水，验收通过或巡检类记录办结后自动登记</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条台账流水</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listLedgerEntries } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const rows = ref<EntryRow[]>([])
const acceptanceCount = computed(
  () => rows.value.filter((row) => row['来源模块'] === 'stationhouse').length,
)
const inspectionCount = computed(
  () => rows.value.filter((row) => row['来源模块'] !== 'stationhouse').length,
)

function reload() {
  rows.value = listLedgerEntries()
}

onMounted(reload)
</script>
