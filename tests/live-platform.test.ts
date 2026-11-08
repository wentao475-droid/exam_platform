import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEMO_ROUND, demoCard, demoList, demoTasks, taskTwoUid } from '../server/lib/demo'
import { canUseLiveAccount, createLivePlatform, getReadMode, livePlatformFor, liveTaskId } from '../server/lib/live-platform'

const round = { examUid: DEMO_ROUND.examUid, examRoundUid: DEMO_ROUND.examRoundUid }
const teacherEmail = 'pilot@school.test'
const historyId = demoTasks[0]!.examHistoryId
const scope = {
  ...round,
  name: 'Local test only',
  teacherEmail,
  taskTwoQuestionUids: [taskTwoUid],
  examHistoryIds: [historyId],
}
const credentials = { token: 'fake-test-only', tokenType: 'e-n-p' }
const requestBase = 'https://portal.visioneschool.com/management/BizVisioncup/examQuery'
const json = (value: unknown) => Response.json(value)

afterEach(() => vi.unstubAllEnvs())

describe('live exam authorization', () => {
  it('defaults to demo and requires an allowlisted independently provisioned account', () => {
    vi.stubEnv('EXAM_READ_MODE', undefined)
    expect(getReadMode()).toBe('demo')
    vi.stubEnv('EXAM_READ_MODE', 'live')
    vi.stubEnv('EXAM_LIVE_ROUNDS', JSON.stringify([scope]))
    vi.stubEnv('EXAM_PLATFORM_V_TOKEN', credentials.token)
    expect(getReadMode()).toBe('live')
    expect(canUseLiveAccount('demo-teacher-1', teacherEmail)).toBe(false)
    expect(canUseLiveAccount('live-teacher-test', 'other@school.test')).toBe(false)
    expect(canUseLiveAccount('live-teacher-test', teacherEmail)).toBe(true)
    expect(() => livePlatformFor({ ...round, examRoundUid: 'ER42' }, teacherEmail))
      .toThrow('LIVE_ROUND_FORBIDDEN')
  })

  it('rejects malformed config and shared access grants', () => {
    vi.stubEnv('EXAM_LIVE_ROUNDS', JSON.stringify([scope, { ...scope, teacherEmail: 'other@school.test' }]))
    expect(canUseLiveAccount('live-teacher-test', teacherEmail)).toBe(false)
    expect(() => livePlatformFor(round, teacherEmail)).toThrow('LIVE_NOT_CONFIGURED')
  })
})

describe('live exam read protocol', () => {
  it('paginates the raw list, pseudonymizes Writing rows, and retrieves exact Task 2 text', async () => {
    const sample = demoList.data.data[0]!
    const writing = { ...sample, examRoundUid: round.examRoundUid }
    const nonWriting = Array.from({ length: 100 }, (_, i) => ({
      ...writing, examHistoryId: String(i), examSubject: '13',
    }))
    const card = demoCard(historyId)!
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ code: 'success', data: { totalCount: 101, data: nonWriting } }))
      .mockResolvedValueOnce(json({ code: 'success', data: { totalCount: 101, data: [writing] } }))
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json(card))
    const platform = createLivePlatform(scope, credentials, transport)

    const list = await platform.listWriting(round)
    expect(list?.rows).toHaveLength(1)
    expect(list?.rows[0]?.studentCode).toMatch(/^答卷 [0-9A-F]{12}$/)
    expect(list?.rows[0]?.studentCode).not.toBe(sample.studentCode)
    expect(transport.mock.calls.slice(0, 2).map(([url, init]) => ({
      url, method: init?.method, body: JSON.parse(String(init?.body)),
    }))).toEqual([1, 2].map(pageNumber => ({
      url: requestBase + '/pageExamHistoryInfo',
      method: 'POST',
      body: { pageNumber, pageSize: 100, examCategory: 4, examRounds: [round.examRoundUid] },
    })))
    const ref = await platform.identifyTask(round, historyId)
    expect(ref?.questionUid).toBe(taskTwoUid)
    expect(liveTaskId(ref!)).toMatch(/^live-[0-9a-f]{64}$/)
    const answer = await platform.readAnswer(ref!)
    expect(answer?.answerVersion).toMatch(/^live-[0-9a-f]{64}$/)
    expect(answer?.answerText).toBe(card.data.paperAnswerHistoryList[1]!.answerHistoryList[1]!.questionAnswerList[0])
    const [url, init] = transport.mock.calls[2]!
    expect(url).toBe(requestBase + '/exam/getExamVolQuizzesAndAnswerFile?examHistoryId=' + historyId)
    expect(init?.method).toBe('GET')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('v-token')).toBe(credentials.token)
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(await platform.identifyTask(round, demoTasks[1]!.examHistoryId)).toBeNull()
    expect(transport).toHaveBeenCalledTimes(4)
  })

  it('rejects rows from other rounds and surfaces sanitized authorization failures', async () => {
    const writing = { ...demoList.data.data[0], examRoundUid: 'ER42' }
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ code: 'success', data: { totalCount: 1, data: [writing] } }))
      .mockResolvedValueOnce(new Response('private provider response', { status: 401 }))
    const platform = createLivePlatform(scope, credentials, transport)
    await expect(platform.listWriting(round)).rejects.toMatchObject({
      statusCode: 502, data: { code: 'LIVE_UPSTREAM_UNAVAILABLE' },
    })
    await expect(platform.listWriting(round)).rejects.toMatchObject({
      statusCode: 502, data: { code: 'LIVE_UPSTREAM_AUTH' },
    })
  })

  it('simulates writeback locally and only calls upstream reads to check the answer hash', async () => {
    const card = demoCard(historyId)!
    const list = {
      code: 'success',
      data: { totalCount: 1, data: [{ ...demoList.data.data[0], examRoundUid: round.examRoundUid }] },
    }
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json(list))
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json(list))
    const platform = createLivePlatform(scope, credentials, transport)
    const ref = { ...round, examHistoryId: historyId, questionUid: taskTwoUid }
    const answer = await platform.readAnswer(ref)
    const result = {
      ...ref,
      answerVersion: answer!.answerVersion,
      idempotencyKey: 'fixed',
      scores: { tr: 6, cc: 6, lr: 6, gra: 6 },
      mean: 6,
      comment: 'Do not send this upstream',
    }
    expect(await platform.writeResult(result, 1)).toEqual({ state: 'SYNCED' })

    const changed = structuredClone(card)
    changed.data.paperAnswerHistoryList[1]!.answerHistoryList[1]!.questionAnswerList[0] += ' Changed.'
    transport.mockResolvedValueOnce(json(changed))
    expect(await platform.writeResult(result, 1)).toMatchObject({ state: 'CONFLICT' })
    for (const [url, init] of transport.mock.calls) {
      expect(String(url)).toMatch(/\/pageExamHistoryInfo$|\/getExamVolQuizzesAndAnswerFile\?examHistoryId=\d+$/)
      expect(String(init?.body ?? '')).not.toContain(result.comment)
    }
  })
})
