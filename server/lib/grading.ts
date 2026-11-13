import { createError } from 'h3'
import { Prisma } from '@prisma/client'
import type { z } from 'zod'
import type { AiReview, Draft, RoundAiEvent, RoundAiResult, RoundDetail, RoundLoadEvent, RoundTaskSummary, Scores, SyncStatus, TaskDetail, TaskKind, TaskSummary } from '../../shared/grading'
import { meanOf, roundBandMean } from '../../shared/grading'
import { activeAiFor, normalizeAi, RUBRICS } from './ai'
import { demoBehavior } from './demo'
import { canUseLiveAccount, getReadMode, livePlatformFor, liveTaskId } from './live-platform'
import { mockPlatform } from './mock-platform'
import { prisma } from './prisma'
import { parseRoundUrl, type ExamPlatformAdapter, type RoundKey, type SourceAnswer, type SourceListRow, type WriteOutcome } from './source'
import { draftBodyFor, draftWire, submitBody } from './validation'

const includeSubmission = { activeSubmission: true } as const
type TaskRecord = Prisma.TaskGetPayload<{ include: typeof includeSubmission }>
type SubmissionRecord = NonNullable<TaskRecord['activeSubmission']>
type DraftInput = z.output<typeof draftWire>
type SubmitInput = z.output<typeof submitBody>

const syncLeaseMs = 15_000
const roundConcurrency = 5
const roundDiscoveryConcurrency = 12

function notFound() {
  return createError({ statusCode: 404, statusMessage: 'Grading task or source answer not found' })
}

function conflict(statusMessage: string) {
  return createError({ statusCode: 409, statusMessage })
}

function assertVersion(answer: SourceAnswer, expected: string) {
  if (answer.answerVersion !== expected) throw conflict('Answer changed. Reload and review the latest answer.')
}

function leaseExpired(submission: SubmissionRecord) {
  return submission.state === 'SYNCING' && (!submission.leaseUntil || submission.leaseUntil <= new Date())
}

function taskAi(task: TaskRecord, answerVersion: string | undefined) {
  const ai = task.ai as unknown as AiReview | null
  return ai?.answerVersion === answerVersion ? ai : null
}

function summary(task: TaskRecord, studentCode: string, sourceStatus: string, answerVersion?: string): TaskSummary {
  const submission = task.activeSubmission
  const syncStatus: SyncStatus = submission
    ? (leaseExpired(submission) ? 'FAILED' : submission.state)
    : 'NOT_SUBMITTED'
  return {
    id: task.id,
    kind: task.kind as TaskKind,
    studentCode,
    sourceStatus,
    workStatus: submission ? 'CONFIRMED' : task.draft ? 'DRAFT' : 'PENDING',
    syncStatus,
    aiStatus: taskAi(task, answerVersion) ? 'GRADED' : 'NOT_GRADED',
  }
}

function roundSummary(task: TaskRecord, row: SourceListRow, answerVersion?: string): RoundTaskSummary {
  return {
    ...summary(task, row.studentCode, row.correctStatusTitle, answerVersion),
    studentName: row.studentName || undefined,
    customerCode: row.customerCode || undefined,
    submittedAt: row.endTime || undefined,
    examType: row.examTypeTitle || undefined,
  }
}

async function ownedTask(id: string, teacherId: string) {
  if (id.startsWith('live-') !== (getReadMode() === 'live')) throw notFound()
  const task = await prisma.task.findFirst({ where: { id, teacherId }, include: includeSubmission })
  if (!task) throw notFound()
  return task
}

async function liveRound(round: RoundKey, teacherId: string) {
  const teacher = await prisma.user.findUnique({ where: { id: teacherId }, select: { email: true } })
  if (!teacher || !canUseLiveAccount(teacherId, teacher.email)) throw notFound()
  return livePlatformFor(round, teacher.email)
}

async function taskPlatform(task: TaskRecord) {
  return task.id.startsWith('live-') ? await liveRound(task, task.teacherId) : mockPlatform
}

async function sourceAnswer(task: TaskRecord) {
  const platform = await taskPlatform(task)
  if (platform !== mockPlatform) {
    const source = await platform.listWriting(task)
    if (!source?.rows.some(row => row.examHistoryId === task.examHistoryId)) throw notFound()
  }
  return await readAnswer(task, platform)
}

async function readAnswer(task: TaskRecord, platform: ExamPlatformAdapter) {
  const answer = await platform.readAnswer(task)
  if (!answer) throw notFound()
  return answer
}

async function loadRoundSource(url: string, teacherId: string) {
  const round = parseRoundUrl(url)
  if (!round) throw createError({
    statusCode: 400,
    statusMessage: 'Invalid exam round link',
    data: { message: '请粘贴完整的原考试平台「考试情况」链接，或点击「打开示例轮次」。' },
  })

  const readMode = getReadMode()
  const livePlatform = readMode === 'live' ? await liveRound(round, teacherId) : null
  const platform = livePlatform ?? mockPlatform
  const source = await platform.listWriting(round)
  if (!source) {
    if (readMode === 'live') throw notFound()
    throw createError({
      statusCode: 404,
      statusMessage: 'Round not configured for demo',
      data: { message: '该轮次未配置演示数据。当前环境仅提供虚构答卷，请点击「打开示例轮次」继续体验。' },
    })
  }
  return { readMode, round, platform, livePlatform, source }
}

async function liveRoundTasks(platform: ReturnType<typeof livePlatformFor>, round: RoundKey, historyId: string, teacherId: string, listRow?: SourceListRow) {
  const matches = await platform.identifyTasks(round, historyId, listRow)
  const results: Array<{ task: TaskRecord; answer: SourceAnswer }> = []
  for (const { ref, answer } of matches) {
    const id = liveTaskId(ref)
    const task = await prisma.task.upsert({
      where: { id },
      create: { id, examUid: ref.examUid, examRoundUid: ref.examRoundUid, examHistoryId: ref.examHistoryId, questionUid: ref.questionUid, kind: ref.kind, teacherId },
      update: {},
      include: includeSubmission,
    })
    if (task.teacherId === teacherId) results.push({ task, answer })
  }
  return results
}

export async function* loadRound(url: string, teacherId: string, signal?: AbortSignal): AsyncGenerator<RoundLoadEvent> {
  const { readMode, round, livePlatform, source } = await loadRoundSource(url, teacherId)
  yield { type: 'round', round: { readMode, ...round, name: source.name }, total: source.rows.length }
  if (signal?.aborted) return
  if (livePlatform) {
    // 已有任务覆盖答卷科目或刚检查过时复用本地汇总，其他答卷重新识别缺少的科目。
    // AI 是否过期的精确校验延后到打开阅卷页时进行。
    const existing = await prisma.task.findMany({
      where: { teacherId, ...round, examHistoryId: { in: source.rows.map(row => row.examHistoryId) } },
      include: includeSubmission,
    })
    const known = new Map<string, TaskRecord[]>()
    for (const task of existing) {
      if (!task.id.startsWith('live-')) continue
      const list = known.get(task.examHistoryId) ?? []
      list.push(task)
      known.set(task.examHistoryId, list)
    }
    const tasks: RoundTaskSummary[] = []
    const unseen: typeof source.rows = []
    for (const row of source.rows) {
      const local = known.get(row.examHistoryId) ?? []
      if (livePlatform.canReuseListTasks(row, local)) {
        tasks.push(...local.map(task => {
          const ai = task.ai as unknown as AiReview | null
          return roundSummary(task, row, ai?.answerVersion)
        }))
      } else {
        unseen.push(row)
      }
    }
    const knownCount = source.rows.length - unseen.length
    yield { type: 'tasks', tasks, checked: knownCount }
    for (let index = 0; index < unseen.length && !signal?.aborted; index += roundDiscoveryConcurrency) {
      const batch = await Promise.all(unseen.slice(index, index + roundDiscoveryConcurrency).map(async row => {
        const identified = await liveRoundTasks(livePlatform, round, row.examHistoryId, teacherId, row)
        return identified.map(({ task, answer }) => roundSummary(task, row, answer.answerVersion))
      }))
      yield { type: 'tasks', tasks: batch.flat(), checked: knownCount + index + batch.length }
    }
    if (!signal?.aborted) yield { type: 'done' }
    return
  }

  const candidates = new Map(source.rows.map(row => [row.examHistoryId, row]))
  const records = await prisma.task.findMany({
    where: { teacherId, ...round, examHistoryId: { in: [...candidates.keys()] } },
    include: includeSubmission,
    // 同一答卷有多道题（task1/task2/speaking），按 id 排序保证列表顺序稳定。
    orderBy: [{ examHistoryId: 'asc' }, { id: 'asc' }],
  })
  const tasks = await Promise.all(records.map(async task => {
    const row = candidates.get(task.examHistoryId)
    const answer = row && await mockPlatform.readAnswer(task)
    if (!row || !answer) return null
    return summary(task, row.studentCode, row.correctStatusTitle, answer.answerVersion)
  }))
  yield { type: 'tasks', tasks: tasks.filter(task => task !== null), checked: source.rows.length }
  yield { type: 'done' }
}

export async function openRound(url: string, teacherId: string): Promise<RoundDetail> {
  const tasks: RoundTaskSummary[] = []
  let round: Omit<RoundDetail, 'tasks'> | undefined
  for await (const update of loadRound(url, teacherId)) {
    if (update.type === 'round') round = update.round
    if (update.type === 'tasks') tasks.push(...update.tasks)
  }
  return { ...round!, tasks }
}

export async function taskDetail(id: string, teacherId: string): Promise<TaskDetail> {
  const task = await ownedTask(id, teacherId)
  const platform = await taskPlatform(task)
  const [source, audits] = await Promise.all([
    platform.listWriting(task),
    prisma.audit.findMany({
      where: { taskId: id },
      include: { actor: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
  ])
  const row = source?.rows.find(item => item.examHistoryId === task.examHistoryId)
  if (!source || !row) throw notFound()
  const answer = await readAnswer(task, platform)
  const submission = task.activeSubmission
  return {
    ...summary(task, row.studentCode, row.correctStatusTitle, answer.answerVersion),
    readMode: platform === mockPlatform ? 'demo' : 'live',
    examUid: task.examUid,
    examRoundUid: task.examRoundUid,
    examName: source.name,
    questionUid: task.questionUid,
    promptHtml: answer.promptHtml,
    answerText: answer.answerText,
    wordCount: answer.answerText.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu)?.length ?? 0,
    answerVersion: answer.answerVersion,
    revision: task.revision,
    draft: task.draft as unknown as Draft | null,
    ai: taskAi(task, answer.answerVersion),
    confirmation: submission ? {
      answerVersion: submission.answerVersion,
      scores: submission.scores as unknown as Scores,
      mean: submission.mean,
      comment: submission.comment,
      confirmedAt: submission.confirmedAt.toISOString(),
      syncAttempts: submission.attempts,
      syncMessage: leaseExpired(submission) ? '上次回写状态未确认，可安全重试' : submission.message,
    } : null,
    audit: audits.map(audit => ({
      id: audit.id,
      actor: audit.actor.name,
      action: audit.action,
      at: audit.createdAt.toISOString(),
      detail: audit.detail,
    })),
  }
}

function isEditable(task: TaskRecord, answerVersion: string) {
  return !task.activeSubmission
    || (task.activeSubmission.state === 'CONFLICT' && task.activeSubmission.answerVersion !== answerVersion)
}

function ensureEditable(task: TaskRecord, answerVersion: string) {
  if (!isEditable(task, answerVersion)) throw conflict('Grade is already confirmed')
}

async function generateAi(id: string, teacherId: string, answer: SourceAnswer, reread: () => Promise<SourceAnswer>, onStart?: () => void, regenerate = false) {
  const task = await ownedTask(id, teacherId)
  const { answerVersion } = answer
  const kind = task.kind as TaskKind
  const { provider: aiProvider, promptVersion } = activeAiFor(kind)
  ensureEditable(task, answerVersion)
  const previous = taskAi(task, answerVersion)
  if (!regenerate && previous?.teacherComment && previous.promptVersion === promptVersion) return { task, generated: false }
  onStart?.()
  let ai: AiReview
  try {
    if (!task.id.startsWith('live-') && demoBehavior(task.examHistoryId)?.aiFails) throw new Error('演示用的模拟 AI 失败')
    const output = await aiProvider.grade({
      prompt: answer.promptText,
      answer: answer.answerText,
      kind,
      rubric: RUBRICS[kind],
      promptVersion,
      images: answer.promptImages,
    })
    ai = normalizeAi(output, answer.answerText, answerVersion, promptVersion, kind)
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 800)
    await prisma.audit.create({
      data: { taskId: id, actorId: teacherId, action: 'AI_REVIEW', detail: `AI 评分失败，可继续人工评分：${reason}` },
    })
    throw createError({ statusCode: 502, statusMessage: 'AI grading failed. Manual grading is available.' })
  }

  assertVersion(await reread(), answerVersion)
  const saved = await prisma.$transaction(async tx => {
    const updated = await tx.task.updateMany({
      where: {
        id,
        teacherId,
        activeSubmissionId: task.activeSubmissionId,
        ai: { equals: task.ai === null ? Prisma.DbNull : task.ai as Prisma.InputJsonValue },
      },
      data: { ai: ai as unknown as Prisma.InputJsonValue },
    })
    if (!updated.count) throw conflict('Task changed. Reload before continuing.')
    await tx.audit.create({
      data: { taskId: id, actorId: teacherId, action: 'AI_REVIEW', detail: promptVersion },
    })
    return await tx.task.findUniqueOrThrow({ where: { id }, include: includeSubmission })
  })
  return { task: saved, generated: true }
}

const inFlightAi = new Map<string, ReturnType<typeof generateAi>>()

async function requestTaskAi(task: TaskRecord, answer: SourceAnswer, reread: () => Promise<SourceAnswer>, onStart?: () => void, regenerate = false) {
  const key = JSON.stringify([task.id, answer.answerVersion])
  const active = inFlightAi.get(key)
  if (active) {
    onStart?.()
    return { task: (await active).task, generated: false }
  }
  const job = generateAi(task.id, task.teacherId, answer, reread, onStart, regenerate)
  inFlightAi.set(key, job)
  try {
    return await job
  } finally {
    inFlightAi.delete(key)
  }
}

export async function requestAi(id: string, teacherId: string, answerVersion: string, regenerate = false) {
  const task = await ownedTask(id, teacherId)
  const answer = await sourceAnswer(task)
  assertVersion(answer, answerVersion)
  ensureEditable(task, answerVersion)
  await requestTaskAi(task, answer, () => sourceAnswer(task), undefined, regenerate)
  return await taskDetail(id, teacherId)
}

export async function requestRoundAi(url: string, teacherId: string, onUpdate?: (event: RoundAiEvent) => void): Promise<RoundAiResult> {
  const { readMode, round, platform, livePlatform, source } = await loadRoundSource(url, teacherId)
  const records = await prisma.task.findMany({
    where: { teacherId, ...round, examHistoryId: { in: source.rows.map(row => row.examHistoryId) } },
    include: includeSubmission,
    orderBy: [{ examHistoryId: 'asc' }, { id: 'asc' }],
  })
  // 同一答卷可能对应多道题（task1/task2/speaking），按答卷分组后逐题处理。
  const byHistory = new Map<string, TaskRecord[]>()
  for (const task of records) {
    if (task.id.startsWith('live-') !== (readMode === 'live')) continue
    const list = byHistory.get(task.examHistoryId) ?? []
    list.push(task)
    byHistory.set(task.examHistoryId, list)
  }
  const tasks: RoundTaskSummary[] = []
  const results = { graded: 0, skipped: 0, failed: 0 }
  const summarizeRow = async (row: SourceListRow): Promise<RoundTaskSummary[]> => {
    // 同一答卷的多道题必须全部落定（allSettled）再统计：若用 Promise.all，
    // 一题失败会遗弃兄弟任务在后台继续写库，计数与审计都会与响应不一致。
    const summarizeTask = async (task: TaskRecord, answer: SourceAnswer): Promise<RoundTaskSummary> => {
      if (!isEditable(task, answer.answerVersion)) {
        results.skipped++
        return roundSummary(task, row, answer.answerVersion)
      }
      try {
        const result = await requestTaskAi(task, answer, () => readAnswer(task, platform),
          () => onUpdate?.({ type: 'grading', id: task.id }))
        results[result.generated ? 'graded' : 'skipped']++
        const summary = roundSummary(result.task, row, answer.answerVersion)
        onUpdate?.({ type: 'task', task: summary })
        return summary
      } catch (error) {
        onUpdate?.({ type: 'task', task: roundSummary(task, row, answer.answerVersion) })
        throw error
      }
    }
    const failedRow = () => (byHistory.get(row.examHistoryId) ?? []).map(task => roundSummary(task, row))
    try {
      if (livePlatform) {
        const identified = await liveRoundTasks(livePlatform, round, row.examHistoryId, teacherId)
        const settled = await Promise.allSettled(identified.map(({ task, answer }) => summarizeTask(task, answer)))
        if (settled.some(item => item.status === 'rejected')) {
          results.failed++
          return identified.map(({ task, answer }, index) => {
            const result = settled[index]
            return result?.status === 'fulfilled' ? result.value : roundSummary(task, row, answer.answerVersion)
          })
        }
        return settled.flatMap(item => (item.status === 'fulfilled' && item.value ? [item.value] : []))
      }
      const candidates = byHistory.get(row.examHistoryId) ?? []
      const answers = await Promise.all(candidates.map(async task => ({ task, answer: await platform.readAnswer(task) })))
      const settled = await Promise.allSettled(answers.map(({ task, answer }) =>
        answer ? summarizeTask(task, answer) : Promise.resolve(null)))
      if (settled.some(item => item.status === 'rejected')) {
        results.failed++
        return answers.flatMap(({ task, answer }, index) => {
          const result = settled[index]
          return result?.status === 'fulfilled' ? result.value ?? [] : roundSummary(task, row, answer?.answerVersion)
        })
      }
      return settled.flatMap(item => (item.status === 'fulfilled' && item.value ? [item.value] : []))
    } catch {
      results.failed++
      return failedRow()
    }
  }
  for (let index = 0; index < source.rows.length; index += roundConcurrency) {
    const batch = await Promise.all(source.rows.slice(index, index + roundConcurrency).map(summarizeRow))
    tasks.push(...batch.flat())
  }
  return { round: { readMode, ...round, name: source.name, tasks }, results }
}

export async function saveDraft(id: string, teacherId: string, input: DraftInput) {
  const task = await ownedTask(id, teacherId)
  // 草稿纯本地：不读上游、不核对答卷版本（核对统一在确认提交时）。
  // scores 的维度完整性按 task.kind 在这里补齐校验。
  const parsed = draftBodyFor(task.kind as TaskKind).parse(input)
  ensureEditable(task, parsed.answerVersion)

  const draft = {
    ...parsed,
    revision: parsed.revision + 1,
    mean: meanOf(task.kind as TaskKind, parsed.scores),
  }
  await prisma.$transaction(async tx => {
    const updated = await tx.task.updateMany({
      where: { id, teacherId, revision: parsed.revision, activeSubmissionId: task.activeSubmissionId },
      data: { revision: draft.revision, draft, activeSubmissionId: null },
    })
    if (!updated.count) throw conflict('Draft changed. Reload before saving again.')
    await tx.audit.create({ data: { taskId: id, actorId: teacherId, action: 'SAVE_DRAFT' } })
  })
  return await taskDetail(id, teacherId)
}

function matchingConfirmation(task: TaskRecord, input: SubmitInput) {
  const draft = task.draft as unknown as Draft | null
  return task.activeSubmission?.answerVersion === input.answerVersion && draft?.revision === input.revision
    ? task.activeSubmission
    : null
}

export async function submit(id: string, teacherId: string, input: SubmitInput) {
  const task = await ownedTask(id, teacherId)
  const prior = matchingConfirmation(task, input)
  if (prior) {
    if (prior.state === 'PENDING') await synchronize(task, teacherId, prior)
    return await taskDetail(id, teacherId)
  }

  assertVersion(await sourceAnswer(task), input.answerVersion)
  if (task.activeSubmission) throw conflict('Grade is already confirmed')
  const draft = task.draft as unknown as Draft | null
  if (!draft || draft.answerVersion !== input.answerVersion || draft.revision !== input.revision) {
    throw conflict('Save the latest draft before confirming')
  }

  const submission = await prisma.$transaction(async tx => {
    const updated = await tx.task.updateMany({
      where: { id, teacherId, revision: input.revision, activeSubmissionId: null },
      data: { revision: { increment: 1 } },
    })
    if (!updated.count) throw conflict('Task changed. Reload before confirming.')
    const created = await tx.submission.create({
      data: { taskId: id, answerVersion: draft.answerVersion, scores: draft.scores, mean: draft.mean, comment: draft.comment },
    })
    await tx.task.update({ where: { id }, data: { activeSubmissionId: created.id } })
    await tx.audit.create({ data: { taskId: id, actorId: teacherId, action: 'CONFIRM' } })
    return created
  }).catch(async (error: unknown) => {
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 409) {
      const existing = matchingConfirmation(await ownedTask(id, teacherId), input)
      if (existing) return existing
    }
    throw error
  })
  if (submission.state === 'PENDING') await synchronize(task, teacherId, submission)
  return await taskDetail(id, teacherId)
}

export async function retry(id: string, teacherId: string) {
  const task = await ownedTask(id, teacherId)
  if (!task.activeSubmission) throw conflict('No confirmed submission')
  await synchronize(task, teacherId, task.activeSubmission, true)
  return await taskDetail(id, teacherId)
}

async function synchronize(task: TaskRecord, teacherId: string, submission: SubmissionRecord, allowRetry = false) {
  const platform = await taskPlatform(task)
  const now = new Date()
  const eligible: Prisma.SubmissionWhereInput = allowRetry
    ? { OR: [
        // SYNCED 也允许重放：早期版本的回写请求缺顶层 scoreLevel/comment，
        // 平台返回 success 但未落成绩，教师可对已确认快照重新回写（答案变更仍转冲突）。
        { state: { in: ['PENDING', 'FAILED', 'SYNCED'] } },
        { state: 'SYNCING', leaseUntil: { lte: now } },
      ] }
    : { state: 'PENDING' }
  const claim = await prisma.$transaction(async tx => {
    const claimed = await tx.submission.updateMany({
      where: { id: submission.id, ...eligible },
      data: {
        state: 'SYNCING',
        attempts: { increment: 1 },
        leaseUntil: new Date(now.getTime() + syncLeaseMs),
        message: null,
      },
    })
    if (!claimed.count) return null
    await tx.audit.create({ data: { taskId: task.id, actorId: teacherId, action: 'SYNC_START' } })
    return await tx.submission.findUniqueOrThrow({ where: { id: submission.id } })
  })
  if (!claim) return

  let outcome: WriteOutcome
  try {
    outcome = await platform.writeResult({
      examUid: task.examUid,
      examRoundUid: task.examRoundUid,
      examHistoryId: task.examHistoryId,
      questionUid: task.questionUid,
      kind: task.kind as TaskKind,
      idempotencyKey: claim.id,
      answerVersion: claim.answerVersion,
      scores: claim.scores as unknown as Scores,
      mean: claim.mean,
      comment: claim.comment,
    }, claim.attempts)
  } catch {
    outcome = { state: 'FAILED', message: '回写结果暂未确认，可安全重试' }
  }
  const message = outcome.state === 'SYNCED' ? null : outcome.message
  const action = outcome.state === 'SYNCED' ? 'SYNC_SUCCESS' : outcome.state === 'FAILED' ? 'SYNC_FAIL' : 'SYNC_CONFLICT'

  // A retry may take over after a crash. The attempt number fences out stale workers.
  await prisma.$transaction(async tx => {
    const saved = await tx.submission.updateMany({
      where: { id: claim.id, state: 'SYNCING', attempts: claim.attempts },
      data: { state: outcome.state, leaseUntil: null, message },
    })
    if (!saved.count) return
    await tx.audit.create({ data: { taskId: task.id, actorId: teacherId, action, detail: message } })
  })
}
