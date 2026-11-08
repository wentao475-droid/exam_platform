<script setup lang="ts">
import { SCORE_KEYS, SCORE_LABELS, type Annotation, type ScoreKey, type Scores, type TaskDetail } from '~~/shared/grading'
import { auditLabels, formatAuditDate, syncLabels, syncTypes, workLabels, workTypes } from '~/utils/gradingDisplay'

definePageMeta({ key: route => route.path })
useHead({ title: '作文复核' })

const route = useRoute()
const api = '/api/tasks/' + encodeURIComponent(String(route.params.id))
const request = useRequestFetch()
const { data: task, error: loadError, refresh, status: loadStatus } = await useAsyncData<TaskDetail>(
  'review:' + String(route.params.id),
  () => request<TaskDetail>(api),
)

const scoreNames: Record<ScoreKey, string> = {
  tr: '任务回应',
  cc: '连贯与衔接',
  lr: '词汇资源',
  gra: '语法范围与准确性',
}
const scores = reactive<Partial<Scores>>({})
const comment = ref('')
const commentEdited = ref(false)
const pending = ref<'ai' | 'draft' | 'submit' | 'retry' | null>(null)
const actionError = ref('')
const actionSuccess = ref('')
const confirmOpen = ref(false)
const activeAnnotation = ref<number | null>(null)
const highlight = ref<HTMLElement | null>(null)

const isBusy = computed(() => pending.value !== null || loadStatus.value === 'pending')
const locked = computed(() => Boolean(task.value?.confirmation) && task.value?.syncStatus !== 'CONFLICT')
const conflict = computed(() => task.value?.syncStatus === 'CONFLICT')
const conflictNeedsReload = computed(() => conflict.value && (
  !task.value?.confirmation || task.value.confirmation.answerVersion === task.value.answerVersion
))
const staleDraft = computed(() => Boolean(task.value?.draft && task.value.draft.answerVersion !== task.value.answerVersion))
const staleAi = computed(() => Boolean(task.value?.ai && task.value.ai.answerVersion !== task.value.answerVersion))
const commentSuggestion = computed(() => staleAi.value ? '' : task.value?.ai?.teacherComment ?? '')
const commentPrefilled = computed(() => !task.value?.draft && !task.value?.confirmation && !commentEdited.value && Boolean(commentSuggestion.value))
const formMean = computed(() => {
  const values = SCORE_KEYS.map(key => scores[key])
  if (!values.every(validScore)) return null
  return values.reduce((sum, score) => sum + score, 0) / values.length
})
const dirty = computed(() => {
  const draft = task.value?.draft
  return comment.value !== (draft?.comment ?? '') || SCORE_KEYS.some(key => scores[key] !== draft?.scores[key])
})
const submitReady = computed(() => Boolean(task.value?.draft) && !locked.value && !dirty.value && !staleDraft.value && !conflict.value)
const syncRetryable = computed(() => task.value?.syncStatus === 'FAILED' || task.value?.syncStatus === 'PENDING')
const markedText = computed(() => {
  const answer = task.value?.answerText ?? ''
  const annotation = activeAnnotation.value === null ? undefined : task.value?.ai?.annotations[activeAnnotation.value]
  if (!annotation?.range || staleAi.value) return { before: answer, match: '', after: '' }
  const { start, end } = annotation.range
  if (start < 0 || end > answer.length || answer.slice(start, end) !== annotation.quote) {
    return { before: answer, match: '', after: '' }
  }
  return { before: answer.slice(0, start), match: answer.slice(start, end), after: answer.slice(end) }
})

function validScore(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 9 && Number.isInteger(value * 2)
}

function fillForm() {
  const grade = locked.value ? task.value?.confirmation : task.value?.draft
  for (const key of SCORE_KEYS) scores[key] = grade?.scores[key]
  commentEdited.value = false
  comment.value = grade?.comment ?? (commentPrefilled.value ? commentSuggestion.value : '')
}
fillForm()

function canLocate(annotation: Annotation) {
  const answer = task.value?.answerText ?? ''
  if (!annotation.range || staleAi.value) return false
  const { start, end } = annotation.range
  return start >= 0 && end <= answer.length && end > start && answer.slice(start, end) === annotation.quote
}

async function showAnnotation(index: number) {
  activeAnnotation.value = index
  await nextTick()
  highlight.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  highlight.value?.focus({ preventScroll: true })
}

async function reload() {
  if (isBusy.value) return
  actionError.value = ''
  actionSuccess.value = ''
  activeAnnotation.value = null
  await refresh()
  if (!loadError.value) fillForm()
}

async function perform(action: NonNullable<typeof pending.value>) {
  const detail = task.value
  if (!detail || isBusy.value) return
  actionError.value = ''
  actionSuccess.value = ''

  let body: Record<string, unknown> = { answerVersion: detail.answerVersion }
  if (action === 'draft') {
    if (formMean.value === null) {
      actionError.value = '请填写四项分数，每项为 0–9 分，步长为 0.5。'
      return
    }
    body = { ...body, revision: detail.revision, scores: { ...scores }, comment: comment.value }
  } else if (action === 'submit') {
    if (!submitReady.value) return
    body.revision = detail.revision
    confirmOpen.value = false
  } else if (action === 'retry') {
    body = {}
  }

  pending.value = action
  try {
    task.value = await $fetch<TaskDetail>(api + '/' + action, { method: action === 'draft' ? 'PUT' : 'POST', body })
    if (action !== 'ai') fillForm()
    if (action === 'ai') {
      if (commentPrefilled.value) comment.value = commentSuggestion.value
      activeAnnotation.value = null
      actionSuccess.value = '模拟 AI 预批改已生成。'
    } else if (action === 'draft') {
      actionSuccess.value = '草稿已保存。'
    } else if (task.value.syncStatus === 'SYNCED') {
      actionSuccess.value = '模拟回写成功。'
    }
  } catch (error) {
    const status = (error as { status?: number }).status
    actionError.value = status === 409
      ? requestError(error, '数据已更新，请重新读取答卷。') + ' 重新读取前，可复制尚未保存的评语。'
      : requestError(error, action === 'ai' ? '模拟 AI 预批改失败，你可以继续手工评分。' : '操作未完成，请稍后重试。')
  } finally {
    pending.value = null
  }
}
</script>

<template>
  <div class="review-page">
    <NuxtLink to="/" class="back-link"><span aria-hidden="true">←</span> 返回阅卷任务</NuxtLink>

    <div v-if="loadError" class="panel panel-pad">
      <ElAlert type="error" show-icon :closable="false" :title="requestError(loadError, '无法读取作文，请稍后重试。')" />
      <ElButton class="retry-load" :loading="loadStatus === 'pending'" @click="reload">重新读取答卷</ElButton>
    </div>
    <ElSkeleton v-else-if="!task" :rows="6" animated class="panel panel-pad" />

    <template v-else>
      <header class="review-header">
        <div>
          <p class="eyebrow">IELTS WRITING · TASK 2</p>
          <h1>作文复核</h1>
          <p class="muted">{{ task.examName }} · {{ task.studentCode }}<br>原平台整卷状态 {{ task.sourceStatus }}</p>
        </div>
        <div class="inline-actions">
          <ElTag :type="workTypes[task.workStatus]" effect="light">教师 · {{ workLabels[task.workStatus] }}</ElTag>
          <ElTag :type="syncTypes[task.syncStatus]" effect="plain">模拟回写 · {{ syncLabels[task.syncStatus] }}</ElTag>
        </div>
      </header>

      <ElAlert
        v-if="task.readMode === 'live'"
        type="info"
        show-icon
        :closable="false"
        title="这是真实答卷。AI 预批改与回写均为模拟，教师评分仅保存在本阅卷台。"
        class="section-gap"
      />
      <ElAlert v-if="actionError" type="error" show-icon :closable="false" :title="actionError" class="section-gap" />
      <ElAlert v-else-if="actionSuccess" type="success" show-icon :closable="false" :title="actionSuccess" class="section-gap" />
      <ElAlert
        v-if="conflict"
        type="warning"
        show-icon
        :closable="false"
        :title="conflictNeedsReload ? '答卷版本已变化，请重新读取答卷，再复核、保存和提交。' : '已读取最新版答卷，请重新复核并保存草稿。'"
        class="section-gap"
      />

      <div class="desk">
        <section class="panel desk-column" aria-labelledby="source-heading">
          <div class="column-heading">
            <div>
              <p class="eyebrow">01 / 答卷</p>
              <h2 id="source-heading">题目与原文</h2>
            </div>
            <ElTag type="info" effect="plain">{{ task.wordCount }} 词</ElTag>
          </div>
          <div class="column-content source-content">
            <section aria-labelledby="prompt-heading" class="prompt-box">
              <h3 id="prompt-heading">Task 2 题目</h3>
              <!-- promptHtml is allowlisted by the server before serialization. -->
              <div class="prompt-text" lang="en" v-html="task.promptHtml" />
            </section>
            <h3 class="essay-title">学生作文</h3>
            <p class="essay-text" lang="en"><span>{{ markedText.before }}</span><mark v-if="markedText.match" ref="highlight" tabindex="-1">{{ markedText.match }}</mark><span>{{ markedText.after }}</span></p>
          </div>
        </section>

        <section class="panel desk-column" aria-labelledby="ai-heading">
          <div class="column-heading">
            <div>
              <p class="eyebrow">02 / 建议</p>
              <h2 id="ai-heading">AI 预批改</h2>
            </div>
            <ElButton size="small" :loading="pending === 'ai'" :disabled="isBusy" @click="perform('ai')">
              {{ task.ai ? '重新生成' : '生成预批改' }}
            </ElButton>
          </div>
          <div class="column-content">
            <ElEmpty v-if="!task.ai" description="可生成模拟 AI 预批改，也可直接手工评分。" :image-size="62" />
            <template v-else>
              <ElAlert v-if="staleAi" type="warning" title="此建议基于旧版答卷，可重新生成。" :closable="false" class="section-gap" />
              <p class="ai-summary">{{ task.ai.summary }}</p>
              <div v-for="key in SCORE_KEYS" :key="key" class="ai-score">
                <div class="ai-score-heading">
                  <div>
                    <h3>{{ scoreNames[key] }}</h3>
                    <p class="muted score-label" lang="en">{{ SCORE_LABELS[key] }}</p>
                  </div>
                  <ElTag type="primary" effect="light">{{ task.ai.scores[key] }}</ElTag>
                </div>
                <p class="ai-reason">{{ task.ai.reasons[key] }}</p>
              </div>
              <section class="annotation-list" aria-labelledby="annotations-heading">
                <h3 id="annotations-heading">原文批注</h3>
                <p v-if="!task.ai.annotations.length" class="muted">本次预批改没有批注。</p>
                <article v-for="(annotation, index) in task.ai.annotations" :key="index" class="annotation">
                  <blockquote lang="en">{{ annotation.quote }}</blockquote>
                  <p>{{ annotation.comment }}</p>
                  <p v-if="annotation.suggestion" class="muted">{{ annotation.suggestion }}</p>
                  <ElButton v-if="canLocate(annotation)" link type="primary" class="annotation-link" @click="showAnnotation(index)">
                    定位原文 <span aria-hidden="true">↗</span>
                  </ElButton>
                  <span v-else class="annotation-note muted">待核对原文位置</span>
                </article>
              </section>
              <section v-if="task.ai.suggestions.length" class="annotation-list" aria-labelledby="suggestions-heading">
                <h3 id="suggestions-heading">改进建议</h3>
                <ul class="suggestions">
                  <li v-for="(suggestion, index) in task.ai.suggestions" :key="index">{{ suggestion }}</li>
                </ul>
              </section>
              <p class="prompt-version muted">模拟 AI · 提示词 {{ task.ai.promptVersion }}</p>
            </template>
          </div>
        </section>

        <section class="panel desk-column" aria-labelledby="teacher-heading">
          <div class="column-heading">
            <div>
              <p class="eyebrow">03 / 复核</p>
              <h2 id="teacher-heading">教师评分</h2>
            </div>
          </div>
          <div class="column-content">
            <p class="score-help muted">{{ locked ? '此处显示教师已确认的评分快照。' : '请独立确认四项分数，再保存草稿。' }}</p>
            <ElAlert v-if="staleDraft && !locked" type="warning" title="草稿基于旧版答卷，请复核后重新保存。" :closable="false" class="section-gap" />
            <ElForm label-position="top" :disabled="isBusy || locked || conflictNeedsReload" @submit.prevent="perform('draft')">
              <div v-for="key in SCORE_KEYS" :key="key" class="teacher-score">
                <label :for="'teacher-score-' + key">
                  <strong>{{ scoreNames[key] }}</strong>
                  <small lang="en">{{ SCORE_LABELS[key] }}</small>
                </label>
                <ElInputNumber
                  :id="'teacher-score-' + key"
                  v-model="scores[key]"
                  :min="0"
                  :max="9"
                  :step="0.5"
                  step-strictly
                  controls-position="right"
                  size="small"
                />
              </div>
              <div class="score-total">
                <span>四维均分 <small>未取整</small></span>
                <strong>{{ formMean ?? '—' }}</strong>
              </div>
              <ElFormItem label="教师评语" for="teacher-comment">
                <ElInput id="teacher-comment" v-model="comment" type="textarea" :rows="5" :maxlength="12000" show-word-limit @update:model-value="commentEdited = true" />
                <p v-if="commentPrefilled" class="muted comment-hint">模拟 AI 已预填评语，可修改后随评分一起保存。</p>
              </ElFormItem>
              <div v-if="!locked" class="inline-actions grade-actions">
                <ElButton native-type="submit" :loading="pending === 'draft'" :disabled="conflictNeedsReload || formMean === null">保存草稿</ElButton>
                <ElButton type="primary" :disabled="!submitReady || isBusy" :loading="pending === 'submit'" @click="confirmOpen = true">确认提交</ElButton>
              </div>
            </ElForm>
            <div class="sync-box">
              <div class="sync-heading">
                <h3>模拟回写状态</h3>
                <ElTag :type="syncTypes[task.syncStatus]" effect="plain">{{ syncLabels[task.syncStatus] }}</ElTag>
              </div>
              <p v-if="task.confirmation?.syncMessage" class="muted">{{ task.confirmation.syncMessage }}</p>
              <p v-if="task.confirmation" class="muted">尝试 {{ task.confirmation.syncAttempts }} 次</p>
              <p v-else class="muted">教师确认后开始模拟回写。</p>
              <div class="inline-actions sync-actions">
                <ElButton v-if="syncRetryable" type="primary" plain size="small" :disabled="isBusy" :loading="pending === 'retry'" @click="perform('retry')">
                  重试回写
                </ElButton>
                <ElButton size="small" :disabled="isBusy" @click="reload">重新读取答卷</ElButton>
              </div>
            </div>
          </div>
        </section>
      </div>

      <section class="panel panel-pad audit-panel" aria-labelledby="audit-heading">
        <h2 id="audit-heading">操作记录</h2>
        <p v-if="!task.audit.length" class="muted">暂无操作记录。</p>
        <ol v-else class="audit-list">
          <li v-for="entry in task.audit" :key="entry.id">
            <div><strong>{{ auditLabels[entry.action] }}</strong><span class="muted">{{ entry.actor }}</span></div>
            <p v-if="entry.detail" class="muted">{{ entry.detail }}</p>
            <time :datetime="entry.at" class="muted">{{ formatAuditDate(entry.at) }}</time>
          </li>
        </ol>
      </section>

      <ElDialog v-model="confirmOpen" title="确认提交教师评分" width="min(440px, 90vw)" :close-on-click-modal="false">
        <p>提交后将固定本次教师评分与评语，并尝试模拟回写。</p>
        <template #footer>
          <ElButton @click="confirmOpen = false">返回复核</ElButton>
          <ElButton type="primary" :disabled="!submitReady || isBusy" @click="perform('submit')">{{ task.readMode === 'live' ? '确认并模拟回写' : '确认并回写' }}</ElButton>
        </template>
      </ElDialog>
    </template>
  </div>
</template>

<style scoped>
.back-link { display: inline-flex; gap: 7px; margin-bottom: 16px; font-weight: 650; font-size: 14px; }
.retry-load { margin-top: 12px; }
.review-header { display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 14px; margin-bottom: 22px; }
.review-header .muted { margin-top: 7px; }
.desk { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1.05fr) minmax(0, .98fr); gap: 14px; align-items: start; }
.desk-column { overflow: clip; }
.column-heading { min-height: 77px; display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--line); padding: 12px 17px; background: #fbfcff; }
.column-heading .eyebrow { margin-bottom: 3px; }
.column-content { padding: 17px; }
.source-content { max-height: min(75vh, 780px); overflow-y: auto; }
.prompt-box { background: #f0f5fd; border: 1px solid #e4edf9; border-radius: 8px; padding: 12px 14px; }
.prompt-text { margin-top: 7px; overflow-wrap: anywhere; }
.prompt-text :deep(p + p) { margin-top: .55em; }
.essay-title { margin: 17px 0 8px; }
.essay-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; }
.essay-text mark { background: #ffe3a0; color: #292106; border-radius: 2px; scroll-margin: 16px; }
.ai-summary { margin-bottom: 9px; }
.ai-score { padding-block: 10px; border-bottom: 1px solid var(--line); }
.ai-score-heading, .sync-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 7px; }
.score-label { font-size: 11px; line-height: 1.35; }
.ai-reason { margin-top: 4px; font-size: 13px; }
.annotation-list { margin-top: 17px; }
.annotation { background: #f6f8fc; border: 1px solid #e6edf6; border-radius: 8px; margin-top: 7px; padding: 9px 10px; font-size: 13px; overflow-wrap: anywhere; }
.annotation blockquote { margin: 0 0 4px; color: #1b3f79; font-weight: 650; }
.annotation-link { margin-top: 5px; }
.annotation-note { display: inline-block; font-size: 12px; margin-top: 4px; }
.suggestions { padding-inline-start: 18px; margin: 6px 0 0; font-size: 13px; }
.prompt-version { margin-top: 12px; font-size: 12px; }
.score-help { margin-bottom: 8px; font-size: 13px; }
.teacher-score { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-block: 7px; border-bottom: 1px solid var(--line); }
.teacher-score small { display: block; color: var(--muted); font-size: 10px; line-height: 1.3; }
.teacher-score .el-input-number { width: 83px; flex: 0 0 83px; }
.score-total { display: flex; align-items: center; justify-content: space-between; background: #eef4fe; color: #143e85; padding: 6px 10px; border-radius: 7px; margin: 12px 0; }
.score-total strong { font-size: 20px; }
.score-total small { margin-left: 4px; font-size: 11px; }
.grade-actions { margin-top: -4px; }
.comment-hint { margin-top: 4px; font-size: 12px; line-height: 1.5; }
.sync-box { border-top: 1px solid var(--line); padding-top: 13px; margin-top: 16px; }
.sync-box p { font-size: 13px; margin-top: 5px; }
.sync-actions { margin-top: 9px; }
.audit-panel { margin-top: 15px; }
.audit-panel > p { margin-top: 6px; }
.audit-list { list-style: none; margin: 8px 0 0; padding: 0; }
.audit-list li { display: grid; grid-template-columns: 2fr 3fr auto; gap: 7px; padding-block: 8px; border-top: 1px solid var(--line); font-size: 13px; }
.audit-list li span { margin-left: 7px; }
.audit-list time { grid-column: 3; }

@media (max-width: 1060px) {
  .desk { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .desk-column:last-child { grid-column: 1 / -1; }
}

@media (max-width: 660px) {
  .desk { grid-template-columns: minmax(0, 1fr); }
  .audit-list li { grid-template-columns: 1fr; }
  .audit-list time { grid-column: 1; }
}
</style>
