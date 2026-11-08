import { createError } from 'h3'
import { Prisma } from '@prisma/client'
import type { z } from 'zod'
import type { AiReview, Draft, RoundAiResult, RoundDetail, Scores, SyncStatus, TaskDetail, TaskSummary } from '../../shared/grading'
import { SCORE_KEYS } from '../../shared/grading'
import { mockAi, normalizeAi, promptVersion, rubric } from './ai'
import { demoBehavior } from './demo'
import { canUseLiveAccount, getReadMode, livePlatformFor, liveTaskId } from './live-platform'
import { mockPlatform } from './mock-platform'
import { prisma } from './prisma'
import { parseRoundUrl, type ExamPlatformAdapter, type RoundKey, type SourceAnswer, type WriteOutcome } from './source'
import type { draftBody, submitBody } from './validation'

const includeSubmission = { activeSubmission: true } as const
type TaskRecord = Prisma.TaskGetPayload<{ include: typeof includeSubmission }>
type SubmissionRecord = NonNullable<TaskRecord['activeSubmission']>
type DraftInput = z.output<typeof draftBody>
type SubmitInput = z.output<typeof submitBody>

const syncLeaseMs = 15_000
const roundConcurrency = 5

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
    studentCode,
    sourceStatus,
    workStatus: submission ? 'CONFIRMED' : task.draft ? 'DRAFT' : 'PENDING',
    syncStatus,
    aiStatus: taskAi(task, answerVersion) ? 'GRADED' : 'NOT_GRADED',
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

async function liveRoundTask(platform: ReturnType<typeof livePlatformFor>, round: RoundKey, historyId: string, teacherId: string) {
  const identified = await platform.identifyTask(round, historyId)
  if (!identified) return null
  const { answer, ...ref } = identified
  const id = liveTaskId(ref)
  const task = await prisma.task.upsert({
    where: { id },
    create: { id, ...ref, teacherId },
    update: {},
    include: includeSubmission,
  })
  return task.teacherId === teacherId ? { task, answer } : null
}

export async function openRound(url: string, teacherId: string): Promise<RoundDetail> {
  const { readMode, round, livePlatform, source } = await loadRoundSource(url, teacherId)
  if (livePlatform) {
    const tasks: TaskSummary[] = []
    for (let index = 0; index < source.rows.length; index += roundConcurrency) {
      const batch = await Promise.all(source.rows.slice(index, index + roundConcurrency).map(async row => {
        const current = await liveRoundTask(livePlatform, round, row.examHistoryId, teacherId)
        return current ? summary(current.task, row.studentCode, row.correctStatusTitle, current.answer.answerVersion) : null
      }))
      tasks.push(...batch.filter(task => task !== null))
    }
    return { readMode, ...round, name: source.name, tasks }
  }

  const candidates = new Map(source.rows.map(row => [row.examHistoryId, row]))
  const records = await prisma.task.findMany({
    where: { teacherId, ...round, examHistoryId: { in: [...candidates.keys()] } },
    include: includeSubmission,
    orderBy: { examHistoryId: 'asc' },
  })
  const tasks = await Promise.all(records.map(async task => {
    const row = candidates.get(task.examHistoryId)
    const answer = row && await mockPlatform.readAnswer(task)
    if (!row || !answer) return null
    return summary(task, row.studentCode, row.correctStatusTitle, answer.answerVersion)
  }))
  return { readMode, ...round, name: source.name, tasks: tasks.filter(task => task !== null) }
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

async function generateAi(id: string, teacherId: string, answer: SourceAnswer, reread: () => Promise<SourceAnswer>) {
  const task = await ownedTask(id, teacherId)
  const { answerVersion } = answer
  ensureEditable(task, answerVersion)
  const previous = taskAi(task, answerVersion)
  if (previous?.teacherComment && previous.promptVersion === promptVersion) return { task, generated: false }
  let ai: AiReview
  try {
    if (!task.id.startsWith('live-') && demoBehavior(task.examHistoryId)?.aiFails) throw new Error('Simulated AI failure')
    const output = await mockAi.grade({ prompt: answer.promptText, answer: answer.answerText, rubric, promptVersion })
    ai = normalizeAi(output, answer.answerText, answerVersion)
  } catch {
    await prisma.audit.create({
      data: { taskId: id, actorId: teacherId, action: 'AI_REVIEW', detail: '模拟 AI 评分失败，可继续人工评分' },
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

async function requestTaskAi(task: TaskRecord, answer: SourceAnswer, reread: () => Promise<SourceAnswer>) {
  const key = JSON.stringify([task.id, answer.answerVersion])
  const active = inFlightAi.get(key)
  if (active) return { task: (await active).task, generated: false }
  const job = generateAi(task.id, task.teacherId, answer, reread)
  inFlightAi.set(key, job)
  try {
    return await job
  } finally {
    inFlightAi.delete(key)
  }
}

export async function requestAi(id: string, teacherId: string, answerVersion: string) {
  const task = await ownedTask(id, teacherId)
  const answer = await sourceAnswer(task)
  assertVersion(answer, answerVersion)
  ensureEditable(task, answerVersion)
  await requestTaskAi(task, answer, () => sourceAnswer(task))
  return await taskDetail(id, teacherId)
}

export async function requestRoundAi(url: string, teacherId: string): Promise<RoundAiResult> {
  const { readMode, round, platform, livePlatform, source } = await loadRoundSource(url, teacherId)
  const records = await prisma.task.findMany({
    where: { teacherId, ...round, examHistoryId: { in: source.rows.map(row => row.examHistoryId) } },
    include: includeSubmission,
  })
  const byHistory = new Map(records
    .filter(task => task.id.startsWith('live-') === (readMode === 'live'))
    .map(task => [task.examHistoryId, task]))
  const tasks: TaskSummary[] = []
  const results = { graded: 0, skipped: 0, failed: 0 }
  for (let index = 0; index < source.rows.length; index += roundConcurrency) {
    const batch = await Promise.all(source.rows.slice(index, index + roundConcurrency).map(async row => {
      let task = byHistory.get(row.examHistoryId)
      let answer: SourceAnswer | null = null
      try {
        if (livePlatform) {
          const current = await liveRoundTask(livePlatform, round, row.examHistoryId, teacherId)
          if (!current) return null
          task = current.task
          answer = current.answer
        } else if (task) {
          answer = await platform.readAnswer(task)
        }
        if (!task || !answer) return null
        if (!isEditable(task, answer.answerVersion)) {
          results.skipped++
          return summary(task, row.studentCode, row.correctStatusTitle, answer.answerVersion)
        }
        const currentTask = task
        const result = await requestTaskAi(currentTask, answer, () => readAnswer(currentTask, platform))
        results[result.generated ? 'graded' : 'skipped']++
        return summary(result.task, row.studentCode, row.correctStatusTitle, answer.answerVersion)
      } catch {
        results.failed++
        return task ? summary(task, row.studentCode, row.correctStatusTitle, answer?.answerVersion) : null
      }
    }))
    tasks.push(...batch.filter(task => task !== null))
  }
  return { round: { readMode, ...round, name: source.name, tasks }, results }
}

export async function saveDraft(id: string, teacherId: string, input: DraftInput) {
  const task = await ownedTask(id, teacherId)
  assertVersion(await sourceAnswer(task), input.answerVersion)
  ensureEditable(task, input.answerVersion)

  const draft = {
    ...input,
    revision: input.revision + 1,
    mean: SCORE_KEYS.reduce((total, key) => total + input.scores[key], 0) / SCORE_KEYS.length,
  }
  await prisma.$transaction(async tx => {
    const updated = await tx.task.updateMany({
      where: { id, teacherId, revision: input.revision, activeSubmissionId: task.activeSubmissionId },
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
        { state: { in: ['PENDING', 'FAILED'] } },
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
