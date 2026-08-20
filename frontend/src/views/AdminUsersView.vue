<template>
  <div class="admin-users">
    <div class="toolbar">
      <span class="count text-muted">共 {{ users.length }} 个账号</span>
      <button class="btn btn-sm" :disabled="loading" @click="load">
        <span class="btn-icon">⟳</span> {{ loading ? '加载中...' : '刷新' }}
      </button>
    </div>

    <div class="table-card nm-raised">
      <table class="user-table">
        <thead>
          <tr>
            <th>用户名</th>
            <th>注册时间</th>
            <th>状态</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading && !users.length">
            <td colspan="4" class="placeholder">加载中...</td>
          </tr>
          <tr v-else-if="!users.length">
            <td colspan="4" class="placeholder">没有账号可显示</td>
          </tr>
          <tr v-for="u in users" :key="u.id">
            <td>
              <span v-if="u.username" class="cell-name">{{ u.username }}</span>
              <!-- One row in this database has an empty username. Rendering it
                   as nothing looks like a broken cell, so it is labelled. -->
              <span v-else class="cell-name text-muted">(空用户名)</span>
            </td>
            <td class="cell-time">{{ formatTime(u.created_at) }}</td>
            <td>
              <span class="status">
                <span class="status-dot" :class="statusOf(u).cls">●</span>
                {{ statusOf(u).label }}
              </span>
            </td>
            <td class="col-actions">
              <!-- The server refuses both of these on your own account (400
                   "不能禁用自己" / "不能删除自己"). Showing nothing to click is
                   better than showing a button that cannot work. -->
              <span v-if="u.id === auth.user?.id" class="text-muted">—</span>
              <div v-else class="row-actions">
                <button class="btn btn-xs" @click="toggleActive(u)">
                  {{ u.is_active ? '禁用' : '启用' }}
                </button>
                <button class="btn btn-xs" @click="openReset(u)">重置密码</button>
                <button class="btn btn-xs btn-danger" @click="askDelete(u)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <n-modal
      v-model:show="resetOpen"
      preset="dialog"
      title="重置密码"
      positive-text="确定"
      negative-text="取消"
      @positive-click="confirmReset"
    >
      <div class="dialog-body">
        <p class="dialog-line">
          为 <b>{{ resetTarget?.username }}</b> 设置新密码。该账号当前的登录会话会立即失效。
        </p>
        <n-input
          v-model:value="newPassword"
          type="password"
          show-password-on="click"
          placeholder="8-72 字节（约 24 个汉字）"
          class="nm-inset"
        />
        <p v-if="resetError" class="dialog-error">{{ resetError }}</p>
      </div>
    </n-modal>

    <n-modal
      v-model:show="deleteOpen"
      preset="dialog"
      type="warning"
      title="删除账号"
      positive-text="删除"
      negative-text="取消"
      @positive-click="confirmDelete"
    >
      <div class="dialog-body">
        <p class="dialog-line">
          确定删除 <b>{{ deleteTarget?.username }}</b>？
        </p>
        <p class="dialog-note">
          该账号的两份 API 配置（baseurl 与 api_key）会在同一个事务里一并清除，不可恢复。
        </p>
      </div>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NInput, NModal, useMessage } from 'naive-ui'
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

const deleteOpen = ref(false)
const deleteTarget = ref<User | null>(null)

/** Read the server's message when there is one. Every 4xx here carries a Chinese
 *  detail worth showing verbatim — "不能删除自己", "不能删除最后一个管理员" — and
 *  replacing them with a generic string would hide the reason the action failed. */
function reason(e: any, fallback: string): string {
  const detail = e?.response?.data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail.length) return detail[0]?.msg || fallback
  return fallback
}

/** created_at arrives as naive UTC with no offset ("2026-08-06T08:45:10.163573")
 *  because SQLite drops the offset on write. A bare date-time string like that is
 *  parsed as *local* time by JS, which would render every timestamp 8 hours early
 *  here. Appending Z is what makes it read back as the instant it actually was. */
function formatTime(iso: string): string {
  const utc = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`
  const d = new Date(utc)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function statusOf(u: User): { cls: string; label: string } {
  if (u.is_admin) return { cls: 'admin', label: '管理员' }
  return u.is_active
    ? { cls: 'active', label: '正常' }
    : { cls: 'disabled', label: '已禁用' }
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
    message.success(updated.is_active ? `已启用 ${row.username}` : `已禁用 ${row.username}`)
  } catch (e: any) {
    message.error(reason(e, '操作失败'))
  }
}

function openReset(row: User) {
  resetTarget.value = row
  newPassword.value = ''
  resetError.value = ''
  resetOpen.value = true
}

/** Returning false keeps the dialog open — that is how naive-ui's dialog preset
 *  lets a validation failure stay on screen instead of dismissing the input the
 *  user still has to correct. */
async function confirmReset(): Promise<boolean> {
  const target = resetTarget.value
  if (!target) return true

  // The same rule the backend enforces, checked here so the admin reads it in
  // Chinese rather than as a pydantic 422 body.
  const problem = checkPassword(newPassword.value)
  if (problem) {
    resetError.value = problem
    return false
  }

  try {
    await adminApi.resetPassword(target.id, newPassword.value)
    message.success(`已重置 ${target.username} 的密码`)
    return true
  } catch (e: any) {
    resetError.value = reason(e, '重置失败')
    return false
  }
}

function askDelete(row: User) {
  deleteTarget.value = row
  deleteOpen.value = true
}

async function confirmDelete(): Promise<boolean> {
  const target = deleteTarget.value
  if (!target) return true

  try {
    await adminApi.deleteUser(target.id)
    users.value = users.value.filter(u => u.id !== target.id)
    message.success(`已删除 ${target.username}`)
    return true
  } catch (e: any) {
    message.error(reason(e, '删除失败'))
    return false
  }
}

onMounted(load)
</script>

<style scoped>
.admin-users {
  max-width: 900px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.count { font-size: 12.5px; }

.table-card {
  background: var(--bg);
  border-radius: var(--radius-card);
  padding: 6px 18px 10px;
}

.user-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  color: var(--text-primary);
}

/* The only rule in the table: one hairline under the header. Row separators
   would fight the raised card — the surface already carries the grouping. */
.user-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 12px 10px;
  border-bottom: 1px solid var(--shadow-dark);
  white-space: nowrap;
}

.user-table td {
  padding: 11px 10px;
  vertical-align: middle;
}

.user-table tbody tr {
  transition: background 0.15s;
}
.user-table tbody tr:hover {
  background: rgba(255, 255, 255, 0.55);
}

.cell-name { font-weight: 600; }
.cell-time { color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }

.placeholder {
  padding: 28px 10px;
  text-align: center;
  color: var(--text-muted);
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
/* Same palette as ApiTestPanel's verdict dots — those values were chosen for
   contrast against --bg, so reusing them keeps one meaning per colour. */
.status-dot { font-size: 9px; line-height: 1; }
.status-dot.admin    { color: #5A89C8; }
.status-dot.active   { color: #2E9B5E; }
.status-dot.disabled { color: #C7362F; }

.col-actions { text-align: right; }

.row-actions {
  display: inline-flex;
  gap: 8px;
  justify-content: flex-end;
}

.dialog-body { padding-top: 4px; }
.dialog-line { margin: 0 0 12px; font-size: 13px; line-height: 1.6; }
.dialog-note { margin: 10px 0 0; font-size: 12px; line-height: 1.6; color: var(--text-muted); }
.dialog-error { margin: 10px 0 0; font-size: 12px; color: var(--danger); }
</style>
