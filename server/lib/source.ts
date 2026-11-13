import { z } from 'zod'
import sanitizeHtml from 'sanitize-html'
import type { Scores, TaskKind } from '../../shared/grading'

const sourceId = z.union([z.string().min(1), z.number().int().nonnegative().refine(Number.isSafeInteger)])
  .transform(String)

/** 写作（task1/task2）在 examSubject=14 分卷，口语在 13。 */
export const examSubjectFor = (kind: TaskKind) => kind === 'speaking' ? 13 : 14

const listResponse = z.object({
  code: z.literal('success'),
  data: z.object({
    totalCount: z.number().int().nonnegative(),
    data: z.array(z.object({
      examHistoryId: sourceId,
      examSubject: z.string(),
      studentCode: z.string().nullish().transform(value => value ?? ''),
      studentName: z.string().trim().nullish(),
      customerCode: z.string().trim().nullish(),
      endTime: z.string().trim().nullish(),
      examTypeTitle: z.string().trim().nullish(),
      correctStatusTitle: z.string(),
      examRoundUid: z.string().optional(),
    })),
  }),
})

export type SourceListRow = z.output<typeof listResponse>['data']['data'][number]

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
        // 口语卷为「综合题」分组：题目在 children 里（Part 1/2/3 各一组）。
        children: z.array(z.object({
          uid: sourceId,
          htmlContent: z.string().nullish(),
          content: z.string().nullish(),
        })).nullish(),
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
  /** 仅 task1：题目图表图片 URL（https/data），随 AI 请求传给视觉模型。 */
  promptImages: string[]
  answerText: string
  answerVersion: string
}

export interface SourceResult extends AnswerRef {
  kind: TaskKind
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

export function normalizeList(response: unknown, allowedSubjects: readonly number[] = [14]) {
  const { totalCount, data } = listResponse.parse(response).data
  return {
    totalCount,
    rowIds: data.map(row => row.examHistoryId),
    rows: data.filter(row => row.examSubject.split(',')
      .some(subject => allowedSubjects.includes(Number(subject.trim())))),
  }
}

/**
 * 从答题卡自动识别科目题目：写作分卷（14）先按题干时长区分，
 * 缺少时长时使用 250 / 150 词要求。
 * 口语分卷（13）整场一份批改，取首个题目 UID 作为「该轮启用口语」的标记。
 * 无法解析或无法识别的题目直接跳过，不抛错。
 */
export function detectCardKinds(card: unknown): Map<string, TaskKind> {
  const kinds = new Map<string, TaskKind>()
  let data: z.output<typeof answerResponse>['data']
  try {
    data = answerResponse.parse(card).data
  } catch {
    return kinds
  }
  const subjectByVol = new Map(data.paperAnswerHistoryList
    .map(section => [String(section.examVolSubId), section.examSubject] as const))
  for (const quizList of data.volQuizzesDTOList) {
    const subject = subjectByVol.get(String(quizList.examVolSubId))
    if (subject === 13) {
      const marker = quizList.answerQuizs[0]?.uid
      if (marker) kinds.set(marker, 'speaking')
      continue
    }
    if (subject !== 14) continue
    for (const quiz of quizList.answerQuizs) {
      const text = String(quiz.htmlContent || quiz.content || '').replace(/<[^>]+>|&nbsp;/gi, ' ')
      if (/\b40\s*minutes\b/i.test(text)) kinds.set(quiz.uid, 'task2')
      else if (/\b20\s*minutes\b/i.test(text)) kinds.set(quiz.uid, 'task1')
      else if (/\b250\s*words\b/i.test(text)) kinds.set(quiz.uid, 'task2')
      else if (/\b150\s*words\b/i.test(text)) kinds.set(quiz.uid, 'task1')
    }
  }
  return kinds
}

const basePromptTags = ['h2', 'h3', 'p', 'br', 'em', 'strong', 'b', 'i', 'ol', 'ul', 'li', 'blockquote']

export function normalizeAnswer(response: unknown, ref: AnswerRef, kind: TaskKind = 'task2') {
  const card = answerResponse.parse(response).data
  if (card.examHistoryId !== ref.examHistoryId) return null

  const subject = examSubjectFor(kind)
  const sections = card.paperAnswerHistoryList.filter(section => section.examSubject === subject)
  const matches = sections.flatMap(section => card.volQuizzesDTOList
    .filter(quizList => quizList.examVolSubId === section.examVolSubId)
    .flatMap(quizList => quizList.answerQuizs.filter(quiz => quiz.uid === ref.questionUid)
      .map(quiz => ({ quiz, section }))))
  if (kind === 'speaking') {
    // 口语整场一份批改：聚合该科目分卷全部题目（Part 1/2/3）与全部转写，
    // speakingQuestionUids 中的 uid 仅作为「该轮启用口语」的标记。
    const quizText = new Map<string, string>()
    const promptParts = sections.flatMap(section => card.volQuizzesDTOList
      .filter(quizList => quizList.examVolSubId === section.examVolSubId)
      .flatMap(quizList => quizList.answerQuizs.flatMap(quiz => [
        quiz.htmlContent || quiz.content || '',
        ...(quiz.children ?? []).map(child => child.htmlContent || child.content || ''),
      ])))
    for (const quizList of card.volQuizzesDTOList) {
      for (const quiz of quizList.answerQuizs) {
        quizText.set(quiz.uid, quiz.htmlContent || quiz.content || '')
        for (const child of quiz.children ?? []) quizText.set(child.uid, child.htmlContent || child.content || '')
      }
    }
    if (!quizText.has(ref.questionUid) || promptParts.every(part => !part.trim())) return null
    const promptHtml = sanitizeHtml(promptParts.filter(Boolean).join('\n'), {
      allowedTags: basePromptTags,
      allowedAttributes: {},
      allowedSchemes: ['https'],
    })
    const promptText = sanitizeHtml(promptHtml.replace(/<\//g, '</'), { allowedTags: [], allowedAttributes: {} }).trim()
    const answers = sections.flatMap(section => section.answerHistoryList)
      .filter(answer => (answer.questionAnswerList ?? []).some(item => item.trim()))
    if (!answers.length) return null
    const answerText = answers.map(answer => {
      const question = quizText.get(answer.questionUid)
      const transcript = (answer.questionAnswerList ?? []).join(' ').trim()
      const sanitizedQuestion = question
        ? sanitizeHtml(question, { allowedTags: [], allowedAttributes: {} }).trim()
        : ''
      return sanitizedQuestion ? `【题目】${sanitizedQuestion}\n【回答转写】${transcript}` : transcript
    }).join('\n\n')
    if (!answerText.trim()) return null
    return { promptHtml, promptText, promptImages: [], answerText }
  }
  if (matches.length !== 1) return null

  const { quiz, section } = matches[0]!
  const answers = section.answerHistoryList.filter(answer => answer.questionUid === ref.questionUid)
  if (answers.length !== 1 || !answers[0]!.questionAnswerList?.length) return null

  const answerText = answers[0]!.questionAnswerList!.join('\n')
  if (!answerText.trim()) return null

  const html = quiz.htmlContent || quiz.content || ''
  // Task 1 需要把图表传给视觉模型：在 sanitize 前从原始 html 抽取 img src。
  const promptImages = kind === 'task1'
    ? [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)]
        .map(match => match[1]!)
        .filter(src => /^(?:https:|data:image\/)/i.test(src))
    : []
  const promptHtml = sanitizeHtml(html, {
    allowedTags: kind === 'task1' ? [...basePromptTags, 'img'] : basePromptTags,
    allowedAttributes: kind === 'task1' ? { img: ['src', 'alt'] } : {},
    allowedSchemes: ['https'],
    allowedSchemesByTag: { img: ['https', 'data'] },
  })
  const promptText = sanitizeHtml(promptHtml.replace(/<\/(?:p|h2|h3|li|blockquote)>|<br\s*\/?\s*>/gi, '\n'), {
    allowedTags: [],
    allowedAttributes: {},
  }).trim()
  return { promptHtml, promptText, promptImages, answerText }
}
