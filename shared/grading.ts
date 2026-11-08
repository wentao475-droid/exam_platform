export const SCORE_KEYS = ['tr', 'cc', 'lr', 'gra'] as const
export const SCORE_LABELS = {
  tr: 'Task Response',
  cc: 'Coherence and Cohesion',
  lr: 'Lexical Resource',
  gra: 'Grammatical Range and Accuracy',
} as const

export const DEMO_ROUND_URL =
  'https://portal.visioneschool.com/study-teach-product-admin/#/examPlatform/roundConfigExamSituation?examUid=E1267933648299773952&examRoundUid=ER1312416130135052288'

export type ScoreKey = typeof SCORE_KEYS[number]
export type ReadMode = 'demo' | 'live'
export type Scores = Record<ScoreKey, number>
export type WorkStatus = 'PENDING' | 'DRAFT' | 'CONFIRMED'
export type SyncStatus = 'NOT_SUBMITTED' | 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'CONFLICT'
export type AiStatus = 'NOT_GRADED' | 'GRADED'

export interface SessionUser {
  id: string
  name: string
  role: 'TEACHER'
}

export interface TaskSummary {
  id: string
  studentCode: string
  sourceStatus: string
  workStatus: WorkStatus
  syncStatus: SyncStatus
  aiStatus: AiStatus
}

export interface RoundDetail {
  readMode: ReadMode
  examUid: string
  examRoundUid: string
  name: string
  tasks: TaskSummary[]
}

export interface RoundAiResult {
  round: RoundDetail
  results: { graded: number; skipped: number; failed: number }
}

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
  reasons: Record<ScoreKey, string>
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
