<template>
  <div class="login-wrapper">
    <div ref="cardEl" class="login-card nm-raised">
      <h1 class="title">147ai TestLab</h1>
      <p class="subtitle text-muted">请登录</p>

      <n-form ref="formRef" :model="form" :rules="rules" class="login-form">
        <n-form-item path="username" :show-label="false">
          <n-input
            v-model:value="form.username"
            placeholder="用户名"
            size="large"
            class="nm-inset"
            @keyup.enter="handleLogin"
          />
        </n-form-item>
        <n-form-item path="password" :show-label="false">
          <n-input
            v-model:value="form.password"
            type="password"
            placeholder="密码（注册需 8 位以上）"
            size="large"
            class="nm-inset"
            @keyup.enter="handleLogin"
          />
        </n-form-item>
        <div class="button-group">
          <button class="nm-btn login-btn" @click="handleLogin" :disabled="loading">
            {{ loading ? '登录中...' : '登录' }}
          </button>
          <button class="nm-btn register-btn" @click="handleRegister" :disabled="loading">
            注册
          </button>
        </div>
      </n-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { NForm, NFormItem, NInput, useMessage } from 'naive-ui'
import { fadeInUp, nudge } from '@/utils/motion'
import { checkPassword } from '@/utils/password'

const router = useRouter()
const auth = useAuthStore()
const message = useMessage()

const form = ref({ username: '', password: '' })
const loading = ref(false)
const formRef = ref()
const cardEl = ref<HTMLElement | null>(null)

onMounted(() => {
  // Reaching this page means re-authenticating. Drop any persisted session so
  // the form is the only way in — otherwise a leftover token would carry the
  // user into the shell without their input ever being checked.
  auth.logout()
  fadeInUp(cardEl.value, { distance: 16 })
})

const rules = {
  username: { required: true, message: '请输入用户名', trigger: 'blur' },
  password: { required: true, message: '请输入密码', trigger: 'blur' }
}

async function handleLogin() {
  // Validate required fields before hitting the network.
  try {
    await formRef.value?.validate()
  } catch {
    return
  }
  loading.value = true
  try {
    await auth.login(form.value.username, form.value.password)
    router.push('/')
  } catch (e: any) {
    // Shake the card so a failure registers even if the toast is missed.
    nudge(cardEl.value)
    message.error(e?.response?.data?.detail || '登录失败')
  } finally {
    loading.value = false
  }
}

/** Mirrors USERNAME_MIN/MAX in backend/app/schemas/user.py.
 *
 *  Deliberately not added to `rules`, which both buttons share: those bounds
 *  apply to UserRegister only. Accounts created before registration opened may
 *  hold shorter names — this database has "1" and "147" — and enforcing the
 *  minimum on the login form would lock them out of their own accounts.
 */
function checkUsername(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length < 3 || trimmed.length > 50) return '用户名需 3-50 个字符'
  return ''
}

/** Pull a readable string out of an error body.
 *
 *  A 4xx from this API carries `detail` as a plain Chinese string, but a 422
 *  from pydantic carries a *list* of error objects — rendering that directly
 *  would put "[object Object]" in front of the user.
 */
function errorText(e: any, fallback: string): string {
  const detail = e?.response?.data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail.length) return detail[0]?.msg || fallback
  return fallback
}

async function handleRegister() {
  try {
    await formRef.value?.validate()
  } catch {
    return
  }

  // Checked before the request so the user reads the rule in plain Chinese
  // rather than a pydantic 422 body.
  const problem = checkUsername(form.value.username) || checkPassword(form.value.password)
  if (problem) {
    message.warning(problem)
    nudge(cardEl.value)
    return
  }

  loading.value = true
  try {
    // Registration logs straight in — the backend returns a token alongside the
    // new account, so there is no second round trip through the login form.
    await auth.register(form.value.username.trim(), form.value.password)
    message.success('注册成功')
    router.push('/')
  } catch (e: any) {
    nudge(cardEl.value)
    message.error(errorText(e, '注册失败'))
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-wrapper {
  min-height: 100vh;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
}

.login-card {
  background: var(--bg);
  border-radius: var(--radius-card);
  padding: 48px 40px;
  width: 380px;
  max-width: 90vw;
}

.title {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  text-align: center;
  margin-bottom: 6px;
  letter-spacing: 0.5px;
}

.subtitle {
  text-align: center;
  margin-bottom: 32px;
  font-size: 13px;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.login-form :deep(.n-input) {
  background: var(--bg) !important;
  border: none !important;
}

.button-group {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}

.login-btn, .register-btn {
  flex: 1;
  height: 42px;
  border: none;
  border-radius: var(--radius-input);
  background: var(--bg);
  cursor: pointer;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  transition: all 0.15s ease;
}

/* --accent on white is 2.90:1; --accent-strong is 5.20:1 and passes WCAG AA. */
.login-btn {
  background: var(--accent-strong);
  color: #fff;
  box-shadow: 4px 4px 8px var(--shadow-dark), -2px -2px 6px var(--shadow-light);
}

.login-btn:hover { background: var(--accent-strong-hover); }
.login-btn:disabled, .register-btn:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
