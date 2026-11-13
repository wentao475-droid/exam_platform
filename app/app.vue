<script setup lang="ts">
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import type { ReadMode, SessionUser } from '~~/shared/grading'

interface WorkspaceSession {
  user: SessionUser | null
  readMode: ReadMode
}

const { teacher, roundUrl, readMode } = useWorkspace()
const request = useRequestFetch()
const { data: session, error: sessionError } = await useAsyncData('initial-workspace-session',
  () => request<WorkspaceSession>('/api/session'),
)
teacher.value = session.value?.user ?? null
readMode.value = session.value?.readMode ?? 'demo'

const email = ref('')
const password = ref('')
const busy = ref(false)
const notice = ref(sessionError.value ? '无法读取会话，请确认服务已启动。' : '')

async function signIn() {
  if (busy.value) return
  busy.value = true
  notice.value = ''
  try {
    const result = await $fetch<WorkspaceSession>('/api/session', {
      method: 'POST',
      body: { email: email.value.trim(), password: password.value },
    })
    readMode.value = result.readMode
    teacher.value = result.user
    password.value = ''
  } catch (error) {
    const failure = error as { status?: number }
    notice.value = failure.status === 401 ? '账号或密码不正确。' : requestError(error, '登录失败，请稍后重试。')
  } finally {
    busy.value = false
  }
}

async function signOut() {
  if (busy.value) return
  busy.value = true
  notice.value = ''
  try {
    await $fetch('/api/session', { method: 'DELETE' })
    teacher.value = null
    roundUrl.value = ''
    email.value = ''
    clearNuxtData(key => key.startsWith('review:'))
    await navigateTo('/', { replace: true })
  } catch (error) {
    notice.value = requestError(error, '退出失败，请稍后重试。')
  } finally {
    busy.value = false
  }
}

useHead({
  htmlAttrs: { lang: 'zh-CN' },
  titleTemplate: title => title && title !== 'AI Grading Workspace' ? title + ' · AI Grading Workspace' : 'AI Grading Workspace',
})
</script>

<template>
  <ElConfigProvider :locale="zhCn">
    <div class="shell">
      <header class="topbar">
        <div class="topbar-inner">
          <NuxtLink to="/" class="brand" aria-label="AI Grading Workspace 首页">
            <span class="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="23" height="23" fill="none">
                <path d="M6 3.75h8.1L18 7.7v12.55H6z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
                <path d="M14 4v4h3.5M9 12h6m-6 3h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              </svg>
            </span>
            <span>AI Grading Workspace<small>教师阅卷台</small></span>
          </NuxtLink>
          <div class="topbar-actions">
            <ElTag :type="readMode === 'live' ? 'info' : 'warning'" effect="plain">{{ readMode === 'live' ? '真实答卷 · 只读接入' : '模拟环境' }}</ElTag>
            <template v-if="teacher">
              <span class="teacher-name">{{ teacher.name }}</span>
              <ElButton text :loading="busy" @click="signOut">退出</ElButton>
            </template>
          </div>
        </div>
      </header>

      <main v-if="teacher" class="main">
        <ElAlert v-if="notice" type="error" :closable="false" show-icon :title="notice" class="section-gap" />
        <NuxtPage />
      </main>

      <main v-else class="login">
        <section class="login-card panel" aria-labelledby="login-title">
          <p class="eyebrow">IELTS WRITING · TASK 2</p>
          <h1 id="login-title">登录教师阅卷台</h1>
          <p class="muted">{{ readMode === 'live' ? '使用已获授权的教师账号读取真实答卷。AI 预批改为模型辅助建议，回写仍为模拟。' : '使用演示教师账号进入工作台，体验作文复核、草稿保存和模拟回写。' }}</p>
          <ElAlert v-if="notice" type="error" :closable="false" show-icon :title="notice" class="section-gap" />
          <ElForm label-position="top" class="login-form" @submit.prevent="signIn">
            <ElFormItem label="教师邮箱" for="teacher-email">
              <ElInput id="teacher-email" v-model="email" type="email" autocomplete="username" required :placeholder="readMode === 'demo' ? 'teacher1@example.test' : '请输入教师邮箱'" />
            </ElFormItem>
            <ElFormItem label="密码" for="teacher-password">
              <ElInput id="teacher-password" v-model="password" type="password" autocomplete="current-password" required show-password />
            </ElFormItem>
            <ElButton type="primary" native-type="submit" :loading="busy" class="full-width">登录</ElButton>
          </ElForm>
          <p v-if="readMode === 'demo'" class="login-note">演示账号和密码见本地启动说明。</p>
        </section>
      </main>
    </div>
  </ElConfigProvider>
</template>

<style src="./assets/css/workspace.css"></style>
