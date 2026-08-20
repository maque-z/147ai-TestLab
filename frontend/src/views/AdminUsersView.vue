<template>
  <div class="admin-users">
    <div class="toolbar">
      <span class="count text-muted">共 {{ users.length }} 个账号</span>
      <button class="nm-btn" :disabled="loading" @click="load">
        {{ loading ? '加载中...' : '刷新' }}
      </button>
    </div>

    <n-data-table
      :columns="columns"
      :data="users"
      :loading="loading"
      :bordered="false"
      :row-key="(row: User) => row.id"
    />

    <n-modal v-model:show="resetOpen" preset="dialog" title="重置密码">
      <template #default>
        <p class="reset-target">
          为 <strong>{{ resetTarget?.username }}</strong> 设置新密码
        </p>
        <n-input
          v-model:value="newPassword"
          type="password"
          show-password-on="click"
          placeholder="8-72 字节"
          @keyup.enter="confirmReset"
        />
        <p v-if="resetError" class="reset-error">{{ resetError }}</p>
      </template>
      <template #action>
        <button class="nm-btn" @click="resetOpen = false">取消</button>
        <button class="nm-btn primary" :disabled="resetting" @click="confirmReset">
          {{ resetting ? '提交中...' : '确定' }}
        </button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { h, onMounted, ref } from 'vue'
import { NButton, NDataTable, NInput, NModal, NPopconfirm, NTag, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import type { User } from '@/types'
import * as adminApi from '@/api/admin'
import { useAuthStore } from '@/stores/auth'
import { checkPassword } from '@/utils/password'

const auth = useAuthStore()
const message = useMessage()

const users = ref<User[]>([])
const loading = ref(false)

const resetOpen = ref(false)
const resetTarget = ref<User | null>(null)
const newPassword = ref('')
const resetError = ref('')
const resetting = ref(false)

/** Read the server's message when there is one. Every 4xx here carries a Chinese
 *  detail worth showing verbatim — "不能删除自己", "不能删除最后一个管理员" — and
 *  replacing them with a generic string would hide the reason the action failed. */
function reason(e: any, fallback: string): string {
  return e?.response?.data?.detail || fallback
}

async function load() {
  loading.value = true
  try {
    users.value = await adminApi.listUsers()
  } catch (e: any) {
    message.error(reason(e, '加载账号列表失败'))
  } finally {
    loading.value = false
  }
}

async function toggleActive(row: User) {
  try {
    const updated = await adminApi.setActive(row.id, !row.is_active)
    Object.assign(row, updated)
    message.success(updated.is_active ? '已启用' : '已禁用')
  } catch (e: any) {
    message.error(reason(e, '操作失败'))
  }
}

async function remove(row: User) {
  try {
    await adminApi.deleteUser(row.id)
    users.value = users.value.filter(u => u.id !== row.id)
    message.success(`已删除 ${row.username}`)
  } catch (e: any) {
    message.error(reason(e, '删除失败'))
  }
}

function openReset(row: User) {
  resetTarget.value = row
  newPassword.value = ''
  resetError.value = ''
  resetOpen.value = true
}

async function confirmReset() {
  const target = resetTarget.value
  if (!target) return

  // Same rule the backend enforces, checked here so the admin sees it before a
  // round trip that would come back as an unreadable 422 body.
  const problem = checkPassword(newPassword.value)
  if (problem) {
    resetError.value = problem
    return
  }

  resetting.value = true
  try {
    await adminApi.resetPassword(target.id, newPassword.value)
    resetOpen.value = false
    message.success(`已重置 ${target.username} 的密码`)
  } catch (e: any) {
    resetError.value = reason(e, '重置失败')
  } finally {
    resetting.value = false
  }
}

const columns: DataTableColumns<User> = [
  { title: '用户名', key: 'username' },
  {
    title: '注册时间',
    key: 'created_at',
    render: row => new Date(row.created_at).toLocaleString('zh-CN')
  },
  {
    title: '状态',
    key: 'status',
    render: row => {
      if (row.is_admin) return h(NTag, { type: 'info', bordered: false }, () => '管理员')
      return row.is_active
        ? h(NTag, { type: 'success', bordered: false }, () => '正常')
        : h(NTag, { type: 'error', bordered: false }, () => '已禁用')
    }
  },
  {
    title: '操作',
    key: 'actions',
    render: row => {
      // The server refuses these for the current account anyway (400 "不能删除自己").
      // Hiding them here means the admin never clicks something that cannot work.
      if (row.id === auth.user?.id) return h('span', { class: 'text-muted' }, '—')

      return h('div', { class: 'row-actions' }, [
        h(NButton, { size: 'small', secondary: true, onClick: () => toggleActive(row) },
          () => (row.is_active ? '禁用' : '启用')),
        h(NButton, { size: 'small', secondary: true, onClick: () => openReset(row) },
          () => '重置密码'),
        h(NPopconfirm,
          { onPositiveClick: () => remove(row), positiveText: '删除', negativeText: '取消' },
          {
            trigger: () => h(NButton, { size: 'small', secondary: true, type: 'error' }, () => '删除'),
            default: () => `删除 ${row.username}？该账号的 API 配置会一并清除，不可恢复。`
          })
      ])
    }
  }
]

onMounted(load)
</script>

<style scoped>
.admin-users { padding: 4px; }

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.count { font-size: 13px; }

:deep(.row-actions) { display: flex; gap: 8px; }

.reset-target { margin: 0 0 12px; font-size: 14px; }
.reset-error { margin: 8px 0 0; color: #c0564a; font-size: 13px; }
</style>
