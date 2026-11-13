<script setup lang="ts">
import { DEMO_ROUND_URL, reviewStageOf, roundStreamType, type ReviewStage, type RoundAiEvent, type RoundAiResult, type RoundDetail, type RoundLoadEvent, type RoundOption } from '~~/shared/grading'
import { kindLabels, reviewStages, syncLabels, syncTypes } from '~/utils/gradingDisplay'

useHead({ title: '阅卷任务' })

const { roundUrl, readMode } = useWorkspace()
const url = ref(roundUrl.value)
const round = ref<RoundDetail | null>(null)
const filter = ref<ReviewStage | ''>('')
const loading = ref(false)
const checkedAnswers = ref(0)
const totalAnswers = ref(0)
let roundRequest: AbortController | undefined
const notice = ref('')
const batchPending = ref(false)
const gradingTasks = reactive(new Set<string>())
const batchNotice = ref('')
const batchResult = ref<RoundAiResult['results'] | null>(null)
const roundOptions = ref<RoundOption[]>([])
const roundOptionsLoading = ref(false)
const roundOptionsNotice = ref('')
const selectedRoundUrl = computed(() => roundOptions.value.find(option =>
  option.url === url.value || option.examRoundUid === round.value?.examRoundUid,
)?.url ?? '')

const tasks = computed(() => (round.value?.tasks ?? [])
  .map(task => {
    const grading = gradingTasks.has(task.id)
    const stage = reviewStageOf(task, grading)
    return {
      ...task,
      stage,
      stageDisplay: reviewStages[stage],
      syncLabel: syncLabels[task.syncStatus],
      syncType: syncTypes[task.syncStatus],
      aiLabel: grading ? '批改中' : task.aiStatus === 'GRADED' ? '已生成' : aiPendingLabel(task),
      kindLabel: kindLabels[task.kind],
      reviewUrl: '/tasks/' + encodeURIComponent(task.id),
    }
  })
  .filter(task => !filter.value || task.stage === filter.value))
const count = computed(() => round.value?.tasks.length ?? 0)
const confirmed = computed(() => round.value?.tasks.filter(task => task.workStatus === 'CONFIRMED').length ?? 0)
const page = ref(1)
const pageSize = ref(10)
const roundColumns = [
  { key: 'studentCode', label: '匿名学生编号' },
  { key: 'kindLabel', label: '科目' },
  { key: 'studentName', label: '学生姓名' },
  { key: 'customerCode', label: '客户编号' },
  { key: 'submittedAt', label: '考试提交时间' },
  { key: 'examType', label: '测试类型' },
  { key: 'sourceStatus', label: '原平台整卷状态' },
  { key: 'stageDisplay', label: '阅卷状态' },
  { key: 'aiLabel', label: 'AI 批改' },
  { key: 'syncLabel', label: '回写' },
  { key: 'reviewUrl', label: '操作' },
] as const
const visibleColumns = computed(() => roundColumns.filter(column =>
  round.value?.readMode === 'live' || (column.key !== 'studentName' && column.key !== 'customerCode')))
const pagedTasks = computed(() =>
  tasks.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
watch(filter, () => { page.value = 1 })
watch(() => tasks.value.length, length => { page.value = Math.min(page.value, Math.max(1, Math.ceil(length / pageSize.value))) })

function aiPendingLabel(task: RoundDetail['tasks'][number]) {
  return task.workStatus === 'CONFIRMED' && task.syncStatus !== 'CONFLICT' ? '已确认，跳过' : '待批改'
}

async function* roundUpdates<T>(path: string, url: string, signal?: AbortSignal): AsyncGenerator<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { Accept: roundStreamType, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  })
  if (!response.ok) throw { status: response.status, data: await response.json().catch(() => undefined) }
  if (!response.body) throw new Error('Round response has no body')
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffered = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const lines = (buffered + chunk.value).split('\n')
      buffered = lines.pop()!
      for (const line of lines) yield JSON.parse(line) as T
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
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
  page.value = 1
  checkedAnswers.value = 0
  totalAnswers.value = 0
  const controller = new AbortController()
  roundRequest = controller
  try {
    const input = url.value.trim()
    for await (const update of roundUpdates<RoundLoadEvent>('/api/rounds/open', input, controller.signal)) {
      if (update.type === 'round') {
        round.value = { ...update.round, tasks: [] }
        totalAnswers.value = update.total
        roundUrl.value = input
      } else if (update.type === 'tasks' && round.value) {
        round.value.tasks.push(...update.tasks)
        checkedAnswers.value = update.checked
      } else if (update.type === 'done') {
        return
      } else if (update.type === 'error') {
        notice.value = update.message
        return
      }
    }
    throw new Error('Round response ended before completion')
  } catch (error) {
    if (!controller.signal.aborted) {
      notice.value = requestError(error, round.value ? '部分答卷暂未加载完成，请重新加载轮次。' : '无法加载考试轮次，请稍后重试。')
    }
  } finally {
    roundRequest = undefined
    loading.value = false
  }
}

async function gradeRound() {
  if (!round.value?.tasks.length || loading.value || notice.value || batchPending.value) return
  batchPending.value = true
  batchNotice.value = ''
  batchResult.value = null
  const controller = new AbortController()
  roundRequest = controller
  try {
    for await (const update of roundUpdates<RoundAiEvent>('/api/rounds/ai', roundUrl.value, controller.signal)) {
      if (update.type === 'grading') {
        gradingTasks.add(update.id)
      } else if (update.type === 'task' && round.value) {
        const index = round.value.tasks.findIndex(task => task.id === update.task.id)
        if (index === -1) round.value.tasks.push(update.task)
        else round.value.tasks[index] = update.task
        gradingTasks.delete(update.task.id)
      } else if (update.type === 'done') {
        round.value = update.result.round
        batchResult.value = update.result.results
        page.value = 1
        return
      } else if (update.type === 'error') {
        throw { status: update.status, data: { data: { code: update.code } } }
      }
    }
    throw new Error('AI response ended before completion')
  } catch (error) {
    if (!controller.signal.aborted) batchNotice.value = requestError(error, '整轮 AI 批改未完成，可重新点击批改。')
  } finally {
    roundRequest = undefined
    gradingTasks.clear()
    batchPending.value = false
  }
}

function openDemo() {
  url.value = DEMO_ROUND_URL
  void openRound()
}

function selectRound(value: string) {
  url.value = value
  void openRound()
}

async function loadRoundOptions() {
  roundOptionsLoading.value = true
  try {
    roundOptions.value = await $fetch<RoundOption[]>('/api/rounds')
  } catch (error) {
    roundOptionsNotice.value = requestError(error, '无法加载已授权轮次。')
  } finally {
    roundOptionsLoading.value = false
  }
}

onMounted(() => {
  if (readMode.value === 'live') void loadRoundOptions()
  if (roundUrl.value) void openRound()
})
onBeforeUnmount(() => roundRequest?.abort())
</script>

<template>
  <div class="round-page">
    <section class="round-heading">
      <p class="eyebrow">IELTS GRADING</p>
      <h1>阅卷任务</h1>
      <p class="muted">按考试轮次加载答卷（大作文 / 小作文 / 口语），在同一页面查看教师阅卷和回写进度。</p>
    </section>

    <section class="panel panel-pad section-gap" aria-labelledby="round-form-title">
      <h2 id="round-form-title">打开考试轮次</h2>
      <ElForm label-position="top" class="round-form" @submit.prevent="openRound">
        <ElFormItem v-if="readMode === 'live'" label="已授权轮次" for="authorized-round" class="round-picker">
          <ElSelect
            id="authorized-round"
            :model-value="selectedRoundUrl"
            :loading="roundOptionsLoading"
            :disabled="loading || batchPending"
            filterable
            placeholder="选择要加载的轮次"
            :no-data-text="roundOptionsNotice || '暂无已授权轮次'"
            @change="selectRound"
          >
            <ElOption v-for="option in roundOptions" :key="option.examRoundUid" :label="option.name" :value="option.url" />
          </ElSelect>
        </ElFormItem>
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
        <p id="round-url-help" class="muted round-help">{{ readMode === 'live' ? '从原考试平台读取已授权轮次的真实答卷。AI 预批改为模型辅助建议，确认后回写原平台，评分记录保存在本阅卷台。' : '模拟环境仅加载预设的示例轮次，展示的答卷均为虚构数据。' }}</p>
      </ElForm>
      <ElAlert v-if="notice" type="error" :closable="false" show-icon :title="notice" />
    </section>

    <section class="panel round-results" :aria-busy="loading && !round" aria-labelledby="round-results-title">
      <div class="results-heading panel-pad">
        <div>
          <h2 id="round-results-title">{{ round?.name ?? '轮次任务列表' }}</h2>
          <p v-if="round" class="muted result-count">{{ loading || notice ? '已加载' : '共' }} {{ count }} 篇 · 已确认 {{ confirmed }} 篇</p>
        </div>
        <div v-if="round" class="results-actions">
          <ElSelect v-model="filter" aria-label="筛选教师阅卷状态" placeholder="全部阅卷状态" class="round-filter">
            <ElOption label="全部阅卷状态" value="" />
            <ElOption v-for="(stage, value) in reviewStages" :key="value" :label="stage.label" :value="value" />
          </ElSelect>
          <ElButton type="primary" :loading="batchPending" :disabled="!count || loading || !!notice" @click="gradeRound">
            {{ batchPending ? '整轮批改中' : batchResult?.failed ? '重试 AI 批改' : 'AI 批改整轮' }}
          </ElButton>
        </div>
      </div>
      <div v-if="round" class="batch-feedback" aria-live="polite">
        <p v-if="loading" class="muted">正在检查答卷 {{ checkedAnswers }} / {{ totalAnswers }}，已加载的任务可以打开。</p>
        <p v-else-if="batchPending" class="muted">正在对当前轮次执行 AI 批改，请稍候。</p>
        <ElAlert v-else-if="batchNotice" type="error" :closable="false" show-icon :title="batchNotice" />
        <ElAlert
          v-else-if="batchResult"
          :type="batchResult.failed ? 'warning' : 'success'"
          :closable="false"
          show-icon
          :title="`AI 批改完成：成功 ${batchResult.graded} 篇，跳过 ${batchResult.skipped} 篇，失败 ${batchResult.failed} 篇。`"
          :description="batchResult.failed ? '可重试失败的作文，已处理的作文会自动跳过。' : undefined"
        />
        <p v-else class="muted">AI 批改覆盖整轮，列表筛选只改变显示范围。</p>
      </div>
      <ElSkeleton v-if="loading && !count" :rows="3" animated class="panel-pad" />
      <table v-else-if="round" class="round-table" role="table" aria-labelledby="round-results-title">
        <thead role="rowgroup">
          <tr role="row">
            <th v-for="column in visibleColumns" :key="column.key" :class="'column-' + column.key" scope="col" role="columnheader">{{ column.label }}</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          <tr v-for="row in pagedTasks" :key="row.id" role="row">
            <td v-for="column in visibleColumns" :key="column.key" :class="'column-' + column.key" role="cell">
              <span class="field-label" aria-hidden="true">{{ column.label }}</span>
              <ElTag v-if="column.key === 'kindLabel'" effect="plain" type="info">{{ row.kindLabel }}</ElTag>
              <ElTag v-else-if="column.key === 'stageDisplay'" :type="row.stageDisplay.type" effect="light">{{ row.stageDisplay.label }}</ElTag>
              <ElTag v-else-if="column.key === 'aiLabel'" :type="row.aiStatus === 'GRADED' ? 'success' : 'info'" effect="plain">{{ row.aiLabel }}</ElTag>
              <ElTag v-else-if="column.key === 'syncLabel'" :type="row.syncType" effect="plain">{{ row.syncLabel }}</ElTag>
              <NuxtLink v-else-if="column.key === 'reviewUrl'" class="task-link" :to="row.reviewUrl">打开阅卷 <span aria-hidden="true">→</span></NuxtLink>
              <template v-else>{{ row[column.key] || '—' }}</template>
            </td>
          </tr>
          <tr v-if="!pagedTasks.length" role="row">
            <td class="empty-row" :colspan="visibleColumns.length" role="cell">{{ count ? '没有符合当前筛选条件的任务。' : notice ? '答卷加载未完成。' : '该轮次没有可阅任务，请核对已授权答卷和已配置科目的作答。' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="round && tasks.length" class="table-pagination">
        <ElPagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="tasks.length"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          background
        />
      </div>
      <ElEmpty v-if="!round && !loading" description="加载轮次后，这里会显示分配给你的阅卷任务。" :image-size="72" />
    </section>
  </div>
</template>

<style scoped>
.round-heading { margin-bottom: 24px; }
.round-heading .muted { margin-top: 8px; }
.round-form { margin-top: 12px; }
.round-form .el-form-item { margin-bottom: 0; }
.round-form .round-picker { margin-bottom: 12px; }
.round-picker .el-select { max-width: 420px; }
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
.round-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 14px; }
.round-table th, .round-table td { padding: 10px; text-align: left; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.round-table th { background: #f5f8fd; color: var(--muted); }
.round-table tbody tr:hover { background: #f5f8fd; }
.round-table th.column-studentCode, .round-table th.column-customerCode { width: 11%; }
.round-table th.column-submittedAt { width: 14%; }
.round-table th.column-examType { width: 6%; }
.round-table th.column-sourceStatus { width: 11%; }
.round-table th.column-syncLabel { width: 9%; }
.round-table .column-reviewUrl { text-align: right; }
.round-table :deep(.el-tag) { max-width: 100%; height: auto; min-height: 24px; white-space: normal; padding-block: 3px; }
.round-table :deep(.el-tag__content) { min-width: 0; }
.round-table .empty-row { text-align: center; color: var(--muted); padding: 20px 10px; }
.field-label { display: none; }
.table-pagination { display: flex; justify-content: flex-end; padding: 12px 18px 16px; }
.table-pagination :deep(.el-pagination) { flex-wrap: wrap; justify-content: flex-end; }
.task-link { font-weight: 650; }

@media (max-width: 1180px) {
  .round-table, .round-table tbody { display: block; }
  .round-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .round-table tbody tr { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 130px), 1fr)); gap: 10px 14px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .round-table td { padding: 0; border: 0; min-width: 0; }
  .round-table .column-reviewUrl { text-align: left; }
  .round-table .empty-row { grid-column: 1 / -1; }
  .field-label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 3px; }
}

@media (max-width: 480px) {
  .table-pagination { padding-inline: 10px; }
  .table-pagination :deep(.el-pagination) { --el-pagination-button-width: 28px; }
  .table-pagination :deep(.el-pager li) { margin-inline: 1px; }
}
</style>
