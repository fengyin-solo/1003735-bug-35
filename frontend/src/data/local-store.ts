import { SEED_ROWS } from './seed'
import type { AcceptanceCheckpoint, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
// 验收断点单独存一份：批次失败整批回落后，下次从断点续做。
const CHECKPOINT_KEY = 'hydrology-monitor-station:acceptance-checkpoint'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

function persist(state: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist(next)
}

/** 全量快照：验收批次开工前留底，失败时整批回退到这份。 */
export function snapshotRows(): Record<string, EntryRow[]> {
  return clone(allRows())
}

/** 整体提交：一次事务里改动的多个集合一起落库，不出现写一半的中间态。 */
export function saveAll(next: Record<string, EntryRow[]>): void {
  cache = clone(next)
  persist(cache)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 断点在内存里留一份镜像，无 window 的环境（单测）也能走续做流程。
let checkpointCache: AcceptanceCheckpoint | null = null

export function readAcceptanceCheckpoint(): AcceptanceCheckpoint | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return checkpointCache
  }
  const raw = window.localStorage.getItem(CHECKPOINT_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as AcceptanceCheckpoint
  } catch {
    window.localStorage.removeItem(CHECKPOINT_KEY)
    return null
  }
}

export function writeAcceptanceCheckpoint(checkpoint: AcceptanceCheckpoint): void {
  checkpointCache = checkpoint
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint))
  }
}

export function clearAcceptanceCheckpoint(): void {
  checkpointCache = null
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(CHECKPOINT_KEY)
  }
}

export function storageKey(): string {
  return STORAGE_KEY
}
