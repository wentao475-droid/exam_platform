export const TASK_KINDS = ['task2', 'task1', 'speaking'] as const
export type TaskKind = typeof TASK_KINDS[number]

export const DEMO_ROUND_URL =
  'https://portal.visioneschool.com/study-teach-product-admin/#/examPlatform/roundConfigExamSituation?examUid=E1267933648299773952&examRoundUid=ER1312416130135052288'

/** 各科目的四维评分维度（均为 4 项、0–9 步长 0.5）。 */
export const SCORE_KEYS_BY_KIND: Record<TaskKind, readonly ScoreKey[]> = {
  task2: ['tr', 'cc', 'lr', 'gra'],
  task1: ['ta', 'cc', 'lr', 'gra'],
  speaking: ['fc', 'lr', 'gra', 'p'],
}

export function scoreKeysFor(kind: TaskKind): readonly ScoreKey[] {
  return SCORE_KEYS_BY_KIND[kind]
}

export const ALL_SCORE_KEYS = ['tr', 'ta', 'fc', 'cc', 'lr', 'gra', 'p'] as const
export type ScoreKey = typeof ALL_SCORE_KEYS[number]
export type ReadMode = 'demo' | 'live'
/** 完整性由按科目的 Zod schema 在 API 边界保证。 */
export type Scores = Partial<Record<ScoreKey, number>>
export type WorkStatus = 'PENDING' | 'DRAFT' | 'CONFIRMED'
export type SyncStatus = 'NOT_SUBMITTED' | 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'CONFLICT'
export type AiStatus = 'NOT_GRADED' | 'GRADED'

export const SCORE_LABELS: Record<ScoreKey, string> = {
  tr: 'Task Response',
  ta: 'Task Achievement',
  fc: 'Fluency and Coherence',
  cc: 'Coherence and Cohesion',
  lr: 'Lexical Resource',
  gra: 'Grammatical Range and Accuracy',
  p: 'Pronunciation',
}

/** 内置模拟评分使用的提示词版本（按科目）；其他版本代表真实模型调用。 */
export const MOCK_AI_PROMPT_VERSIONS: Record<TaskKind, string> = {
  task2: 'ielts-task2-demo-v2',
  task1: 'ielts-task1-demo-v1',
  speaking: 'ielts-speaking-demo-v1',
}

export function isMockAi(promptVersion: string) {
  return (Object.values(MOCK_AI_PROMPT_VERSIONS) as string[]).includes(promptVersion)
}

/**
 * 雅思合分规则：平均分小数 <0.25 向下取整，0.25–0.75 取就近 0.5 档，≥0.75 向上取整。
 * 四项分数均为 0.5 的倍数，二进制下精确表示，无浮点误差。
 */
export function roundBandMean(mean: number): number {
  return Math.round(mean * 2) / 2
}

/** 按科目维度计算均分并按雅思规则取整。调用方需先经 schema 校验保证四项齐全。 */
export function meanOf(kind: TaskKind, scores: Scores): number {
  const keys = SCORE_KEYS_BY_KIND[kind]
  const total = keys.reduce((sum, key) => sum + (scores[key] ?? 0), 0)
  return roundBandMean(total / keys.length)
}

export interface SessionUser {
  id: string
  name: string
  role: 'TEACHER'
}

export interface TaskSummary {
  id: string
  kind: TaskKind
  studentCode: string
  sourceStatus: string
  workStatus: WorkStatus
  syncStatus: SyncStatus
  aiStatus: AiStatus
}

export interface RoundTaskSummary extends TaskSummary {
  studentName?: string
  customerCode?: string
  submittedAt?: string
  examType?: string
}

export type ReviewStage = 'WAITING_AI' | 'GRADING' | 'WAITING_REVIEW' | 'WAITING_WRITEBACK' | 'COMPLETED'

export function reviewStageOf(task: TaskSummary, grading = false): ReviewStage {
  if (task.syncStatus === 'SYNCED') return 'COMPLETED'
  if (grading) return 'GRADING'
  if (task.workStatus !== 'PENDING') return 'WAITING_WRITEBACK'
  return task.aiStatus === 'GRADED' ? 'WAITING_REVIEW' : 'WAITING_AI'
}

export interface RoundOption {
  examRoundUid: string
  name: string
  url: string
}

export interface RoundDetail {
  readMode: ReadMode
  examUid: string
  examRoundUid: string
  name: string
  tasks: RoundTaskSummary[]
}

export const roundStreamType = 'application/x-ndjson'

export type RoundLoadEvent =
  | { type: 'round'; round: Omit<RoundDetail, 'tasks'>; total: number }
  | { type: 'tasks'; tasks: RoundTaskSummary[]; checked: number }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface RoundAiResult {
  round: RoundDetail
  results: { graded: number; skipped: number; failed: number }
}

export type RoundAiEvent =
  | { type: 'grading'; id: string }
  | { type: 'task'; task: RoundTaskSummary }
  | { type: 'done'; result: RoundAiResult }
  | { type: 'error'; status?: number; code?: string }

export interface Draft {
  revision: number
  answerVersion: string
  scores: Scores
  mean: number
  comment: string
}

export interface Annotation {
  quote: string
  comment: string
  suggestion: string
  range: { start: number; end: number } | null
}

export interface AiReview {
  answerVersion: string
  scores: Scores
  reasons: Partial<Record<ScoreKey, string>>
  summary: string
  teacherComment?: string
  annotations: Annotation[]
  suggestions: string[]
  promptVersion: string
}

export interface Confirmation {
  answerVersion: string
  scores: Scores
  mean: number
  comment: string
  confirmedAt: string
  syncAttempts: number
  syncMessage: string | null
}

export interface AuditEntry {
  id: string
  actor: string
  action: 'AI_REVIEW' | 'SAVE_DRAFT' | 'CONFIRM' | 'SYNC_START' | 'SYNC_SUCCESS' | 'SYNC_FAIL' | 'SYNC_CONFLICT'
  at: string
  detail: string | null
}

export interface TaskDetail extends TaskSummary {
  readMode: ReadMode
  examUid: string
  examRoundUid: string
  examName: string
  questionUid: string
  promptHtml: string
  answerText: string
  wordCount: number
  answerVersion: string
  revision: number
  draft: Draft | null
  ai: AiReview | null
  confirmation: Confirmation | null
  audit: AuditEntry[]
}
