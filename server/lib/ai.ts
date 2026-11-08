import type { AiReview, Annotation } from '../../shared/grading'
import { aiResultSchema } from './validation'

export const rubric = {
  tr: 'Address both views, develop relevant ideas, and state a clear position.',
  cc: 'Organise ideas logically and use cohesive devices appropriately.',
  lr: 'Use a range of vocabulary precisely and appropriately.',
  gra: 'Use a range of sentence structures with grammatical accuracy.',
}
export const promptVersion = 'ielts-task2-demo-v2'

export interface AiRequest {
  prompt: string
  answer: string
  rubric: typeof rubric
  promptVersion: string
}

export interface AiProvider {
  grade(request: AiRequest): Promise<unknown>
}

export const mockAi: AiProvider = {
  async grade({ answer }) {
    const paragraphs = answer.split(/\n\s*\n/)
    const firstSentence = paragraphs[0]?.match(/^.+?[.!?](?:\s|$)/u)?.[0]?.trim() ?? paragraphs[0]?.trim().slice(0, 200)
    const annotations: Array<{ quote: string; start?: number; comment: string; suggestion: string }> = firstSentence ? [{
      quote: firstSentence,
      start: answer.indexOf(firstSentence),
      comment: '开头提出了议题，可以更直接表达立场。',
      suggestion: '简要写明你支持哪一方以及原因。',
    }] : []
    if (answer.includes('Public spaces matter.')) {
      annotations.push({
        quote: 'Public spaces matter.',
        comment: '这一表述较宽泛。',
        suggestion: '用一个与论点直接相关的例子说明公共空间的价值。',
      })
    }
    return {
      scores: { tr: 5.5, cc: 6, lr: 6, gra: 6 },
      reasons: {
        tr: '讨论了两种观点，论据可以展开。演示评分。',
        cc: '段落结构清楚，段落之间可加强衔接。演示评分。',
        lr: '词汇基本准确，可增加更具体的表达。演示评分。',
        gra: '句子基本清楚，可使用更多复合句。演示评分。',
      },
      summary: '这是用于演示阅卷流程的模拟预评分。',
      teacherComment: '模拟 AI 评语：文章回应了题目。建议在正文中用具体例子支持主要观点，并在结尾重申立场。请教师复核后编辑。',
      annotations,
      suggestions: ['为每个主要观点补充具体例子。', '在结尾重申并回应题目要求。'],
    }
  },
}

export function locateAnnotation(answer: string, quote: string, start?: number): Annotation['range'] {
  if (start !== undefined && answer.slice(start, start + quote.length) === quote) {
    return { start, end: start + quote.length }
  }
  const found = answer.indexOf(quote)
  if (found < 0 || answer.indexOf(quote, found + 1) >= 0) return null
  return { start: found, end: found + quote.length }
}

export function normalizeAi(raw: unknown, answer: string, answerVersion: string): AiReview {
  const parsed = aiResultSchema.parse(raw)
  return {
    ...parsed,
    answerVersion,
    promptVersion,
    annotations: parsed.annotations.map(({ start, ...annotation }) => ({
      ...annotation,
      range: locateAnnotation(answer, annotation.quote, start),
    })),
  }
}
