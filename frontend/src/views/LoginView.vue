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
            placeholder="密码"
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

/** Registration is closed for now. The button is kept so its absence does not
 *  read as a broken layout, but it only explains why it does nothing — the
 *  backend /auth/register route is also disabled, so this is not the only guard. */
function handleRegister() {
  message.info('暂未开放注册功能，请用账号登录')
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
