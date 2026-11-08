import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { DEMO_ROUND_URL } from '../shared/grading'
import { demoTasks, demoVersion } from '../server/lib/demo'
import { openRound, requestAi, requestRoundAi, retry, saveDraft, submit, taskDetail } from '../server/lib/grading'
import { mockPlatform } from '../server/lib/mock-platform'
import { prisma } from '../server/lib/prisma'

const demo1 = demoTasks[0]!
const demo2 = demoTasks[1]!
const teacher = demo1.teacherId
const input = {
  answerVersion: demoVersion,
  revision: 0,
  scores: { tr: 5.5, cc: 6, lr: 6.5, gra: 7 },
  comment: '教师评语',
}

describe.skipIf(process.env.GRADING_INTEGRATION !== '1')('grading lifecycle with a disposable PostgreSQL database', () => {
  beforeEach(async () => {
    // Explicit opt-in and a separate database name protect the interactive demo from this reset.
    const database = new URL(process.env.DATABASE_URL ?? '').pathname
    if (database !== '/grading_test') throw new Error('Use the seeded grading_test database')
    const tasks = demoTasks.map(task => task.id)
    const histories = demoTasks.map(task => task.examHistoryId)
    await prisma.$transaction([
      prisma.task.updateMany({
        where: { id: { in: tasks } },
        data: { revision: 0, draft: Prisma.DbNull, ai: Prisma.DbNull, activeSubmissionId: null },
      }),
      prisma.audit.deleteMany({ where: { taskId: { in: tasks } } }),
      prisma.submission.deleteMany({ where: { taskId: { in: tasks } } }),
      prisma.mockReceipt.deleteMany({ where: { examHistoryId: { in: histories } } }),
      prisma.mockAnswerVersion.updateMany({ where: { examHistoryId: { in: histories } }, data: { version: demoVersion } }),
    ])
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('provides a way back to the example round for an unknown or malformed link', async () => {
    const unknownRoundUrl = DEMO_ROUND_URL + '0'
    const malformedRoundUrl = DEMO_ROUND_URL.replace('&', '\\&')

    await expect(openRound(unknownRoundUrl, teacher)).rejects.toMatchObject({
      statusCode: 404,
      data: { message: expect.stringContaining('打开示例轮次') },
    })
    await expect(openRound(malformedRoundUrl, teacher)).rejects.toMatchObject({
      statusCode: 400,
      data: { message: expect.stringContaining('完整的原考试平台') },
    })
  })

  it('filters candidates by ownership and keeps the original status separate', async () => {
    const round = await openRound(DEMO_ROUND_URL, teacher)
    expect(round.tasks.map(task => task.id)).toEqual([demo1.id, demo2.id])
    expect(round.tasks[0]).toMatchObject({ sourceStatus: '已批改', workStatus: 'PENDING' })
    await expect(taskDetail(demo1.id, demoTasks[2]!.teacherId)).rejects.toMatchObject({ statusCode: 404 })
    await expect(saveDraft(demo1.id, demoTasks[2]!.teacherId, input)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('grades the full owned round, keeps intentional empty comments, and retries only unfinished reviews', async () => {
    await saveDraft(demo1.id, teacher, { ...input, comment: '' })
    const first = await requestRoundAi(DEMO_ROUND_URL, teacher)
    expect(first.results).toEqual({ graded: 1, skipped: 0, failed: 1 })
    expect(first.round.tasks.map(task => [task.id, task.aiStatus])).toEqual([
      [demo1.id, 'GRADED'],
      [demo2.id, 'NOT_GRADED'],
    ])
    const detail = await taskDetail(demo1.id, teacher)
    expect(detail.ai?.teacherComment).toContain('模拟 AI 评语')
    expect(detail.draft).toMatchObject({ revision: 1, comment: '', scores: input.scores })
    expect(detail.confirmation).toBeNull()
    expect((await taskDetail(demoTasks[2]!.id, demoTasks[2]!.teacherId)).ai).toBeNull()

    const repeated = await requestRoundAi(DEMO_ROUND_URL, teacher)
    expect(repeated.results).toEqual({ graded: 0, skipped: 1, failed: 1 })
    expect(await prisma.audit.count({ where: { taskId: demo1.id, action: 'AI_REVIEW' } })).toBe(1)
    expect(await prisma.audit.count({ where: { taskId: demo2.id, action: 'AI_REVIEW' } })).toBe(2)
  })

  it('does not regenerate confirmed work or duplicate a same-version review on overlapping runs', async () => {
    const draft = await saveDraft(demo2.id, teacher, input)
    await submit(demo2.id, teacher, { answerVersion: demoVersion, revision: draft.revision })
    const [one, two] = await Promise.all([
      requestRoundAi(DEMO_ROUND_URL, teacher),
      requestRoundAi(DEMO_ROUND_URL, teacher),
    ])
    expect(one.results.graded + two.results.graded).toBe(1)
    expect(one.results.skipped + two.results.skipped).toBe(3)
    expect(one.results.failed + two.results.failed).toBe(0)
    expect(await prisma.audit.count({ where: { taskId: demo1.id, action: 'AI_REVIEW' } })).toBe(1)
    expect(await prisma.audit.count({ where: { taskId: demo2.id, action: 'AI_REVIEW' } })).toBe(0)
  })

  it('rejects stale drafts while persisting teacher scores separately from AI', async () => {
    const ai = await requestAi(demo1.id, teacher, demoVersion)
    const saves = await Promise.allSettled([
      saveDraft(demo1.id, teacher, input),
      saveDraft(demo1.id, teacher, { ...input, comment: '并发草稿' }),
    ])
    expect(saves.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(saves.find(result => result.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } })
    const fresh = await taskDetail(demo1.id, teacher)
    expect(fresh.draft?.mean).toBe(6.25)
    expect(fresh.draft?.revision).toBe(1)
    expect(fresh.ai).toEqual(ai.ai)
  })

  it('permits manual grading on AI failure and sends one immutable snapshot on retry', async () => {
    await expect(requestAi(demo2.id, teacher, demoVersion)).rejects.toMatchObject({ statusCode: 502 })
    const draft = await saveDraft(demo2.id, teacher, input)
    const confirmation = { answerVersion: draft.answerVersion, revision: draft.revision }
    const [first, duplicate] = await Promise.all([
      submit(demo2.id, teacher, confirmation),
      submit(demo2.id, teacher, confirmation),
    ])
    expect([first.syncStatus, duplicate.syncStatus]).toContain('FAILED')
    expect(await prisma.submission.count({ where: { taskId: demo2.id } })).toBe(1)
    expect(await prisma.mockReceipt.count({ where: { examHistoryId: demo2.examHistoryId } })).toBe(0)
    await expect(saveDraft(demo2.id, teacher, { ...input, revision: first.revision })).rejects.toMatchObject({ statusCode: 409 })
    await Promise.all([retry(demo2.id, teacher), retry(demo2.id, teacher)])
    const fresh = await taskDetail(demo2.id, teacher)
    expect(fresh.syncStatus).toBe('SYNCED')
    expect(fresh.confirmation).toMatchObject({ syncAttempts: 2, scores: input.scores, comment: input.comment })
    expect(await prisma.mockReceipt.count({ where: { examHistoryId: demo2.examHistoryId } })).toBe(1)
  })

  it('replays an acknowledged write after an expired local lease without a second receipt', async () => {
    const draft = await saveDraft(demo1.id, teacher, input)
    expect((await submit(demo1.id, teacher, { answerVersion: demoVersion, revision: draft.revision })).syncStatus).toBe('SYNCED')
    const submission = await prisma.submission.findFirstOrThrow({ where: { taskId: demo1.id } })
    await prisma.submission.update({
      where: { id: submission.id },
      data: { state: 'SYNCING', leaseUntil: new Date(0) },
    })
    expect((await taskDetail(demo1.id, teacher)).syncStatus).toBe('FAILED')
    const replay = await retry(demo1.id, teacher)
    expect(replay.syncStatus).toBe('SYNCED')
    expect(replay.confirmation?.syncAttempts).toBe(2)
    expect(await prisma.mockReceipt.count({ where: { examHistoryId: demo1.examHistoryId } })).toBe(1)
  })

  it('retains a stale confirmation for audit and lets the teacher review the new version', async () => {
    const draft = await saveDraft(demo1.id, teacher, input)
    const writeResult = mockPlatform.writeResult
    const newVersion = 'demo-answer-v2'
    const override = vi.spyOn(mockPlatform, 'writeResult').mockImplementationOnce(async (...args) => {
      await prisma.mockAnswerVersion.update({
        where: { examHistoryId: demo1.examHistoryId },
        data: { version: newVersion },
      })
      return await writeResult(...args)
    })
    try {
      const changed = await submit(demo1.id, teacher, { answerVersion: demoVersion, revision: draft.revision })
      expect(changed).toMatchObject({ syncStatus: 'CONFLICT', answerVersion: newVersion })
      expect(changed.confirmation?.answerVersion).toBe(demoVersion)
      const refreshed = await saveDraft(demo1.id, teacher, { ...input, answerVersion: newVersion, revision: changed.revision })
      expect(refreshed).toMatchObject({ workStatus: 'DRAFT', confirmation: null })
      const complete = await submit(demo1.id, teacher, { answerVersion: newVersion, revision: refreshed.revision })
      expect(complete.syncStatus).toBe('SYNCED')
      expect(await prisma.submission.count({ where: { taskId: demo1.id } })).toBe(2)
    } finally {
      override.mockRestore()
    }
  })
})
