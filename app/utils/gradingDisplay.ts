import type { AuditEntry, SyncStatus, WorkStatus } from '~~/shared/grading'

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
