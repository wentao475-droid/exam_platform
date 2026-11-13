import { afterEach, describe, expect, it, vi } from 'vitest'
import { roundBandMean } from '../shared/grading'
import { DEMO_ROUND, demoCard, demoList, demoSpeakingUid, demoTasks, taskOneUid, taskTwoUid } from '../server/lib/demo'
import { canUseLiveAccount, createLivePlatform, getReadMode, listLiveRoundsFor, livePlatformFor, liveTaskId } from '../server/lib/live-platform'
import { parseRoundUrl } from '../server/lib/source'

const round = { examUid: DEMO_ROUND.examUid, examRoundUid: DEMO_ROUND.examRoundUid }
const teacherEmail = 'pilot@school.test'
const historyId = demoTasks[0]!.examHistoryId
const scope = {
  ...round,
  name: 'Local test only',
  teacherEmail,
  taskTwoQuestionUids: [taskTwoUid],
  taskOneQuestionUids: [],
  speakingQuestionUids: [],
  examHistoryIds: [historyId],
}
const credentials = { token: 'fake-test-only', tokenType: 'e-n-p' }
const requestBase = 'https://portal.visioneschool.com/management/BizVisioncup/examQuery'
const json = (value: unknown) => Response.json(value)

describe('live exam authorization', () => {
  afterEach(() => vi.unstubAllEnvs())
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

  it('lists only the current teacher’s authorized rounds with links accepted by the loader', () => {
    const sourceUrl = 'https://portal.visioneschool.com/study-teach-product-admin/#/examPlatform/roundConfigExamSituation?'
      + new URLSearchParams({ examUid: round.examUid, examRoundUid: 'ER42', examCategory: '4', roundNoStr: 'Round2' })
    const secondRound = { ...scope, examRoundUid: 'ER42', name: 'Second test round', sourceUrl, taskTwoQuestionUids: [] }
    vi.stubEnv('EXAM_LIVE_ROUNDS', JSON.stringify([
      scope,
      secondRound,
      { ...scope, examRoundUid: 'ER43', teacherEmail: 'other@school.test' },
    ]))

    const options = listLiveRoundsFor(teacherEmail)
    expect(options.map(({ url }) => parseRoundUrl(url))).toEqual([round, { ...round, examRoundUid: 'ER42' }])
    expect(options).toEqual([
      { examRoundUid: scope.examRoundUid, name: scope.name, url: expect.any(String) },
      { examRoundUid: secondRound.examRoundUid, name: secondRound.name, url: sourceUrl },
    ])
    vi.stubEnv('EXAM_LIVE_ROUNDS', JSON.stringify([{ ...secondRound, examRoundUid: 'ER99' }]))
    expect(() => listLiveRoundsFor(teacherEmail)).toThrow('LIVE_NOT_CONFIGURED')
  })

  it('discovers missing writing tasks alongside configured question IDs', async () => {
    const autoScope = { ...scope, autoDetectTasks: true, taskTwoQuestionUids: ['q-task2'] }
    const card = {
      code: 'success',
      data: {
        examHistoryId: Number(historyId),
        paperAnswerHistoryList: [
          { examSubject: 14, examVolSubId: '42014', answerHistoryList: [
            { questionUid: 'q-task1', questionAnswerList: ['The chart shows the trend.'] },
            { questionUid: 'q-task2', questionAnswerList: ['Some people argue that…'] },
          ] },
        ],
        volQuizzesDTOList: [{ examVolSubId: '42014', answerQuizs: [
          { uid: 'q-task1', htmlContent: '<p>Write at least 150&nbsp;words.</p>' },
          { uid: 'q-task2', htmlContent: '<p>Give reasons and examples.</p>' },
        ] }],
      },
    }
    // Response.body 只能读一次：mock 必须每次调用都新建 Response。
    const transport = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json(card)))
    const platform = createLivePlatform(autoScope, credentials, transport)

    const row = { ...demoList.data.data[0]!, examHistoryId: historyId, examSubject: '14' }
    const existing = [{ questionUid: 'q-task2', kind: 'task2' }]
    expect(platform.canReuseListTasks(row, existing)).toBe(false)
    const matches = await platform.identifyTasks(round, historyId, row)
    expect(matches.map(({ ref }) => [ref.questionUid, ref.kind]))
      .toEqual([['q-task1', 'task1'], ['q-task2', 'task2']])
    expect(platform.canReuseListTasks(row, existing)).toBe(false)
    expect(platform.canReuseListTasks(row, matches.map(({ ref }) => ref))).toBe(true)
    const answer = await platform.readAnswer(matches[1]!.ref)
    expect(answer?.answerText).toBe('Some people argue that…')
    expect(await platform.readAnswer({ ...matches[0]!.ref, questionUid: 'q-unknown' })).toBeNull()
    expect(await platform.identifyTasks(round, demoTasks[1]!.examHistoryId)).toEqual([])
  })

  it('keeps a speaking-only card auto-detected as one whole speaking task', async () => {
    const autoScope = { ...scope, taskTwoQuestionUids: [], examHistoryIds: ['880099'] }
    const card = demoCard('880099')!
    const transport = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json(card)))
    const platform = createLivePlatform(autoScope, credentials, transport)

    const matches = await platform.identifyTasks(round, '880099')
    expect(matches.map(({ ref }) => [ref.questionUid, ref.kind]))
      .toEqual([[demoSpeakingUid, 'speaking']])
    expect(matches[0]!.answer.answerText).toContain('回答转写')
  })
})

describe('live exam read protocol', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('paginates the raw list, pseudonymizes Writing rows, and retrieves exact Task 2 text', async () => {
    const sample = demoList.data.data[0]!
    const identity = { studentName: '测试学生', customerCode: '000123' }
    const writing = { ...sample, ...identity, examRoundUid: round.examRoundUid }
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
    expect(list?.rows[0]).toMatchObject(identity)
    expect(list?.rows[0]?.studentCode).toMatch(/^答卷 [0-9A-F]{12}$/)
    expect(list?.rows[0]?.studentCode).not.toBe(sample.studentCode)
    expect(transport.mock.calls.slice(0, 2).map(([url, init]) => ({
      url, method: init?.method, body: JSON.parse(String(init?.body)),
    }))).toEqual([1, 2].map(pageNumber => ({
      url: requestBase + '/pageExamHistoryInfo',
      method: 'POST',
      body: { pageNumber, pageSize: 100, examCategory: 4, examRounds: [round.examRoundUid] },
    })))
    const matches = await platform.identifyTasks(round, historyId)
    expect(matches.map(({ ref }) => ref.questionUid)).toEqual([taskTwoUid])
    const ref = matches[0]!.ref
    expect(liveTaskId(ref)).toMatch(/^live-[0-9a-f]{64}$/)
    const answer = await platform.readAnswer(ref)
    expect(answer?.answerVersion).toMatch(/^live-[0-9a-f]{64}$/)
    expect(answer?.answerText).toBe(card.data.paperAnswerHistoryList[1]!.answerHistoryList[1]!.questionAnswerList[0])
    const [url, init] = transport.mock.calls[2]!
    expect(url).toBe(requestBase + '/exam/getExamVolQuizzesAndAnswerFile?examHistoryId=' + historyId)
    expect(init?.method).toBe('GET')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('v-token')).toBe(credentials.token)
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(await platform.identifyTasks(round, demoTasks[1]!.examHistoryId)).toEqual([])
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

  it('lists authorized speaking rounds with more than 300 candidates', async () => {
    const rows = Array.from({ length: 377 }, (_, index) => ({
      ...demoList.data.data[0]!,
      examHistoryId: String(index + 1),
      examSubject: '13',
      examRoundUid: round.examRoundUid,
    }))
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const { pageNumber, pageSize } = JSON.parse(String(init?.body))
      return json({ code: 'success', data: {
        totalCount: rows.length,
        data: rows.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
      } })
    })
    const platform = createLivePlatform({ ...scope, autoDetectTasks: true, examHistoryIds: undefined }, credentials, transport)

    expect((await platform.listWriting(round))?.rows).toHaveLength(377)
    expect(transport).toHaveBeenCalledTimes(4)
  })

  it('briefly reuses empty card checks only for the same round-list scope and status', async () => {
    const card = demoCard(historyId)!
    const emptyCard = structuredClone(card)
    emptyCard.data.paperAnswerHistoryList[1]!.answerHistoryList[1]!.questionAnswerList = []
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(emptyCard))
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json(card))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const listingScope = { ...scope, teacherEmail: 'listing@example.test' }
    try {
      const platform = createLivePlatform(listingScope, credentials, transport)
      const row = { ...demoList.data.data[0]!, examHistoryId: historyId, correctStatusTitle: '未批改' }
      expect(await platform.identifyTasks(round, historyId, row)).toEqual([])
      const next = createLivePlatform(listingScope, credentials, transport)
      expect(next.canReuseListTasks(row, [])).toBe(true)
      expect(transport).toHaveBeenCalledTimes(1)

      expect(await next.identifyTasks(round, historyId)).toHaveLength(1)
      expect(next.canReuseListTasks({ ...row, correctStatusTitle: '已批改' }, [])).toBe(false)
      const otherTeacher = createLivePlatform(scope, credentials, transport)
      expect(otherTeacher.canReuseListTasks(row, [])).toBe(false)

      clock.mockReturnValue(121_001)
      expect(next.canReuseListTasks(row, [])).toBe(false)
      expect(await next.identifyTasks(round, historyId, row)).toHaveLength(1)
      expect(transport).toHaveBeenCalledTimes(3)
    } finally {
      clock.mockRestore()
    }
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
      kind: 'task2',
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

describe('live exam writeback', () => {
  afterEach(() => vi.unstubAllEnvs())
  const writeUrl = 'https://portal.visioneschool.com/management/BizVisioncup/v1/api/visioncup/exam/manualCorrect'
  const ref = { ...round, examHistoryId: historyId, questionUid: taskTwoUid }

  const validCard = () => {
    const card = demoCard(historyId)!
    const writing = card.data.paperAnswerHistoryList[1] as Record<string, unknown>
    writing.examHistoryPaperId = 880123
    writing.task1Score = '4.5'
    return card
  }

  // 真实回写在提交前会用答题卡重新计算答案哈希并核对，因此先用 readAnswer 取得真实版本。
  async function submitWith(transport: ReturnType<typeof vi.fn<typeof fetch>>, overrides: Record<string, unknown> = {}) {
    const platform = createLivePlatform(scope, credentials, transport)
    const answer = await platform.readAnswer(ref)
    expect(answer).not.toBeNull()
    return await platform.writeResult({
      ...ref,
      answerVersion: answer!.answerVersion,
      idempotencyKey: 'fixed',
      kind: 'task2',
      scores: { tr: 6, cc: 6, lr: 6, gra: 6 },
      mean: 6,
      comment: 'Well argued overall.',
      ...overrides,
    }, 1)
  }

  it('sends manualCorrect with the writing volume updated and other volumes echoed', async () => {
    vi.stubEnv('EXAM_LIVE_WRITE', '1')
    const card = validCard()
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json({ code: 'success', data: null }))

    expect(await submitWith(transport)).toEqual({ state: 'SYNCED' })
    const [url, init] = transport.mock.calls[2]!
    expect(url).toBe(writeUrl)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('v-token')).toBe(credentials.token)
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({
      examHistoryId: Number(historyId),
      scoreLevel: String(roundBandMean((4.5 + 6) / 2).toFixed(1)),
      comment: 'Well argued overall.',
      volList: [
        { examHistoryPaperId: null, examVolSubId: '42011', scoreLevel: '', task1Score: '', task2Score: '', examManualCorrectQuizDTOList: [] },
        {
          examHistoryPaperId: 880123,
          examVolSubId: '42014',
          scoreLevel: String(roundBandMean((4.5 + 6) / 2)),
          task1Score: '4.5',
          task2Score: '6',
          examManualCorrectQuizDTOList: [{ questionUid: taskTwoUid, correctContent: 'Well argued overall.' }],
        },
      ],
    })
  })

  it('writes the speaking band as volume and total score and echoes other scores', async () => {
    vi.stubEnv('EXAM_LIVE_WRITE', '1')
    // 口语卷项目分（分卷 scoreLevel）= 整场四维均分；task1Score/task2Score 保持原值。
    const speakingScope = {
      ...scope,
      taskTwoQuestionUids: [],
      speakingQuestionUids: [demoSpeakingUid],
      examHistoryIds: ['880099'],
    }
    const speakingRef = { ...round, examHistoryId: '880099', questionUid: demoSpeakingUid }
    const card = demoCard('880099')!
    // 同一答卷含口语与写作两个可阅卷分卷：总分语义未验证，按答题卡原值回传。
    ;(card.data as Record<string, unknown>).scoreLevel = '5.0'
    const speaking = card.data.paperAnswerHistoryList[0] as Record<string, unknown>
    speaking.examHistoryPaperId = 880456
    speaking.scoreLevel = '5.5'
    // 写作分卷仅用于验证非目标分卷按原值回传且不带批改列表。
    card.data.paperAnswerHistoryList.push({
      examSubject: 14,
      examVolSubId: 42014,
      examHistoryPaperId: 880123,
      scoreLevel: '5',
      task1Score: '4.5',
      task2Score: null,
      answerHistoryList: [],
    })
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json({ code: 'success', data: null }))
    const platform = createLivePlatform(speakingScope, credentials, transport)
    const answer = await platform.readAnswer(speakingRef)
    expect(answer).not.toBeNull()

    const outcome = await platform.writeResult({
      ...speakingRef,
      answerVersion: answer!.answerVersion,
      idempotencyKey: 'fixed-spk',
      kind: 'speaking',
      scores: { fc: 6, lr: 5.5, gra: 6, p: 5.5 },
      mean: 6,
      comment: '【流利与连贯】整体连贯。\n【词汇资源】……',
    }, 1)
    expect(outcome).toEqual({ state: 'SYNCED' })

    const [url, init] = transport.mock.calls[2]!
    expect(url).toBe(writeUrl)
    expect(JSON.parse(String(init?.body))).toEqual({
      examHistoryId: 880099,
      scoreLevel: '5.0',
      comment: '【流利与连贯】整体连贯。\n【词汇资源】……',
      volList: [
        {
          examHistoryPaperId: 880456,
          examVolSubId: '42013',
          scoreLevel: '6',
          task1Score: '',
          task2Score: '',
          examManualCorrectQuizDTOList: [{ questionUid: demoSpeakingUid, correctContent: '【流利与连贯】整体连贯。\n【词汇资源】……' }],
        },
        {
          examHistoryPaperId: 880123,
          examVolSubId: '42014',
          scoreLevel: '5',
          task1Score: '4.5',
          task2Score: '',
          examManualCorrectQuizDTOList: [],
        },
      ],
    })
  })

  it('fails safely when the card lacks the speaking paper id', async () => {
    vi.stubEnv('EXAM_LIVE_WRITE', '1')
    const speakingScope = {
      ...scope,
      taskTwoQuestionUids: [],
      speakingQuestionUids: [demoSpeakingUid],
      examHistoryIds: ['880099'],
    }
    const speakingRef = { ...round, examHistoryId: '880099', questionUid: demoSpeakingUid }
    const card = demoCard('880099')!
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json(card))
    const platform = createLivePlatform(speakingScope, credentials, transport)
    const answer = await platform.readAnswer(speakingRef)
    expect(answer).not.toBeNull()

    const outcome = await platform.writeResult({
      ...speakingRef,
      answerVersion: answer!.answerVersion,
      idempotencyKey: 'fixed-spk',
      kind: 'speaking',
      scores: { fc: 6, lr: 5.5, gra: 6, p: 5.5 },
      mean: 6,
      comment: '评语',
    }, 1)
    expect(outcome).toMatchObject({
      state: 'FAILED',
      message: expect.stringContaining('口语分卷的 examHistoryPaperId'),
    })
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls.every(([url]) => String(url) !== writeUrl)).toBe(true)
  })

  it('sends manualCorrect with the task 1 score updated and task 2 score echoed', async () => {
    vi.stubEnv('EXAM_LIVE_WRITE', '1')
    const task1Scope = {
      ...scope,
      taskTwoQuestionUids: [],
      taskOneQuestionUids: [taskOneUid],
      examHistoryIds: [historyId],
    }
    const task1Ref = { ...round, examHistoryId: historyId, questionUid: taskOneUid }
    const card = validCard()
    // 预置 task2 原分，验证 task1 回写后 scoreLevel 为两题均值取整、task2 原值回传。
    ;(card.data.paperAnswerHistoryList[1] as Record<string, unknown>).task2Score = '5.5'
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json({ code: 'success', data: null }))
    const platform = createLivePlatform(task1Scope, credentials, transport)
    const answer = await platform.readAnswer(task1Ref)
    expect(answer).not.toBeNull()

    const outcome = await platform.writeResult({
      ...task1Ref,
      answerVersion: answer!.answerVersion,
      idempotencyKey: 'fixed-t1',
      kind: 'task1',
      scores: { ta: 6, cc: 6, lr: 5.5, gra: 6 },
      mean: 6,
      comment: '概述覆盖主要特征。',
    }, 1)
    expect(outcome).toEqual({ state: 'SYNCED' })

    expect(JSON.parse(String(transport.mock.calls[2]![1]?.body))).toEqual({
      examHistoryId: Number(historyId),
      scoreLevel: roundBandMean((5.5 + 6) / 2).toFixed(1),
      comment: '概述覆盖主要特征。',
      volList: [
        { examHistoryPaperId: null, examVolSubId: '42011', scoreLevel: '', task1Score: '', task2Score: '', examManualCorrectQuizDTOList: [] },
        {
          examHistoryPaperId: 880123,
          examVolSubId: '42014',
          scoreLevel: String(roundBandMean((5.5 + 6) / 2)),
          task1Score: '6',
          task2Score: '5.5',
          examManualCorrectQuizDTOList: [{ questionUid: taskOneUid, correctContent: '概述覆盖主要特征。' }],
        },
      ],
    })
  })

  it('reports a conflict without writing when the upstream answer changed', async () => {
    vi.stubEnv('EXAM_LIVE_WRITE', '1')
    const changed = demoCard(historyId)!
    ;(changed.data.paperAnswerHistoryList[1]!.answerHistoryList[1]!.questionAnswerList[0] as string) += ' Changed.'
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(validCard()))
      .mockResolvedValueOnce(json(changed))

    const outcome = await submitWith(transport)
    expect(outcome).toMatchObject({ state: 'CONFLICT' })
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls.every(([url]) => String(url) !== writeUrl)).toBe(true)
  })

  it('fails safely when the card lacks the writing paper id', async () => {
    vi.stubEnv('EXAM_LIVE_WRITE', '1')
    const bare = demoCard(historyId)!
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(bare))
      .mockResolvedValueOnce(json(bare))

    expect(await submitWith(transport))
      .toMatchObject({ state: 'FAILED', message: expect.stringContaining('examHistoryPaperId') })
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls.every(([url]) => String(url) !== writeUrl)).toBe(true)
  })

  it('maps upstream write rejections to FAILED with the platform reason', async () => {
    vi.stubEnv('EXAM_LIVE_WRITE', '1')
    const card = validCard()
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json({ code: 'fail', msg: '答卷已锁定' }))
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))

    expect(await submitWith(transport))
      .toMatchObject({ state: 'FAILED', message: expect.stringContaining('答卷已锁定') })
    expect(await submitWith(transport))
      .toMatchObject({ state: 'FAILED', message: expect.stringContaining('500') })
  })
})
