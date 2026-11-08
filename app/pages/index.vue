<script setup lang="ts">
import { DEMO_ROUND_URL, type RoundAiResult, type RoundDetail, type WorkStatus } from '~~/shared/grading'
import { syncLabels, syncTypes, workLabels, workTypes } from '~/utils/gradingDisplay'

useHead({ title: '阅卷任务' })

const { roundUrl, readMode } = useWorkspace()
const url = ref(roundUrl.value)
const round = ref<RoundDetail | null>(null)
const filter = ref<WorkStatus | ''>('')
const loading = ref(false)
const notice = ref('')
const batchPending = ref(false)
const batchNotice = ref('')
const batchResult = ref<RoundAiResult['results'] | null>(null)

const tasks = computed(() => (round.value?.tasks ?? [])
  .filter(task => !filter.value || task.workStatus === filter.value)
  .map(task => ({
    ...task,
    workLabel: workLabels[task.workStatus],
    workType: workTypes[task.workStatus],
    syncLabel: syncLabels[task.syncStatus],
    syncType: syncTypes[task.syncStatus],
    aiLabel: task.aiStatus === 'GRADED' ? '已生成' : aiPendingLabel(task),
    reviewUrl: '/tasks/' + encodeURIComponent(task.id),
  })))
const count = computed(() => round.value?.tasks.length ?? 0)
const confirmed = computed(() => round.value?.tasks.filter(task => task.workStatus === 'CONFIRMED').length ?? 0)

function aiPendingLabel(task: RoundDetail['tasks'][number]) {
  return task.workStatus === 'CONFIRMED' && task.syncStatus !== 'CONFLICT' ? '已确认，跳过' : '待批改'
}

async function openRound() {
  if (loading.value || batchPending.value) return
  if (!url.value.trim()) {
    notice.value = readMode.value === 'live' ? '请输入原考试平台的轮次链接。' : '请输入轮次链接，或点击「打开示例轮次」。'
    return
  }
  loading.value = true
  notice.value = ''
  batchNotice.value = ''
  batchResult.value = null
  round.value = null
  filter.value = ''
  try {
    const input = url.value.trim()
    round.value = await $fetch<RoundDetail>('/api/rounds/open', { method: 'POST', body: { url: input } })
    roundUrl.value = input
  } catch (error) {
    notice.value = requestError(error, '无法加载考试轮次，请稍后重试。')
  } finally {
    loading.value = false
  }
}

async function gradeRound() {
  if (!round.value?.tasks.length || loading.value || batchPending.value) return
  batchPending.value = true
  batchNotice.value = ''
  try {
    const result = await $fetch<RoundAiResult>('/api/rounds/ai', { method: 'POST', body: { url: roundUrl.value } })
    round.value = result.round
    batchResult.value = result.results
  } catch (error) {
    batchNotice.value = requestError(error, '整轮模拟 AI 批改未完成，可重新点击批改。')
  } finally {
    batchPending.value = false
  }
}

function openDemo() {
  url.value = DEMO_ROUND_URL
  void openRound()
}

onMounted(() => {
  if (roundUrl.value) void openRound()
})
</script>

<template>
  <div class="round-page">
    <section class="round-heading">
      <p class="eyebrow">IELTS WRITING · TASK 2</p>
      <h1>阅卷任务</h1>
      <p class="muted">按考试轮次加载作文，在同一页面查看教师阅卷和模拟回写进度。</p>
    </section>

    <section class="panel panel-pad section-gap" aria-labelledby="round-form-title">
      <h2 id="round-form-title">打开考试轮次</h2>
      <ElForm label-position="top" class="round-form" @submit.prevent="openRound">
        <ElFormItem label="原考试平台轮次链接" for="round-url">
          <div class="round-input">
            <ElInput
              id="round-url"
              v-model="url"
              placeholder="粘贴原考试平台的「考试情况」链接"
              :disabled="loading || batchPending"
              autocomplete="off"
              aria-describedby="round-url-help"
              clearable
            />
            <ElButton type="primary" native-type="submit" :loading="loading" :disabled="batchPending">加载轮次</ElButton>
            <ElButton v-if="readMode === 'demo'" :disabled="loading || batchPending" @click="openDemo">打开示例轮次</ElButton>
          </div>
        </ElFormItem>
        <p id="round-url-help" class="muted round-help">{{ readMode === 'live' ? '从原考试平台读取已授权轮次的真实答卷。AI 预批改和回写为模拟，评分只保存在本阅卷台。' : '模拟环境仅加载预设的示例轮次，展示的答卷均为虚构数据。' }}</p>
      </ElForm>
      <ElAlert v-if="notice" type="error" :closable="false" show-icon :title="notice" />
    </section>

    <section class="panel round-results" :aria-busy="loading || batchPending" aria-labelledby="round-results-title">
      <div class="results-heading panel-pad">
        <div>
          <h2 id="round-results-title">{{ round?.name ?? '轮次任务列表' }}</h2>
          <p v-if="round" class="muted result-count">共 {{ count }} 篇 · 已确认 {{ confirmed }} 篇</p>
        </div>
        <div v-if="round" class="results-actions">
          <ElSelect v-model="filter" aria-label="筛选教师阅卷状态" placeholder="全部阅卷状态" class="round-filter">
            <ElOption label="全部阅卷状态" value="" />
            <ElOption v-for="(label, value) in workLabels" :key="value" :label="label" :value="value" />
          </ElSelect>
          <ElButton type="primary" :loading="batchPending" :disabled="!count" @click="gradeRound">
            {{ batchPending ? '整轮批改中' : batchResult?.failed ? '重试 AI 批改' : 'AI 批改整轮' }}
          </ElButton>
        </div>
      </div>
      <div v-if="round" class="batch-feedback" aria-live="polite">
        <p v-if="batchPending" class="muted">正在对当前轮次执行模拟 AI 批改，请稍候。</p>
        <ElAlert v-else-if="batchNotice" type="error" :closable="false" show-icon :title="batchNotice" />
        <ElAlert
          v-else-if="batchResult"
          :type="batchResult.failed ? 'warning' : 'success'"
          :closable="false"
          show-icon
          :title="`模拟 AI 批改完成：成功 ${batchResult.graded} 篇，跳过 ${batchResult.skipped} 篇，失败 ${batchResult.failed} 篇。`"
          :description="batchResult.failed ? '可重试失败的作文，已处理的作文会自动跳过。' : undefined"
        />
        <p v-else class="muted">模拟 AI 批改覆盖整轮，列表筛选只改变显示范围。</p>
      </div>
      <ElSkeleton v-if="loading" :rows="3" animated class="panel-pad" />
      <ElTable
        v-else-if="round"
        :data="tasks"
        row-key="id"
        :empty-text="count ? '没有符合当前筛选条件的任务。' : '该轮次没有分配给你的 Task 2 阅卷任务。'"
        class="round-table"
      >
        <ElTableColumn label="匿名学生编号" prop="studentCode" min-width="140" />
        <ElTableColumn label="原平台整卷状态" prop="sourceStatus" min-width="155" />
        <ElTableColumn label="Task 2 阅卷状态" min-width="145">
          <template #default="{ row }">
            <ElTag :type="row.workType" effect="light">{{ row.workLabel }}</ElTag>
          </template>
        </ElTableColumn>
        <ElTableColumn label="AI 批改" min-width="110">
          <template #default="{ row }">
            <ElTag :type="row.aiStatus === 'GRADED' ? 'success' : 'info'" effect="plain">{{ row.aiLabel }}</ElTag>
          </template>
        </ElTableColumn>
        <ElTableColumn label="模拟回写" min-width="150">
          <template #default="{ row }">
            <ElTag :type="row.syncType" effect="plain">{{ row.syncLabel }}</ElTag>
          </template>
        </ElTableColumn>
        <ElTableColumn label="操作" min-width="105" align="right">
          <template #default="{ row }">
            <NuxtLink class="task-link" :to="row.reviewUrl">打开阅卷 <span aria-hidden="true">→</span></NuxtLink>
          </template>
        </ElTableColumn>
      </ElTable>
      <ElEmpty v-else description="加载轮次后，这里会显示分配给你的 Task 2 作文。" :image-size="72" />
    </section>
  </div>
</template>

<style scoped>
.round-page { max-width: 1180px; margin-inline: auto; }
.round-heading { margin-bottom: 24px; }
.round-heading .muted { margin-top: 8px; }
.round-form { margin-top: 12px; }
.round-form .el-form-item { margin-bottom: 0; }
.round-form + .el-alert { margin-top: 12px; }
.round-help { margin-top: 8px; font-size: 13px; }
.round-input { display: flex; align-items: center; gap: 8px; width: 100%; flex-wrap: wrap; }
.round-input .el-input { flex: 1 1 270px; }
.round-input .el-button { margin: 0; }
.round-results { overflow: hidden; }
.results-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; }
.results-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.result-count { margin-top: 5px; font-size: 13px; }
.round-filter { width: 166px; }
.batch-feedback { padding: 0 18px 14px; font-size: 13px; }
.round-table { --el-table-header-bg-color: #f5f8fd; --el-table-text-color: var(--ink); }
.task-link { font-weight: 650; white-space: nowrap; }
</style>
