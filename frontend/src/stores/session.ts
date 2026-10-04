import { defineStore } from 'pinia'

import type { Role } from '@/data/types'

// 验收权限：只有值班管理员与验收员可以执行「通过验收」；其余角色越权一律拒绝。
const ACCEPTANCE_ROLES: Role[] = ['值班管理员', '验收员']

export const ROLE_OPTIONS: Role[] = ['值班管理员', '验收员', '巡检员', '只读访客']

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    role: '值班管理员' as Role,
    shiftLabel: '白班 08:00-20:00',
    scope: '水文监测站网管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    canAccept: (state) => ACCEPTANCE_ROLES.includes(state.role),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: Role) {
      this.role = role
      this.operator = role
    },
  },
})

/** 供非组件层（验收服务）做越权校验。 */
export function roleCanAccept(role: Role): boolean {
  return ACCEPTANCE_ROLES.includes(role)
}
