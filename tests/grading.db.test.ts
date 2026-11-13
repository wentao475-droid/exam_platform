import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { DEMO_ROUND_URL, type RoundAiEvent } from '../shared/grading'
import { demoTasks, demoVersion } from '../server/lib/demo'
import { openRound, requestAi, requestRoundAi, retry, saveDraft, submit, taskDetail } from '../server/lib/grading'
import { mockPlatform } from '../server/lib/mock-platform'
import { prisma } from '../server/lib/prisma'

const demo1 = demoTasks[0]!
const demo1Task1 = demoTasks[3]!
const demo2 = demoTasks[1]!
const demo2Task1 = demoTasks[4]!
const speaking = demoTasks[6]!
const teacher = demo1.teacherId
const input = {
  answerVersion: demoVersion,
  revision: 0,
  scores: { tr: 5.5, cc: 6, lr: 6.5, gra: 7 },
  comment: '教师评语',
}

describe.skipIf(process.env.GRADING_INTEGRATION !== '1')('grading lifecycle with a disposable PostgreSQL database', () => {
  beforeEach(async () => {
    // demo 链路必须在 demo 读模式 + mock AI 下运行，不受启动终端/`.env` 中
    // EXAM_READ_MODE=live 与 AI_PROVIDER=volcengine 的影响（vitest 会加载 `.env`）。
    vi.stubEnv('EXAM_READ_MODE', 'demo')
    vi.stubEnv('AI_PROVIDER', 'mock')
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
    vi.unstubAllEnvs()
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
    // 同一答卷派生 task2 + task1 两题，另有 speaking 一题，均归属 demo-teacher-1。
    expect(round.tasks.map(task => task.id)).toEqual([demo1.id, demo1Task1.id, demo2.id, demo2Task1.id, speaking.id])
    expect(round.tasks[0]).toMatchObject({ sourceStatus: '已批改', workStatus: 'PENDING' })
    await expect(taskDetail(demo1.id, demoTasks[2]!.teacherId)).rejects.toMatchObject({ statusCode: 404 })
    await expect(saveDraft(demo1.id, demoTasks[2]!.teacherId, input)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('grades the full owned round, keeps intentional empty comments, and retries only unfinished reviews', async () => {
    await saveDraft(demo1.id, teacher, { ...input, comment: '' })
    const updates: RoundAiEvent[] = []
    const first = await requestRoundAi(DEMO_ROUND_URL, teacher, event => { updates.push(event) })
    for (const [id, aiStatus] of [[demo1.id, 'GRADED'], [demo2.id, 'NOT_GRADED']]) {
      expect(updates.filter(event => event.type === 'grading' ? event.id === id : event.type === 'task' && event.task.id === id))
        .toEqual([{ type: 'grading', id }, { type: 'task', task: expect.objectContaining({ id, aiStatus }) }])
    }
    // 880001 的 task2+task1 与 speaking 各批改成功；880002 两条按演示设定失败（按行计 1 次）。
    expect(first.results).toEqual({ graded: 3, skipped: 0, failed: 1 })
    expect(Object.fromEntries(first.round.tasks.map(task => [task.id, task.aiStatus]))).toEqual({
      [demo1.id]: 'GRADED',
      [demo1Task1.id]: 'GRADED',
      [demo2.id]: 'NOT_GRADED',
      [demo2Task1.id]: 'NOT_GRADED',
      [speaking.id]: 'GRADED',
    })
    const detail = await taskDetail(demo1.id, teacher)
    expect(detail.ai?.teacherComment).toContain('【任务回应】')
    expect(detail.draft).toMatchObject({ revision: 1, comment: '', scores: input.scores })
    expect(detail.confirmation).toBeNull()
    expect((await taskDetail(demoTasks[2]!.id, demoTasks[2]!.teacherId)).ai).toBeNull()

    updates.length = 0
    const repeated = await requestRoundAi(DEMO_ROUND_URL, teacher, event => { updates.push(event) })
    expect(updates.filter(event => event.type === 'grading').map(event => event.id).sort())
      .toEqual([demo2.id, demo2Task1.id].sort())
    // 重复执行：已同版本批改过的 3 题（880001 两条 + speaking）跳过，880002 再次失败。
    expect(repeated.results).toEqual({ graded: 0, skipped: 3, failed: 1 })
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
    // 并发去重后：880001 两条与 speaking 各成功一次；已确认的 demo2 两次都跳过；
    // 未确认的 demo2-task1 按演示设定失败两次（并发去重仍各计一次失败）。
    expect(one.results.graded + two.results.graded).toBe(3)
    expect(one.results.skipped + two.results.skipped).toBe(5)
    expect(one.results.failed + two.results.failed).toBe(2)
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
    expect(fresh.draft?.mean).toBe(6.5)
    expect(fresh.draft?.revision).toBe(1)
    expect(fresh.ai).toEqual(ai.ai)
  })

  it('regenerates a same-version review when requested, even if the cached review has no annotations', async () => {
    const initial = await requestAi(demo1.id, teacher, demoVersion)
    await prisma.task.update({
      where: { id: demo1.id },
      data: { ai: { ...initial.ai, annotations: [] } as Prisma.InputJsonValue },
    })
    const cached = await requestAi(demo1.id, teacher, demoVersion)
    expect(cached.ai?.annotations).toEqual([])

    const regenerated = await requestAi(demo1.id, teacher, demoVersion, true)
    expect(regenerated.ai?.promptVersion).toBe(initial.ai?.promptVersion)
    expect(regenerated.ai?.annotations[0]?.range).toBeTruthy()
    expect(await prisma.audit.count({ where: { taskId: demo1.id, action: 'AI_REVIEW' } })).toBe(2)
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
    // 已是 SYNCED 也允许重新回写（补齐早期缺失的总分/评语），不产生重复回执。
    const replay = await retry(demo2.id, teacher)
    expect(replay.syncStatus).toBe('SYNCED')
    expect(replay.confirmation?.syncAttempts).toBe(3)
    expect(await prisma.mockReceipt.count({ where: { examHistoryId: demo2.examHistoryId } })).toBe(1)
  })

  it('grades the speaking answer on four dimensions and writes the structured comment back', async () => {
    const ai = await requestAi(speaking.id, teacher, demoVersion)
    expect(ai.ai?.scores).toEqual({ fc: 5.5, lr: 6, gra: 5.5, p: 5 })
    expect(ai.ai?.teacherComment).toContain('【流利与连贯】')

    const draft = await saveDraft(speaking.id, teacher, {
      answerVersion: demoVersion,
      revision: 0,
      scores: { fc: 6, lr: 5.5, gra: 6, p: 5.5 },
      comment: '【流利与连贯】整体连贯。\n【词汇资源】……',
    })
    // roundBandMean((6 + 5.5 + 6 + 5.5) / 4) = 6
    expect(draft.draft?.mean).toBe(6)

    const detail = await submit(speaking.id, teacher, { answerVersion: demoVersion, revision: draft.revision })
    expect(detail.syncStatus).toBe('SYNCED')
    expect(detail.confirmation).toMatchObject({
      scores: { fc: 6, lr: 5.5, gra: 6, p: 5.5 },
      mean: 6,
      comment: expect.stringContaining('【流利与连贯】'),
    })
    expect(await prisma.mockReceipt.count({ where: { examHistoryId: speaking.examHistoryId } })).toBe(1)
  })

  it('grades the task 1 chart answer on its own dimensions and writes task1Score back', async () => {
    const ai = await requestAi(demo1Task1.id, teacher, demoVersion)
    expect(ai.ai?.scores).toEqual({ ta: 5, cc: 5.5, lr: 6, gra: 6 })
    expect(ai.ai?.teacherComment).toContain('【任务达成】')

    const draft = await saveDraft(demo1Task1.id, teacher, {
      answerVersion: demoVersion,
      revision: 0,
      scores: { ta: 6, cc: 5.5, lr: 6, gra: 6 },
      comment: '【任务达成】概述清楚，数据对比可以更充分。',
    })
    // roundBandMean((6 + 5.5 + 6 + 6) / 4) = 6
    expect(draft.draft?.mean).toBe(6)

    const detail = await submit(demo1Task1.id, teacher, { answerVersion: demoVersion, revision: draft.revision })
    expect(detail.syncStatus).toBe('SYNCED')
    const receipt = await prisma.mockReceipt.findFirstOrThrow({
      where: { examHistoryId: demo1Task1.examHistoryId, questionUid: demo1Task1.questionUid },
    })
    expect(receipt.scores).toMatchObject({ ta: 6, cc: 5.5, lr: 6, gra: 6 })
    expect(receipt.mean).toBe(6)
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

  it('saves drafts purely locally and checks the upstream version only on confirm', async () => {
    // 'demo-answer-v2' 不存在于 mockAnswerVersion 表 —— 草稿保存成功证明该操作不再读上游
    const draft = await saveDraft(demo1.id, teacher, { ...input, answerVersion: 'demo-answer-v2' })
    expect(draft.draft?.answerVersion).toBe('demo-answer-v2')
    // 版本核对发生在确认提交：上游仍是 v1，v2 草稿提交被拒
    await expect(submit(demo1.id, teacher, { answerVersion: 'demo-answer-v2', revision: draft.revision }))
      .rejects.toMatchObject({ statusCode: 409 })
    // 陈旧草稿保留在本地，前端以 staleDraft 提示教师重新复核
    const fresh = await taskDetail(demo1.id, teacher)
    expect(fresh.draft?.answerVersion).toBe('demo-answer-v2')
    expect(fresh.answerVersion).toBe(demoVersion)
  })
})
