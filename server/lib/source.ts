import { z } from 'zod'
import sanitizeHtml from 'sanitize-html'
import type { Scores } from '../../shared/grading'

const sourceId = z.union([z.string().min(1), z.number().int().nonnegative().refine(Number.isSafeInteger)])
  .transform(String)

const listResponse = z.object({
  code: z.literal('success'),
  data: z.object({
    totalCount: z.number().int().nonnegative(),
    data: z.array(z.object({
      examHistoryId: sourceId,
      examSubject: z.string(),
      studentCode: z.string().nullish().transform(value => value ?? ''),
      correctStatusTitle: z.string(),
      examRoundUid: z.string().optional(),
    })),
  }),
})

const answerResponse = z.object({
  code: z.literal('success'),
  data: z.object({
    examHistoryId: sourceId,
    paperAnswerHistoryList: z.array(z.object({
      examSubject: z.coerce.number().int(),
      examVolSubId: sourceId,
      answerHistoryList: z.array(z.object({
        questionUid: sourceId,
        questionAnswerList: z.array(z.string()).nullish(),
      })),
    })),
    volQuizzesDTOList: z.array(z.object({
      examVolSubId: sourceId,
      answerQuizs: z.array(z.object({
        uid: sourceId,
        htmlContent: z.string().nullish(),
        content: z.string().nullish(),
      })),
    })),
  }),
})

export interface RoundKey {
  examUid: string
  examRoundUid: string
}

export interface AnswerRef extends RoundKey {
  examHistoryId: string
  questionUid: string
}

export interface SourceAnswer {
  promptHtml: string
  promptText: string
  answerText: string
  answerVersion: string
}

export interface SourceResult extends AnswerRef {
  idempotencyKey: string
  answerVersion: string
  scores: Scores
  comment: string
  mean: number
}

export type WriteOutcome =
  | { state: 'SYNCED' }
  | { state: 'FAILED' | 'CONFLICT'; message: string }

export interface ExamPlatformAdapter {
  listWriting(round: RoundKey): Promise<{ name: string; rows: ReturnType<typeof normalizeList>['rows'] } | null>
  readAnswer(ref: AnswerRef): Promise<SourceAnswer | null>
  writeResult(result: SourceResult, attempt: number): Promise<WriteOutcome>
}

export function parseRoundUrl(value: string): RoundKey | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const [route, query] = url.hash.slice(1).split('?')
  if (url.origin !== 'https://portal.visioneschool.com' || url.username || url.password
    || url.pathname !== '/study-teach-product-admin/' || route !== '/examPlatform/roundConfigExamSituation') {
    return null
  }
  const params = new URLSearchParams(query)
  const examUid = params.get('examUid')
  const examRoundUid = params.get('examRoundUid')
  if (params.getAll('examUid').length !== 1 || params.getAll('examRoundUid').length !== 1
    || !examUid || !examRoundUid || !/^E[0-9]{1,30}$/.test(examUid) || !/^ER[0-9]{1,30}$/.test(examRoundUid)) {
    return null
  }
  return { examUid, examRoundUid }
}

export function normalizeList(response: unknown) {
  const { totalCount, data } = listResponse.parse(response).data
  return {
    totalCount,
    rowIds: data.map(row => row.examHistoryId),
    rows: data.filter(row => row.examSubject.split(',').some(subject => subject.trim() === '14')),
  }
}

export function normalizeAnswer(response: unknown, ref: AnswerRef) {
  const card = answerResponse.parse(response).data
  if (card.examHistoryId !== ref.examHistoryId) return null

  const sections = card.paperAnswerHistoryList.filter(section => section.examSubject === 14)
  const matches = sections.flatMap(section => card.volQuizzesDTOList
    .filter(quizList => quizList.examVolSubId === section.examVolSubId)
    .flatMap(quizList => quizList.answerQuizs.filter(quiz => quiz.uid === ref.questionUid)
      .map(quiz => ({ quiz, section }))))
  if (matches.length !== 1) return null

  const { quiz, section } = matches[0]!
  const answers = section.answerHistoryList.filter(answer => answer.questionUid === ref.questionUid)
  if (answers.length !== 1 || !answers[0]!.questionAnswerList?.length) return null

  const answerText = answers[0]!.questionAnswerList!.join('\n')
  if (!answerText.trim()) return null

  const html = quiz.htmlContent || quiz.content || ''
  const promptHtml = sanitizeHtml(html, {
    allowedTags: ['h2', 'h3', 'p', 'br', 'em', 'strong', 'b', 'i', 'ol', 'ul', 'li', 'blockquote'],
    allowedAttributes: {},
  })
  const promptText = sanitizeHtml(promptHtml.replace(/<\/(?:p|h2|h3|li|blockquote)>|<br\s*\/?\s*>/gi, '\n'), {
    allowedTags: [],
    allowedAttributes: {},
  }).trim()
  return { promptHtml, promptText, answerText }
}
