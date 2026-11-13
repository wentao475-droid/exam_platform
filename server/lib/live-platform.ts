import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { z } from 'zod'
import { roundBandMean, type ReadMode, type RoundOption, type TaskKind } from '../../shared/grading'
import { examSubjectFor, detectCardKinds, normalizeAnswer, normalizeList, parseRoundUrl, type AnswerRef, type ExamPlatformAdapter, type RoundKey, type SourceListRow, type SourceResult, type WriteOutcome } from './source'

const platformOrigin = 'https://portal.visioneschool.com'
const examQuery = '/management/BizVisioncup/examQuery'
const writeCorrectPath = '/management/BizVisioncup/v1/api/visioncup/exam/manualCorrect'
const pageSize = 100
const listConcurrency = 4
const maxRows = 10_000
const cardLookupTtlMs = 120_000
const cardLookupLimit = 5_000
const recentCardLookups = new Map<string, { expiresAt: number; questionUids: string[] }>()

// 答题卡分卷（paperAnswerHistoryList 项）的防御性解析：原平台响应被截断过，
// 字段缺失或类型漂移都不能让整张卡解析失败，只跳过无法识别的分卷。
const cardVolumeSchema = z.object({
  examSubject: z.coerce.number().int(),
  examVolSubId: z.union([z.string().min(1), z.number()]).transform(String),
  examHistoryPaperId: z.union([z.string().min(1), z.number()]).nullish().transform(value => value ?? null),
  task1Score: z.union([z.string(), z.number()]).nullish().transform(value => value ?? null),
  task2Score: z.union([z.string(), z.number()]).nullish().transform(value => value ?? null),
  scoreLevel: z.union([z.string(), z.number()]).nullish().transform(value => value ?? null),
})

type CardVolume = z.output<typeof cardVolumeSchema>

export function extractVolumes(card: unknown): CardVolume[] {
  const list = (card as { data?: { paperAnswerHistoryList?: unknown } } | null | undefined)
    ?.data?.paperAnswerHistoryList
  if (!Array.isArray(list) || list.length === 0) throw new Error('缺少 paperAnswerHistoryList')
  const volumes: CardVolume[] = []
  for (const item of list) {
    const parsed = cardVolumeSchema.safeParse(item)
    if (parsed.success) volumes.push(parsed.data)
  }
  if (!volumes.length) throw new Error('paperAnswerHistoryList 中没有可识别的分卷')
  return volumes
}

/** 答题卡顶层的「总分」，多科目答卷回传时沿用，缺失按空串处理。 */
export function totalScoreLevelOf(card: unknown): string {
  const value = (card as { data?: { scoreLevel?: unknown } } | null | undefined)?.data?.scoreLevel
  if (value == null) return ''
  return typeof value === 'string' ? value : String(value)
}

function numberOr(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const scopeSchema = z.object({
  examUid: z.string().regex(/^E[0-9]{1,30}$/),
  examRoundUid: z.string().regex(/^ER[0-9]{1,30}$/),
  name: z.string().trim().min(1).max(100),
  teacherEmail: z.string().email().transform(value => value.toLowerCase()),
  taskTwoQuestionUids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(50),
  taskOneQuestionUids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(50).default([]),
  speakingQuestionUids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(50).default([]),
  autoDetectTasks: z.boolean().optional(),
  examHistoryIds: z.array(z.string().regex(/^[0-9]{1,30}$/)).min(1).max(300).optional(),
  sourceUrl: z.string().max(2000).optional(),
}).strict().refine(scope => {
  if (scope.sourceUrl === undefined) return true
  const round = parseRoundUrl(scope.sourceUrl)
  return round?.examUid === scope.examUid && round.examRoundUid === scope.examRoundUid
}).refine(scope => {
  // 空配置允许通过（沿用「加载时才发现未配题」的行为），但不允许同一 uid 挂在多个科目下。
  const all = [...scope.taskTwoQuestionUids, ...scope.taskOneQuestionUids, ...scope.speakingQuestionUids]
  return new Set(all).size === all.length
})
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

export function listLiveRoundsFor(teacherEmail: string): RoundOption[] {
  return getScopes()
    .filter(scope => scope.teacherEmail === teacherEmail)
    .map(({ examUid, examRoundUid, name, sourceUrl }) => ({
      examRoundUid,
      name,
      url: sourceUrl ?? (platformOrigin + '/study-teach-product-admin/#/examPlatform/roundConfigExamSituation?'
        + new URLSearchParams({ examUid, examRoundUid })),
    }))
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
  const questionKind = new Map<string, TaskKind>()
  for (const uid of scope.taskTwoQuestionUids) questionKind.set(uid, 'task2')
  for (const uid of scope.taskOneQuestionUids) questionKind.set(uid, 'task1')
  for (const uid of scope.speakingQuestionUids) questionKind.set(uid, 'speaking')
  const auto = scope.autoDetectTasks || questionKind.size === 0
  const discoveryScope = JSON.stringify([scope.teacherEmail, scope.examUid, scope.examRoundUid, auto, [...questionKind]])
  // 列表按已配置科目收缩，避免为未配置科目的答卷做无谓的答题卡请求；
  // 自动识别模式放行写作与口语两个科目，由答题卡内容决定实际任务。
  const configuredSubjects = auto ? [13, 14] : [...new Set([...questionKind.values()].map(examSubjectFor))]
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
    async function readPage(pageNumber: number) {
      const payload = await request('/pageExamHistoryInfo', {
        method: 'POST',
        body: JSON.stringify({ pageNumber, pageSize, examCategory: 4, examRounds: [round.examRoundUid] }),
      })
      try {
        return normalizeList(payload, configuredSubjects)
      } catch {
        throw liveError('LIVE_UPSTREAM_UNAVAILABLE')
      }
    }
    const first = await readPage(1)
    const { totalCount } = first
    if (totalCount > maxRows) throw liveError('LIVE_UPSTREAM_UNAVAILABLE')
    const pageCount = Math.max(1, Math.ceil(totalCount / pageSize))
    function collect(page: typeof first, pageNumber: number) {
      if (page.totalCount !== totalCount || page.rowIds.length !== Math.min(pageSize, totalCount - (pageNumber - 1) * pageSize)
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
    }
    collect(first, 1)
    for (let start = 2; start <= pageCount; start += listConcurrency) {
      const pages = await Promise.all(Array.from({ length: Math.min(listConcurrency, pageCount - start + 1) },
        (_, index) => readPage(start + index)))
      pages.forEach((page, index) => collect(page, start + index))
    }
    return { name: scope.name, rows }
  }

  async function readCard(examHistoryId: string) {
    if (!/^[0-9]{1,30}$/.test(examHistoryId) || (configuredIds && !configuredIds.has(examHistoryId))) return null
    return await request('/exam/getExamVolQuizzesAndAnswerFile?' + new URLSearchParams({ examHistoryId }), { method: 'GET' })
  }

  function versionedAnswer(payload: unknown, ref: AnswerRef, kind: TaskKind = 'task2') {
    try {
      const answer = normalizeAnswer(payload, ref, kind)
      if (!answer) return null
      const answerVersion = 'live-' + createHash('sha256').update(JSON.stringify(answer)).digest('hex')
      return { ...answer, answerVersion }
    } catch {
      throw liveError('LIVE_UPSTREAM_UNAVAILABLE')
    }
  }

  async function readAnswer(ref: AnswerRef) {
    if (!sameRound(ref)) return null
    // 已配置模式先按配置过滤，避免为未配置题目请求答题卡；自动模式需读卡后识别科目。
    if (!auto && !questionKind.has(ref.questionUid)) return null
    const card = await readCard(ref.examHistoryId)
    if (card === null) return null
    const kind = questionKind.get(ref.questionUid)
      ?? (auto ? detectCardKinds(card).get(ref.questionUid) : undefined)
    if (!kind) return null
    return versionedAnswer(card, ref, kind)
  }

  // 同一答卷可能同时包含配置内（或自动识别出）的多道题（如 task1+task2），
  // 返回全部匹配；由调用方为每道题独立建任务。
  function listLookupKey(row: SourceListRow) {
    return JSON.stringify([discoveryScope, row.examHistoryId, row.correctStatusTitle, row.examSubject])
  }

  function canReuseListTasks(row: SourceListRow, tasks: readonly { kind: string; questionUid: string }[]) {
    if (!auto && tasks.length) return true
    const subjects = row.examSubject.split(',').map(Number)
    const kinds = new Set(tasks.map(task => task.kind))
    if (auto && (!subjects.includes(14) || (kinds.has('task1') && kinds.has('task2')))
      && (!subjects.includes(13) || kinds.has('speaking'))) return true

    const recent = recentCardLookups.get(listLookupKey(row))
    return Boolean(recent && recent.expiresAt > Date.now()
      && recent.questionUids.length === tasks.length
      && recent.questionUids.every(uid => tasks.some(task => task.questionUid === uid)))
  }

  async function identifyTasks(round: RoundKey, examHistoryId: string, listRow?: SourceListRow) {
    if (!sameRound(round)) return []
    const card = await readCard(examHistoryId)
    if (card === null) return []
    const kinds = auto ? new Map([...detectCardKinds(card), ...questionKind]) : questionKind
    const candidates = [...kinds].flatMap(([questionUid, kind]) => {
      const ref = { ...round, examHistoryId, questionUid }
      const answer = versionedAnswer(card, ref, kind)
      return answer ? [{ ref: { ...ref, kind }, answer }] : []
    })
    const speaking = candidates.find(({ ref }) => ref.kind === 'speaking' && questionKind.has(ref.questionUid))
      ?? candidates.find(({ ref }) => ref.kind === 'speaking')
    const matches = auto ? candidates.filter(item => item.ref.kind !== 'speaking' || item === speaking) : candidates
    // Cache only question IDs for the list. AI and grading still read the current card.
    if (listRow && kinds.size) {
      const key = listLookupKey(listRow)
      recentCardLookups.delete(key)
      if (recentCardLookups.size >= cardLookupLimit) {
        const oldest = recentCardLookups.keys().next().value
        if (oldest !== undefined) recentCardLookups.delete(oldest)
      }
      recentCardLookups.set(key, {
        expiresAt: Date.now() + cardLookupTtlMs,
        questionUids: matches.map(({ ref }) => ref.questionUid),
      })
    }
    return matches
  }

  const writeResult: ExamPlatformAdapter['writeResult'] = async (result, attempt) => {
    if (process.env.EXAM_LIVE_WRITE === '1') {
      return await submitCorrection(result)
    }
    // 模拟回写（默认）：仅核对原平台答卷版本，分数不写回。
    const source = await listWriting(result)
    const visible = source?.rows.some(row => row.examHistoryId === result.examHistoryId)
    const answer = visible ? await readAnswer(result) : null
    return answer?.answerVersion === result.answerVersion
      ? { state: 'SYNCED' }
      : { state: 'CONFLICT', message: '原平台答卷已更新或不可读取，请重新加载并复核。' }
  }

  // 真实回写：读答题卡取各分卷原值，仅更新 Writing 分卷的 task2Score 与逐题批改内容，
  // 听力/阅读分卷原样回传，避免覆盖原平台已有批改。
  async function submitCorrection(result: SourceResult): Promise<WriteOutcome> {
    const card = await readCard(result.examHistoryId)
    if (card === null) {
      return { state: 'FAILED', message: '原平台答卷不可读取或未授权，无法回写，可稍后重试。' }
    }
    let answer: ReturnType<typeof versionedAnswer>
    try {
      answer = versionedAnswer(card, result, result.kind)
    } catch {
      return { state: 'CONFLICT', message: '原平台答卷已更新或不可读取，请重新加载并复核。' }
    }
    if (answer?.answerVersion !== result.answerVersion) {
      return { state: 'CONFLICT', message: '原平台答卷已更新或不可读取，请重新加载并复核。' }
    }

    let volumes: CardVolume[]
    try {
      volumes = extractVolumes(card)
    } catch (error) {
      return { state: 'FAILED', message: `无法解析原平台答题卡：${error instanceof Error ? error.message : '结构未知'}` }
    }
    const targetSubject = examSubjectFor(result.kind)
    const target = volumes.find(volume => volume.examSubject === targetSubject)
    if (!target || target.examHistoryPaperId == null) {
      const label = targetSubject === 13 ? '口语' : '写作'
      return { state: 'FAILED', message: `原平台答题卡缺少${label}分卷的 examHistoryPaperId，暂无法回写，请联系管理员。` }
    }

    // 分卷 scoreLevel 即平台「项目分」：写作卷取两题均值按雅思规则取整（抓包：task1 4.7 +
    // task2 5.5 → 5），口语卷取整场四维均分。口语的 task1Score/task2Score 保持原值（抓包已批改
    // 口语卷该两字段均为空）。
    const task1Original = numberOr(target.task1Score)
    const task2Original = numberOr(target.task2Score)
    const original = (value: number | string | null) => value == null ? '' : String(value)
    let band: number
    let task1Score: string
    let task2Score: string
    if (result.kind === 'task2') {
      band = task1Original === null ? result.mean : roundBandMean((task1Original + result.mean) / 2)
      task1Score = original(target.task1Score)
      task2Score = String(result.mean)
    } else if (result.kind === 'task1') {
      band = task2Original === null ? result.mean : roundBandMean((task2Original + result.mean) / 2)
      task1Score = String(result.mean)
      task2Score = original(target.task2Score)
    } else {
      band = result.mean
      task1Score = original(target.task1Score)
      task2Score = original(target.task2Score)
    }
    // 顶层 scoreLevel 是平台「总分」、comment 是「评语」：缺这两项时平台仍返回 success，
    // 但阅卷页的总分、项目分与评语都是空的（线上问题根因）。
    // 总分只用一位小数（抓包已批改卷为 "4.5"/"5.0"/"5.5"）；仅当答卷只有一个可阅卷分卷
    // （写作或口语）且听力/阅读分卷尚无分数时，总分等于该科目档位；同时含多科目成绩的
    // 答卷总分语义未验证，按答题卡原值回传，避免覆盖平台已有总评。
    const gradableVolumes = volumes.filter(volume => volume.examSubject === 13 || volume.examSubject === 14)
    const otherScored = volumes.some(volume => (volume.examSubject === 11 || volume.examSubject === 12)
      && numberOr(volume.scoreLevel) !== null)
    const totalScoreLevel = gradableVolumes.length === 1 && !otherScored
      ? band.toFixed(1)
      : totalScoreLevelOf(card)
    const payload = {
      examHistoryId: Number(result.examHistoryId),
      scoreLevel: totalScoreLevel,
      comment: result.comment,
      volList: volumes.map(volume => volume.examSubject === targetSubject
        ? {
            examHistoryPaperId: target.examHistoryPaperId,
            examVolSubId: volume.examVolSubId,
            scoreLevel: String(band),
            task1Score,
            task2Score,
            examManualCorrectQuizDTOList: [
              { questionUid: result.questionUid, correctContent: result.comment },
            ],
          }
        : {
            examHistoryPaperId: volume.examHistoryPaperId,
            examVolSubId: volume.examVolSubId,
            scoreLevel: volume.scoreLevel == null ? '' : String(volume.scoreLevel),
            task1Score: volume.task1Score == null ? '' : String(volume.task1Score),
            task2Score: volume.task2Score == null ? '' : String(volume.task2Score),
            examManualCorrectQuizDTOList: [],
          }),
    }

    let response: Response
    try {
      response = await transport(platformOrigin + writeCorrectPath, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
        cache: 'no-store',
      })
    } catch {
      return { state: 'FAILED', message: '回写请求发送失败，可安全重试。' }
    }
    if (response.status === 401 || response.status === 403) {
      return { state: 'FAILED', message: '原平台拒绝回写授权，请联系管理员确认写权限。' }
    }
    if (!response.ok) {
      return { state: 'FAILED', message: `原平台回写返回 ${response.status}，可安全重试。` }
    }
    try {
      const body = await response.json() as { code?: string; msg?: string; message?: string }
      if (body.code !== 'success') {
        return { state: 'FAILED', message: `原平台回写未成功：${body.msg ?? body.message ?? '原因未知'}，可安全重试。` }
      }
      return { state: 'SYNCED' }
    } catch {
      return { state: 'FAILED', message: '原平台回写响应无法解析，可安全重试。' }
    }
  }

  return { listWriting, readAnswer, identifyTasks, canReuseListTasks, writeResult }
}
