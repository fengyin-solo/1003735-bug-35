import { defineStore } from 'pinia'

import type { Operator } from '@/data/types'

// 值排班可切换的两套身份：验收动作只认「验收员」角色，用来演示越权验收被拒绝。
const PROFILES: Record<string, Operator> = {
  值班管理员: { name: '值班管理员', roles: ['值班员', '验收员'] },
  实习员: { name: '实习员', roles: ['值班员'] },
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    roles: [...PROFILES.值班管理员.roles] as string[],
    shiftLabel: '白班 08:00-20:00',
    scope: '水文监测站网管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    canAccept: (state) => state.roles.includes('验收员'),
    operatorProfile: (state): Operator => ({ name: state.operator, roles: [...state.roles] }),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    switchOperator(name: string) {
      const profile = PROFILES[name]
      if (!profile) {
        return
      }
      this.operator = profile.name
      this.roles = [...profile.roles]
    },
  },
})
