import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { z } from 'zod'
import type { ReadMode } from '../../shared/grading'
import { normalizeAnswer, normalizeList, type AnswerRef, type ExamPlatformAdapter, type RoundKey } from './source'

const platformOrigin = 'https://portal.visioneschool.com'
const examQuery = '/management/BizVisioncup/examQuery'
const pageSize = 100
const maxRows = 10_000
const maxWritingCandidates = 300

const scopeSchema = z.object({
  examUid: z.string().regex(/^E[0-9]{1,30}$/),
  examRoundUid: z.string().regex(/^ER[0-9]{1,30}$/),
  name: z.string().trim().min(1).max(100),
  teacherEmail: z.string().email().transform(value => value.toLowerCase()),
  taskTwoQuestionUids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).min(1).max(50),
  examHistoryIds: z.array(z.string().regex(/^[0-9]{1,30}$/)).min(1).max(300).optional(),
}).strict()
const scopesSchema = z.array(scopeSchema).min(1).max(100).refine(scopes =>
  new Set(scopes.map(scope => scope.examRoundUid)).size === scopes.length,
)

type Scope = z.output<typeof scopeSchema>
type LiveCode = 'LIVE_NOT_CONFIGURED' | 'LIVE_ROUND_FORBIDDEN' | 'LIVE_UPSTREAM_AUTH' | 'LIVE_UPSTREAM_UNAVAILABLE'

const errors = {
  LIVE_NOT_CONFIGURED: [503, '真实读取尚未配置完成，请联系管理员。'],
  LIVE_ROUND_FORBIDDEN: [403, '当前教师没有此轮次的读取权限。'],
  LIVE_UPSTREAM_AUTH: [502, '原考试平台拒绝授权，请联系管理员更新只读凭证。'],
  LIVE_UPSTREAM_UNAVAILABLE: [502, '原考试平台读取失败，请稍后重试。'],
} as const

function liveError(code: LiveCode) {
  const [statusCode, message] = errors[code]
  return createError({ statusCode, statusMessage: code, data: { code, message } })
}

export function getReadMode(): ReadMode {
  return process.env.EXAM_READ_MODE === 'live' ? 'live' : 'demo'
}

function getScopes() {
  try {
    return scopesSchema.parse(JSON.parse(process.env.EXAM_LIVE_ROUNDS ?? ''))
  } catch {
    throw liveError('LIVE_NOT_CONFIGURED')
  }
}

export function canUseLiveAccount(id: string, email: string) {
  if (!id.startsWith('live-teacher-')) return false
  try {
    return getScopes().some(scope => scope.teacherEmail === email)
  } catch {
    return false
  }
}

function taskKey(ref: AnswerRef) {
  return createHash('sha256')
    .update(JSON.stringify([ref.examUid, ref.examRoundUid, ref.examHistoryId, ref.questionUid]))
    .digest('hex')
}

export function liveTaskId(ref: AnswerRef) {
  return 'live-' + taskKey(ref)
}

export function livePlatformFor(round: RoundKey, teacherEmail: string) {
  const scope = getScopes().find(item => item.teacherEmail === teacherEmail
    && item.examUid === round.examUid && item.examRoundUid === round.examRoundUid)
  if (!scope) throw liveError('LIVE_ROUND_FORBIDDEN')

  const token = process.env.EXAM_PLATFORM_V_TOKEN
  if (!token) throw liveError('LIVE_NOT_CONFIGURED')
  return createLivePlatform(scope, {
    token,
    tokenType: process.env.EXAM_PLATFORM_V_TOKEN_TYPE || 'e-n-p',
    cookie: process.env.EXAM_PLATFORM_COOKIE,
  })
}

interface Credentials {
  token: string
  tokenType: string
  cookie?: string
}

export function createLivePlatform(scope: Scope, credentials: Credentials, transport: typeof fetch = fetch) {
  const configuredIds = scope.examHistoryIds ? new Set(scope.examHistoryIds) : null
  const questions = [...new Set(scope.taskTwoQuestionUids)]
  let headers: Headers
  try {
    headers = new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
      'v-token': credentials.token,
      'v-token-type': credentials.tokenType,
    })
    if (credentials.cookie) headers.set('cookie', credentials.cookie)
  } catch {
    throw liveError('LIVE_NOT_CONFIGURED')
  }

  async function request(path: string, init: RequestInit = {}) {
    let response: Response
    try {
      response = await transport(platformOrigin + examQuery + path, {
        ...init,
        headers,
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
        cache: 'no-store',
      })
    } catch {
      throw liveError('LIVE_UPSTREAM_UNAVAILABLE')
    }
    if (response.status === 401 || response.status === 403) throw liveError('LIVE_UPSTREAM_AUTH')
    if (!response.ok) throw liveError('LIVE_UPSTREAM_UNAVAILABLE')
    try {
      return await response.json() as unknown
    } catch {
      throw liveError('LIVE_UPSTREAM_UNAVAILABLE')
    }
  }

  function sameRound(round: RoundKey) {
    return round.examUid === scope.examUid && round.examRoundUid === scope.examRoundUid
  }

  async function listWriting(round: RoundKey) {
    if (!sameRound(round)) return null
    const seen = new Set<string>()
    const rows: ReturnType<typeof normalizeList>['rows'] = []
    for (let pageNumber = 1; pageNumber <= Math.ceil(maxRows / pageSize); pageNumber++) {
      const payload = await request('/pageExamHistoryInfo', {
        method: 'POST',
        body: JSON.stringify({ pageNumber, pageSize, examCategory: 4, examRounds: [round.examRoundUid] }),
      })
      let page: ReturnType<typeof normalizeList>
      try {
        page = normalizeList(payload)
      } catch {
        throw liveError('LIVE_UPSTREAM_UNAVAILABLE')
      }
      if (page.totalCount > maxRows || page.rowIds.length > pageSize
        || page.rowIds.some(id => seen.has(id)) || new Set(page.rowIds).size !== page.rowIds.length
        || page.rows.some(row => row.examRoundUid !== round.examRoundUid || !/^[0-9]{1,30}$/.test(row.examHistoryId))) {
        throw liveError('LIVE_UPSTREAM_UNAVAILABLE')
      }
      page.rowIds.forEach(id => seen.add(id))
      for (const row of page.rows) {
        if (configuredIds && !configuredIds.has(row.examHistoryId)) continue
        const pseudonym = createHash('sha256')
          .update(JSON.stringify([round.examRoundUid, row.examHistoryId])).digest('hex').slice(0, 12).toUpperCase()
        rows.push({ ...row, studentCode: '答卷 ' + pseudonym })
      }
      if (rows.length > maxWritingCandidates) throw liveError('LIVE_NOT_CONFIGURED')
      if (seen.size >= page.totalCount) {
        if (seen.size !== page.totalCount) throw liveError('LIVE_UPSTREAM_UNAVAILABLE')
        return { name: scope.name, rows }
      }
      if (page.rowIds.length !== pageSize) throw liveError('LIVE_UPSTREAM_UNAVAILABLE')
    }
    throw liveError('LIVE_UPSTREAM_UNAVAILABLE')
  }

  async function readCard(examHistoryId: string) {
    if (!/^[0-9]{1,30}$/.test(examHistoryId) || (configuredIds && !configuredIds.has(examHistoryId))) return null
    return await request('/exam/getExamVolQuizzesAndAnswerFile?' + new URLSearchParams({ examHistoryId }), { method: 'GET' })
  }

  function versionedAnswer(payload: unknown, ref: AnswerRef) {
    try {
      const answer = normalizeAnswer(payload, ref)
      if (!answer) return null
      const answerVersion = 'live-' + createHash('sha256').update(JSON.stringify(answer)).digest('hex')
      return { ...answer, answerVersion }
    } catch {
      throw liveError('LIVE_UPSTREAM_UNAVAILABLE')
    }
  }

  async function readAnswer(ref: AnswerRef) {
    if (!sameRound(ref) || !questions.includes(ref.questionUid)) return null
    const card = await readCard(ref.examHistoryId)
    return card === null ? null : versionedAnswer(card, ref)
  }

  async function identifyTask(round: RoundKey, examHistoryId: string) {
    if (!sameRound(round)) return null
    const card = await readCard(examHistoryId)
    if (card === null) return null
    const matches = questions.flatMap(questionUid => {
      const ref = { ...round, examHistoryId, questionUid }
      const answer = versionedAnswer(card, ref)
      return answer ? [{ ...ref, answer }] : []
    })
    return matches.length === 1 ? matches[0]! : null
  }

  const writeResult: ExamPlatformAdapter['writeResult'] = async result => {
    const source = await listWriting(result)
    const visible = source?.rows.some(row => row.examHistoryId === result.examHistoryId)
    const answer = visible ? await readAnswer(result) : null
    return answer?.answerVersion === result.answerVersion
      ? { state: 'SYNCED' }
      : { state: 'CONFLICT', message: '原平台答卷已更新或不可读取，请重新加载并复核。' }
  }

  return { listWriting, readAnswer, identifyTask, writeResult }
}
