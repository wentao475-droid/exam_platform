import type { AiReview, Annotation, ScoreKey, TaskKind } from '../../shared/grading'
import { MOCK_AI_PROMPT_VERSIONS, SCORE_KEYS_BY_KIND } from '../../shared/grading'
import { volcengineAi, volcenginePromptVersion } from './volcengine-ai'
import { aiResultSchemaFor } from './validation'

export const RUBRICS: Record<TaskKind, Partial<Record<ScoreKey, string>>> = {
  task2: {
    tr: 'Address the specific requirements of the question, develop relevant ideas, and state a clear position when required.',
    cc: 'Organise ideas logically and use cohesive devices appropriately.',
    lr: 'Use a range of vocabulary precisely and appropriately.',
    gra: 'Use a range of sentence structures with grammatical accuracy.',
  },
  task1: {
    ta: 'Select and report the main features, compare data, and describe trends accurately.',
    cc: 'Organise information coherently with a clear overview.',
    lr: 'Use a range of vocabulary precisely to describe data and trends.',
    gra: 'Use a range of sentence structures with grammatical accuracy.',
  },
  speaking: {
    fc: 'Speak fluently with appropriate pacing and coherent linkage of ideas.',
    lr: 'Use a range of vocabulary flexibly to discuss topics at length.',
    gra: 'Use a range of structures with flexibility and accuracy.',
    p: 'Provide a training reference only. Actual pronunciation requires listening to the recording.',
  },
}
/** Task 2 rubric 别名（兼容既有引用）。 */
export const rubric = RUBRICS.task2
export const mockPromptVersion = MOCK_AI_PROMPT_VERSIONS.task2
export const promptVersion = mockPromptVersion

export interface AiRequest {
  prompt: string
  answer: string
  kind: TaskKind
  rubric: Partial<Record<ScoreKey, string>>
  promptVersion: string
  /** Task 1 图表图片（https/data URL），仅在 kind='task1' 时由调用方传入。 */
  images?: string[]
}

export interface AiProvider {
  grade(request: AiRequest): Promise<unknown>
}

export function activeAiFor(kind: TaskKind): { provider: AiProvider; promptVersion: string } {
  if (process.env.AI_PROVIDER === 'volcengine') {
    return { provider: volcengineAi, promptVersion: volcenginePromptVersion(kind) }
  }
  return { provider: mockAi, promptVersion: MOCK_AI_PROMPT_VERSIONS[kind] }
}

export function activeAi(): { provider: AiProvider; promptVersion: string } {
  return activeAiFor('task2')
}

const mockScores: Record<TaskKind, Partial<Record<ScoreKey, number>>> = {
  task2: { tr: 5.5, cc: 6, lr: 6, gra: 6 },
  task1: { ta: 5, cc: 5.5, lr: 6, gra: 6 },
  speaking: { fc: 5.5, lr: 6, gra: 5.5, p: 5 },
}

const mockReasons: Record<TaskKind, Partial<Record<ScoreKey, string>>> = {
  task2: {
    tr: '讨论了两种观点，论据可以展开。演示评分。',
    cc: '段落结构清楚，段落之间可加强衔接。演示评分。',
    lr: '词汇基本准确，可增加更具体的表达。演示评分。',
    gra: '句子基本清楚，可使用更多复合句。演示评分。',
  },
  task1: {
    ta: '概述了图表主要特征，对比还可以更充分。演示评分。',
    cc: '信息组织清楚，可加强数据之间的衔接。演示评分。',
    lr: '描述数据的词汇基本准确，可更具体。演示评分。',
    gra: '句子基本清楚，可使用更多比较结构。演示评分。',
  },
  speaking: {
    fc: '回答基本连贯，停顿和重复可以减少。演示评分。',
    lr: '词汇能覆盖话题，可更灵活多样。演示评分。',
    gra: '句子结构基本准确，可尝试更多复合句。演示评分。',
    p: '基于转写文本的发音参考评估，建议结合录音复核。演示评分。',
  },
}

const mockComments: Record<TaskKind, string> = {
  task2: '文章回应了题目，整体结构清楚。\n'
    + '【任务回应】讨论了两种观点，论据可以进一步展开。\n'
    + '【连贯与衔接】段落结构清楚，段落之间可加强衔接。\n'
    + '【词汇资源】词汇基本准确，可增加更具体的表达。\n'
    + '【语法与准确性】句子基本清楚，可使用更多复合句。\n'
    + '建议在正文中用具体例子支持主要观点，并在结尾重申立场。请教师复核后编辑。',
  task1: '文章覆盖了图表的主要信息，结构清楚。\n'
    + '【任务达成】主要特征已提及，对比和趋势描述可以更充分。\n'
    + '【连贯与衔接】信息组织清楚，可加强数据之间的衔接。\n'
    + '【词汇资源】描述数据的词汇基本准确，可更具体。\n'
    + '【语法与准确性】句子基本清楚，可使用更多比较结构。\n'
    + '建议先给出清晰的概述段，再分组比较关键数据。请教师复核后编辑。',
  speaking: '回答切题，内容基本完整。\n'
    + '【流利与连贯】回答基本连贯，停顿和重复可以减少。\n'
    + '【词汇资源】词汇能覆盖话题，可更灵活多样。\n'
    + '【语法与准确性】句子结构基本准确，可尝试更多复合句。\n'
    + '【发音】发音维度基于转写文本评估，仅供参考，建议结合录音复核。\n'
    + '建议扩展回答的细节和例子，让论述更充分。请教师复核后编辑。',
}

export const mockAi: AiProvider = {
  async grade({ kind, answer }) {
    const paragraphs = answer.split(/\n\s*\n/)
    const firstSentence = paragraphs[0]?.match(/^.+?[.!?](?:\s|$)/u)?.[0]?.trim() ?? paragraphs[0]?.trim().slice(0, 200)
    const annotations: Array<{ quote: string; start?: number; comment: string; suggestion: string }> = firstSentence ? [{
      quote: firstSentence,
      start: answer.indexOf(firstSentence),
      comment: '开头切入话题，可以更直接给出要点。',
      suggestion: '用一句话概括你要表达的核心观点。',
    }] : []
    if (answer.includes('Public spaces matter.')) {
      annotations.push({
        quote: 'Public spaces matter.',
        comment: '这一表述较宽泛。',
        suggestion: '用一个与论点直接相关的例子说明公共空间的价值。',
      })
    }
    return {
      scores: mockScores[kind],
      reasons: mockReasons[kind],
      summary: '这是用于演示阅卷流程的模拟预评分。',
      teacherComment: mockComments[kind],
      annotations,
      suggestions: ['为每个主要观点补充具体细节或例子。', '在结尾重申并回应题目要求。'],
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

// 模型偶发的输出漂移（assessment 包装、大小写、PR 别名、混入多余键、字符串分数、
// 缺字段）在解析前对齐到契约，避免一次格式偏差浪费整次批改。
function normalizeRawAi(raw: unknown, kind: TaskKind): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  let source = raw as Record<string, unknown>
  // 解开常见外层包装（如教研提示词惯性输出的 {"assessment": {...}}）。
  for (const wrapper of ['assessment', 'result', 'data']) {
    const inner = source[wrapper]
    if (inner && typeof inner === 'object' && !Array.isArray(inner)
      && ['scores', 'reasons', 'teacherComment'].some(field => field in (inner as Record<string, unknown>))) {
      source = inner as Record<string, unknown>
      break
    }
  }
  const expected = SCORE_KEYS_BY_KIND[kind]
  const aliases: Record<string, string> = kind === 'speaking'
    ? { pr: 'p', pronunciation: 'p' }
    : {}
  const align = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) return value
    const aligned: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = aliases[key.toLowerCase()] ?? key.toLowerCase()
      const target = expected.find(candidate => candidate === normalizedKey)
      // 未识别的键（如模型混入的 summary）直接丢弃。
      if (!target || target in aligned) continue
      aligned[target] = typeof item === 'string' && /^\d+(?:\.5)?$/.test(item.trim()) ? Number(item.trim()) : item
    }
    return aligned
  }
  // 模型可能用 dimensionReviews 命名维度评价（教研口径），映射为 reasons。
  const reasons = source.reasons ?? source.dimensionReviews
  const teacherComment = typeof source.teacherComment === 'string' ? source.teacherComment : ''
  const suggestedPractice = teacherComment.match(/【优先改进建议】\s*([^【]*)/)?.[1]?.trim().slice(0, 3000)
  const summary = typeof source.summary === 'string' && source.summary.trim()
    ? source.summary
    : teacherComment.split('\n')[0] ?? ''
  const annotations = Array.isArray(source.annotations)
    ? source.annotations.flatMap(item => {
        if (typeof item !== 'object' || item === null) return []
        const { quote, comment, suggestion, start } = item as Record<string, unknown>
        return typeof quote === 'string' && quote.trim() ? [{ quote, comment, suggestion, start }] : []
      })
    : []
  return {
    scores: align(source.scores),
    reasons: align(reasons),
    summary,
    teacherComment,
    annotations,
    suggestions: Array.isArray(source.suggestions) ? source.suggestions : suggestedPractice ? [suggestedPractice] : [],
  }
}

export function normalizeAi(raw: unknown, answer: string, answerVersion: string, promptVersion: string = mockPromptVersion, kind: TaskKind = 'task2'): AiReview {
  const parsed = aiResultSchemaFor(kind).parse(normalizeRawAi(raw, kind))
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
