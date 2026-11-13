import type { AuditEntry, ReviewStage, ScoreKey, SyncStatus, TaskKind, WorkStatus } from '~~/shared/grading'

export const kindLabels: Record<TaskKind, string> = {
  task2: '作文 Task 2',
  task1: '作文 Task 1',
  speaking: '口语',
}

export const kindScoreNames: Record<TaskKind, Record<ScoreKey, string>> = {
  task2: { tr: '任务回应', ta: '任务达成', fc: '流利与连贯', cc: '连贯与衔接', lr: '词汇资源', gra: '语法范围与准确性', p: '发音' },
  task1: { tr: '任务回应', ta: '任务达成', fc: '流利与连贯', cc: '连贯与衔接', lr: '词汇资源', gra: '语法范围与准确性', p: '发音' },
  speaking: { tr: '任务回应', ta: '任务达成', fc: '流利与连贯', cc: '连贯与衔接', lr: '词汇资源', gra: '语法范围与准确性', p: '发音' },
}

export const kindEyebrows: Record<TaskKind, string> = {
  task2: 'IELTS WRITING · TASK 2',
  task1: 'IELTS WRITING · TASK 1',
  speaking: 'IELTS SPEAKING',
}

export const kindPromptTitles: Record<TaskKind, string> = {
  task2: 'Task 2 题目',
  task1: 'Task 1 题目（含图表）',
  speaking: '口语题目',
}

export const kindAnswerTitles: Record<TaskKind, string> = {
  task2: '学生作文',
  task1: '学生作文',
  speaking: '回答转写',
}

export const workLabels: Record<WorkStatus, string> = {
  PENDING: '待复核',
  DRAFT: '草稿',
  CONFIRMED: '已确认',
}

export const syncLabels: Record<SyncStatus, string> = {
  NOT_SUBMITTED: '待提交',
  PENDING: '待回写',
  SYNCING: '回写中',
  SYNCED: '已回写',
  FAILED: '回写失败',
  CONFLICT: '答卷版本冲突',
}

type TagType = 'primary' | 'success' | 'warning' | 'info' | 'danger'
export const reviewStages: Record<ReviewStage, { label: string; type: TagType }> = {
  WAITING_AI: { label: '待批改', type: 'info' },
  GRADING: { label: '批改中', type: 'primary' },
  WAITING_REVIEW: { label: '待复核', type: 'warning' },
  WAITING_WRITEBACK: { label: '待回写', type: 'warning' },
  COMPLETED: { label: '已完成', type: 'success' },
}

export const workTypes: Record<WorkStatus, TagType> = {
  PENDING: 'info',
  DRAFT: 'warning',
  CONFIRMED: 'success',
}

export const syncTypes: Record<SyncStatus, TagType> = {
  NOT_SUBMITTED: 'info',
  PENDING: 'warning',
  SYNCING: 'primary',
  SYNCED: 'success',
  FAILED: 'danger',
  CONFLICT: 'danger',
}

export const auditLabels: Record<AuditEntry['action'], string> = {
  AI_REVIEW: '生成 AI 预批改',
  SAVE_DRAFT: '保存草稿',
  CONFIRM: '确认评分',
  SYNC_START: '开始回写',
  SYNC_SUCCESS: '回写成功',
  SYNC_FAIL: '回写失败',
  SYNC_CONFLICT: '答卷版本冲突',
}

const auditDateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'medium',
  timeStyle: 'short',
})

export function formatAuditDate(value: string) {
  return auditDateFormat.format(new Date(value))
}
