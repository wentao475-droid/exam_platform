import { describe, expect, it } from 'vitest'
import { DEMO_ROUND_URL, meanOf, reviewStageOf, roundBandMean, scoreKeysFor, type TaskSummary } from '../shared/grading'
import { locateAnnotation, normalizeAi, mockAi, promptVersion, RUBRICS } from '../server/lib/ai'
import { DEMO_ROUND, demoCard, demoList, demoSpeakingUid, demoTasks, taskOneUid, taskTwoUid } from '../server/lib/demo'
import { normalizeAnswer, normalizeList, parseRoundUrl } from '../server/lib/source'
import { scoresSchema, scoresSchemaFor } from '../server/lib/validation'

describe('exam-platform response mapping', () => {
  it('preserves the upstream submission time and exam type', () => {
    const row = { ...demoList.data.data[0], endTime: '2026-08-20 21:23', examTypeTitle: '测试' }
    const { rows } = normalizeList({ code: 'success', data: { totalCount: 1, data: [row] } })
    expect(rows[0]).toMatchObject({ endTime: row.endTime, examTypeTitle: row.examTypeTitle })
  })
  it('extracts a round only from the approved portal and expected route', () => {
    expect(parseRoundUrl(DEMO_ROUND_URL)).toEqual({
      examUid: DEMO_ROUND.examUid,
      examRoundUid: DEMO_ROUND.examRoundUid,
    })
    expect(parseRoundUrl(DEMO_ROUND_URL.replace('portal.visioneschool.com', 'example.test'))).toBeNull()
    expect(parseRoundUrl(DEMO_ROUND_URL + '&examUid=E42')).toBeNull()
  })

  it('filters by the exact Writing subject, leaving the source status intact', () => {
    const { totalCount, rows } = normalizeList(demoList)
    expect(totalCount).toBe(4)
    expect(rows.map(row => row.correctStatusTitle)).toEqual(['已批改', '未批改', '未批改'])
    expect(rows[0]!.examHistoryId).toBe(demoTasks[0]!.examHistoryId)
  })

  it('links the numeric card ID to the list and preserves the exact Task 2 text', () => {
    const task = demoTasks[0]!
    const card = demoCard(task.examHistoryId)!
    const answer = normalizeAnswer(card, task)!
    expect(answer.answerText).toBe(card.data.paperAnswerHistoryList[1]!.answerHistoryList[1]!.questionAnswerList[0])
    expect(answer.answerText).toContain('\n\n')
    expect(answer.promptText).toContain('Writing Task 2')
    expect(answer.promptImages).toEqual([])
    expect(normalizeAnswer(card, { ...task, questionUid: 'unknown' })).toBeNull()
  })

  it('maps task 1 to the img-allowlisted prompt and speaking to the transcript volume', () => {
    const card = demoCard(demoTasks[0]!.examHistoryId)!
    const task1 = normalizeAnswer(card, { ...demoTasks[0]!, questionUid: taskOneUid }, 'task1')!
    expect(task1.answerText).toContain('bar chart')
    expect(task1.promptImages).toHaveLength(1)
    expect(task1.promptImages[0]).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(task1.promptHtml).toContain('<img src="data:image/svg+xml;base64')
    expect(task1.promptHtml).toContain('alt=')

    // task1 之外的科目不允许 img，且危险属性被剥除。
    const crafted = structuredClone(card)
    const quizzes = crafted.data.volQuizzesDTOList[0]!.answerQuizs
    quizzes[0]!.htmlContent = '<p>Chart</p><img src="https://example.test/chart.png" onerror="bad()" alt="chart">'
    const safe = normalizeAnswer(crafted, { ...demoTasks[0]!, questionUid: taskOneUid }, 'task1')!
    expect(safe.promptHtml).toContain('<img src="https://example.test/chart.png" alt="chart" />')
    expect(safe.promptHtml).not.toContain('onerror')
    expect(safe.promptImages).toEqual(['https://example.test/chart.png'])
    expect(normalizeAnswer(crafted, { ...demoTasks[0]!, questionUid: taskOneUid }, 'task2')?.promptHtml).not.toContain('<img')

    const speakingTask = demoTasks.find(task => task.kind === 'speaking')!
    const speakingCard = demoCard(speakingTask.examHistoryId)!
    const spoken = normalizeAnswer(speakingCard, { ...speakingTask, questionUid: demoSpeakingUid }, 'speaking')!
    expect(spoken.answerText).toContain('my favourite place is a small library')
    expect(spoken.promptText).toContain('Speaking Part 2')
    // 口语答卷不在写作分卷里：按 task2 读取必须为空。
    expect(normalizeAnswer(speakingCard, { ...speakingTask, questionUid: demoSpeakingUid }, 'task2')).toBeNull()
  })

  it('aggregates a whole speaking exam into one prompt and transcript across Part 1/2/3', () => {    // 仿照真实 Round8 口语卷：3 个「综合题」分组，题目在 children 里，
    // 转写按小题 uid 记录，Part 2 的回答挂在指令小题上。
    const group = (uid: string, intro: string, children: Array<[string, string]>) => ({
      uid,
      htmlContent: intro,
      children: children.map(([childUid, html]) => ({ uid: childUid, htmlContent: html })),
    })
    const part1 = group('g1', '<h1>Daily topics</h1>', [
      ['g1a', '<p>Where is your hometown?</p>'],
      ['g1b', '<p>Do you like to keep things tidy?</p>'],
    ])
    const part2 = group('g2', '<h1>Part 2 topic card</h1>', [
      ['g2a', '<p>Talk about a person in the medical field.</p>'],
    ])
    const part3 = group('g3', '<h1>Discussion</h1>', [
      ['g3a', '<p>Is being a doctor difficult?</p>'],
    ])
    const card = {
      code: 'success',
      data: {
        examHistoryId: 51101,
        paperAnswerHistoryList: [{
          examSubject: 13,
          examVolSubId: 2202,
          answerHistoryList: [
            { questionUid: 'g1a', questionAnswerList: ['My hometown is in Sichuan.'] },
            { questionUid: 'g1b', questionAnswerList: ['Yes, I keep my room tidy.'] },
            { questionUid: 'g2a', questionAnswerList: ['I would talk about my friend who is a nurse.'] },
            { questionUid: 'g3a', questionAnswerList: ['It is difficult but meaningful.'] },
          ],
        }],
        volQuizzesDTOList: [{ examVolSubId: 2202, answerQuizs: [part1, part2, part3] }],
      },
    }
    // 任一配置的口语 uid 均可作为整场标记。
    const spoken = normalizeAnswer(card, { examUid: 'E1', examRoundUid: 'R1', examHistoryId: '51101', questionUid: 'g1' }, 'speaking')!
    expect(spoken.promptText).toContain('Where is your hometown?')
    expect(spoken.promptText).toContain('Talk about a person in the medical field.')
    expect(spoken.promptText).toContain('Is being a doctor difficult?')
    expect(spoken.answerText).toContain('【题目】Where is your hometown?')
    expect(spoken.answerText).toContain('【回答转写】My hometown is in Sichuan.')
    expect(spoken.answerText).toContain('I would talk about my friend who is a nurse.')
    // 顺序与原卷一致：Part 2 在 Part 1 之后。
    expect(spoken.answerText.indexOf('keep my room tidy')).toBeLessThan(spoken.answerText.indexOf('medical field'))
    expect(spoken.promptImages).toEqual([])
    // 未配置的标记 uid 视为未启用口语。
    expect(normalizeAnswer(card, { examUid: 'E1', examRoundUid: 'R1', examHistoryId: '51101', questionUid: 'other' }, 'speaking')).toBeNull()
  })

  it('sanitizes prompt HTML and treats duplicate question IDs as ambiguous', () => {
    const task = demoTasks[0]!
    const original = demoCard(task.examHistoryId)!
    const card = structuredClone(original)
    const quizzes = card.data.volQuizzesDTOList[0]!.answerQuizs
    quizzes[1]!.htmlContent = '<p onclick="bad()">Good <img src="https://example.test/image"></p><script>bad()</script>'
    expect(normalizeAnswer(card, { ...task, questionUid: taskTwoUid })?.promptHtml).toBe('<p>Good </p>')
    quizzes.push(quizzes[1]!)
    expect(normalizeAnswer(card, task)).toBeNull()
  })
})

it('shows the grading stage from AI activity, saved review and writeback', () => {
  const task: TaskSummary = {
    id: 'task', kind: 'task2', studentCode: 'demo', sourceStatus: '已批改',
    workStatus: 'PENDING', aiStatus: 'NOT_GRADED', syncStatus: 'NOT_SUBMITTED',
  }
  expect(reviewStageOf(task)).toBe('WAITING_AI')
  expect(reviewStageOf(task, true)).toBe('GRADING')
  const reviewed = { ...task, aiStatus: 'GRADED' } as const
  expect(reviewStageOf(reviewed)).toBe('WAITING_REVIEW')
  expect(reviewStageOf({ ...reviewed, workStatus: 'DRAFT' })).toBe('WAITING_WRITEBACK')
  expect(reviewStageOf({ ...task, workStatus: 'DRAFT' })).toBe('WAITING_WRITEBACK')
  expect(reviewStageOf({ ...reviewed, workStatus: 'CONFIRMED', syncStatus: 'FAILED' })).toBe('WAITING_WRITEBACK')
  expect(reviewStageOf({ ...reviewed, workStatus: 'CONFIRMED', syncStatus: 'SYNCED' })).toBe('COMPLETED')
})

describe('grading validation', () => {
  it('rounds the four-skill mean with the IELTS band rule', () => {
    const meanOf = (scores: number[]) => roundBandMean(scores.reduce((a, b) => a + b, 0) / scores.length)
    expect(meanOf([6, 6, 6, 6])).toBe(6)
    expect(meanOf([6, 6, 6, 6.5])).toBe(6)
    expect(meanOf([6, 6, 6, 7])).toBe(6.5)
    expect(meanOf([6, 6, 6.5, 7])).toBe(6.5)
    expect(meanOf([6, 6, 7, 7])).toBe(6.5)
    expect(meanOf([6, 7, 7, 7])).toBe(7)
    expect(meanOf([5.5, 6, 6.5, 7])).toBe(6.5)
    expect(meanOf([5.5, 6, 6, 6])).toBe(6)
    expect(roundBandMean(6.875)).toBe(7)
    expect(roundBandMean(6.125)).toBe(6)
  })

  it('accepts only complete half-point scores between 0 and 9', () => {
    const valid = { tr: 0, cc: 5.5, lr: 9, gra: 6 }
    expect(scoresSchema.parse(valid)).toEqual(valid)
    expect(scoresSchema.safeParse({ ...valid, tr: 6.2 }).success).toBe(false)
    expect(scoresSchema.safeParse({ ...valid, lr: 9.5 }).success).toBe(false)
    expect(scoresSchema.safeParse({ ...valid, gra: undefined }).success).toBe(false)
  })

  it('validates score dimensions per subject and computes the kind mean', () => {
    expect(scoresSchemaFor('task1').safeParse({ ta: 6, cc: 6, lr: 6, gra: 6 }).success).toBe(true)
    expect(scoresSchemaFor('task1').safeParse({ tr: 6, cc: 6, lr: 6, gra: 6 }).success).toBe(false)
    expect(scoresSchemaFor('speaking').safeParse({ fc: 6, lr: 6, gra: 6, p: 5.5 }).success).toBe(true)
    expect(scoresSchemaFor('speaking').safeParse({ fc: 6, lr: 6, gra: 6 }).success).toBe(false)
    expect(meanOf('task2', { tr: 6, cc: 6, lr: 6, gra: 7 })).toBe(6.5)
    expect(meanOf('task1', { ta: 5.5, cc: 6, lr: 6, gra: 6 })).toBe(6)
    expect(meanOf('speaking', { fc: 6, lr: 6, gra: 6, p: 7 })).toBe(6.5)
    expect(scoreKeysFor('speaking')).toEqual(['fc', 'lr', 'gra', 'p'])
  })

  it('uses UTF-16 offsets and refuses ambiguous and missing evidence', () => {
    expect(locateAnnotation('🌱\nExact phrase.\n', 'Exact phrase.')).toEqual({ start: 3, end: 16 })
    expect(locateAnnotation('Same. Same.', 'Same.')).toBeNull()
    expect(locateAnnotation('Same. Same.', 'Same.', 2)).toBeNull()
    expect(locateAnnotation('Same. Same.', 'Same.', 6)).toEqual({ start: 6, end: 11 })
    expect(locateAnnotation('One.', 'Another.')).toBeNull()
  })

  it('validates provider output and attaches the answer and prompt versions', async () => {
    const answer = 'A reason matters. Public spaces matter.\nPublic spaces matter.'
    const output = await mockAi.grade({ prompt: 'A prompt', answer, kind: 'task2', rubric: RUBRICS.task2, promptVersion })
    const review = normalizeAi(output, answer, 'answer-v1')
    expect(review.answerVersion).toBe('answer-v1')
    expect(review.promptVersion).toBe(promptVersion)
    for (const section of ['【任务回应】', '【连贯与衔接】', '【词汇资源】', '【语法与准确性】']) {
      expect(review.teacherComment).toContain(section)
    }
    expect(review.annotations[0]?.range).toEqual({ start: 0, end: 17 })
    expect(review.annotations[1]?.range).toBeNull()
    expect(() => normalizeAi({ scores: {} }, answer, 'answer-v1')).toThrow()
  })

  it('tolerates model output drift: unknown keys, uppercase aliases, and string scores', () => {
    const speakingAnswer = 'My hometown is in Sichuan. I love the hot pot there.'
    const review = normalizeAi({
      scores: { FC: 6, LR: '6.5', GRA: 6, PR: 5, summary: '不应出现的多余键' },
      reasons: { FC: '流利度尚可。', lr: '词汇基本够用。', Gra: '语法需加强。', PR: '发音训练参考。', extra: '多余' },
      summary: '整场表现基本清楚。',
      teacherComment: '【整体表现】基本清楚。',
      annotations: [],
      suggestions: ['跟读复听。'],
    }, speakingAnswer, 'answer-v9', 'ielts-speaking-demo-v1', 'speaking')
    expect(review.scores).toEqual({ fc: 6, lr: 6.5, gra: 6, p: 5 })
    expect(review.reasons).toEqual({ fc: '流利度尚可。', lr: '词汇基本够用。', gra: '语法需加强。', p: '发音训练参考。' })
  })

  it('unwraps assessment-style output and backfills missing fields from the comment', () => {
    const speakingAnswer = 'My hometown is in Sichuan. I love the hot pot there.'
    const review = normalizeAi({
      assessment: {
        inputValid: true,
        scores: { FC: 6, LR: 6, GRA: 5, PR: 5 },
        dimensionReviews: { FC: '展开尚可。', LR: '搭配基本准确。', GRA: '复杂句不稳。', PR: '训练重点是意群重音。' },
        summary: '',
        teacherComment: '【整体表现】基本清楚，仍有明显限制。\n【流利度与连贯性】……',
        evidence: [{ questionId: 'q1', quote: 'My hometown is in Sichuan.' }, { quote: '' }],
        suggestions: ['跟读复听。'],
      },
    }, speakingAnswer, 'answer-v10', 'ielts-speaking-demo-v1', 'speaking')
    // assessment 包装被解开；summary 缺失时用 teacherComment 首行兜底；
    // dimensionReviews 映射为 reasons；evidence 风格的引用仅保留有效 quote。
    expect(review.summary).toBe('【整体表现】基本清楚，仍有明显限制。')
    expect(review.scores).toEqual({ fc: 6, lr: 6, gra: 5, p: 5 })
    expect(review.reasons).toEqual({ fc: '展开尚可。', lr: '搭配基本准确。', gra: '复杂句不稳。', p: '训练重点是意群重音。' })
    expect(review.suggestions).toEqual(['跟读复听。'])
    expect(review.annotations).toHaveLength(0)
  })

  it('produces per-subject mock reviews for speaking and task 1', async () => {
    const speakingAnswer = 'Well, my favourite place is a small library near my home.'
    const speaking = await mockAi.grade({ prompt: 'Describe a place', answer: speakingAnswer, kind: 'speaking', rubric: RUBRICS.speaking, promptVersion })
    const speakingReview = normalizeAi(speaking, speakingAnswer, 'answer-v2', 'ielts-speaking-demo-v1', 'speaking')
    for (const section of ['【流利与连贯】', '【词汇资源】', '【语法与准确性】', '【发音】']) {
      expect(speakingReview.teacherComment).toContain(section)
    }
    expect(speakingReview.scores).toEqual({ fc: 5.5, lr: 6, gra: 5.5, p: 5 })

    const task1Answer = 'The bar chart shows visitor numbers across four attractions.'
    const task1 = await mockAi.grade({ prompt: 'The chart below shows...', answer: task1Answer, kind: 'task1', rubric: RUBRICS.task1, promptVersion })
    const task1Review = normalizeAi(task1, task1Answer, 'answer-v3', 'ielts-task1-demo-v1', 'task1')
    for (const section of ['【任务达成】', '【连贯与衔接】', '【词汇资源】', '【语法与准确性】']) {
      expect(task1Review.teacherComment).toContain(section)
    }
    expect(task1Review.scores).toEqual({ ta: 5, cc: 5.5, lr: 6, gra: 6 })
  })
})
