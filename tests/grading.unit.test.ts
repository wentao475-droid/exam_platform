import { describe, expect, it } from 'vitest'
import { DEMO_ROUND_URL } from '../shared/grading'
import { locateAnnotation, normalizeAi, mockAi, promptVersion, rubric } from '../server/lib/ai'
import { DEMO_ROUND, demoCard, demoList, demoTasks, taskTwoUid } from '../server/lib/demo'
import { normalizeAnswer, normalizeList, parseRoundUrl } from '../server/lib/source'
import { scoresSchema } from '../server/lib/validation'

describe('exam-platform response mapping', () => {
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
    expect(normalizeAnswer(card, { ...task, questionUid: 'unknown' })).toBeNull()
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

describe('grading validation', () => {
  it('accepts only complete half-point scores between 0 and 9', () => {
    const valid = { tr: 0, cc: 5.5, lr: 9, gra: 6 }
    expect(scoresSchema.parse(valid)).toEqual(valid)
    expect(scoresSchema.safeParse({ ...valid, tr: 6.2 }).success).toBe(false)
    expect(scoresSchema.safeParse({ ...valid, lr: 9.5 }).success).toBe(false)
    expect(scoresSchema.safeParse({ ...valid, gra: undefined }).success).toBe(false)
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
    const output = await mockAi.grade({ prompt: 'A prompt', answer, rubric, promptVersion })
    const review = normalizeAi(output, answer, 'answer-v1')
    expect(review.answerVersion).toBe('answer-v1')
    expect(review.promptVersion).toBe(promptVersion)
    expect(review.teacherComment).toContain('模拟 AI 评语')
    expect(review.annotations[0]?.range).toEqual({ start: 0, end: 17 })
    expect(review.annotations[1]?.range).toBeNull()
    expect(() => normalizeAi({ scores: {} }, answer, 'answer-v1')).toThrow()
  })
})
