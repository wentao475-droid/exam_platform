import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeAi, mockPromptVersion, normalizeAi, rubric, RUBRICS } from '../server/lib/ai'
import { demoCard, demoTasks } from '../server/lib/demo'
import { normalizeAnswer } from '../server/lib/source'
import { aiSystemPrompt, volcengineAi, volcenginePromptVersion } from '../server/lib/volcengine-ai'
import { SCORE_KEYS_BY_KIND } from '../shared/grading'

const answer = normalizeAnswer(demoCard(demoTasks[0]!.examHistoryId)!, demoTasks[0]!)!
const request = {
  prompt: answer.promptText,
  answer: answer.answerText,
  rubric,
  promptVersion: volcenginePromptVersion(),
}

const validResult = {
  scores: { tr: 6, cc: 6, lr: 5.5, gra: 6 },
  reasons: { tr: '回应了题目双方观点。', cc: '结构清晰。', lr: '词汇基本准确。', gra: '语法基本正确。' },
  summary: '整体达到 6 分水平。',
  teacherComment: '文章回应了题目。建议补充具体例子。',
  annotations: [{ quote: 'City parks should be accessible to everyone.', comment: '开头点题清楚。', suggestion: '补充具体例子。' }],
  suggestions: ['补充例子。'],
}

function jsonResponse(content: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('ai provider selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
  it('uses the mock provider unless volcengine is explicitly enabled', () => {
    vi.stubEnv('AI_PROVIDER', 'mock')
    expect(activeAi().promptVersion).toBe(mockPromptVersion)
    delete process.env.AI_PROVIDER
    expect(activeAi().promptVersion).toBe(mockPromptVersion)
    vi.stubEnv('AI_PROVIDER', 'volcengine')
    expect(activeAi()).toEqual({ provider: volcengineAi, promptVersion: volcenginePromptVersion() })
  })
})

describe('prompt configuration', () => {
  beforeEach(() => {
    for (const kind of ['TASK2', 'TASK1', 'SPEAKING']) {
      vi.stubEnv(`AI_SYSTEM_PROMPT_${kind}`, undefined)
      vi.stubEnv(`AI_PROMPT_EXTRA_${kind}`, undefined)
    }
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
  it('keeps the base version and default prompt without custom configuration', () => {
    delete process.env.AI_SYSTEM_PROMPT
    delete process.env.AI_PROMPT_EXTRA
    expect(volcenginePromptVersion()).toBe('ielts-task2-volc-v5')
    const prompt = aiSystemPrompt(rubric)
    expect(prompt).toContain('IELTS Writing Task 2 考官')
    expect(prompt).toContain('【任务回应】')
    expect(prompt).toContain('只输出一个 JSON 对象')
  })

  it('adds AI_PROMPT_EXTRA before the fixed output contract and derives a new version', () => {
    vi.stubEnv('AI_PROMPT_EXTRA', '评分从严，评语更口语化。')
    const prompt = aiSystemPrompt(rubric)
    expect(prompt).toContain('补充要求：\n评分从严')
    expect(prompt.indexOf('补充要求：')).toBeLessThan(prompt.indexOf('只输出一个 JSON 对象'))
    expect(volcenginePromptVersion()).toMatch(/^ielts-task2-volc-v5-c[0-9a-f]{8}$/)
    expect(volcenginePromptVersion()).toBe(volcenginePromptVersion())
    expect(volcenginePromptVersion()).not.toBe('ielts-task2-volc-v5')
  })

  it('lets AI_SYSTEM_PROMPT replace the task section while keeping the output contract', () => {
    vi.stubEnv('AI_SYSTEM_PROMPT', '你是学校内部的雅思写作评审，按校内细则评分。')
    const prompt = aiSystemPrompt(rubric)
    expect(prompt).toContain('校内细则')
    expect(prompt).not.toContain('IELTS Writing Task 2 考官')
    expect(prompt).toContain('只输出一个 JSON 对象')
    expect(volcenginePromptVersion()).not.toBe('ielts-task2-volc-v5')
  })

  it('changes only Task 2 when its dedicated override is edited', () => {
    vi.stubEnv('AI_SYSTEM_PROMPT', '共享评分说明')
    const task1Version = volcenginePromptVersion('task1')
    const speakingVersion = volcenginePromptVersion('speaking')
    const task2Version = volcenginePromptVersion('task2')
    vi.stubEnv('AI_SYSTEM_PROMPT_TASK2', '大作文专属评分说明')
    expect(aiSystemPrompt(RUBRICS.task2, 'task2')).toContain('大作文专属评分说明')
    expect(aiSystemPrompt(RUBRICS.task2, 'task2')).not.toContain('共享评分说明')
    expect(aiSystemPrompt(RUBRICS.task1, 'task1')).toContain('共享评分说明')
    expect(volcenginePromptVersion('task2')).not.toBe(task2Version)
    expect(volcenginePromptVersion('task1')).toBe(task1Version)
    expect(volcenginePromptVersion('speaking')).toBe(speakingVersion)
  })

  it.each([
    ['task2', '只有题目要求讨论双方', '【任务回应】', '步长 0.5'],
    ['task1', '技术缺图不视为未作答', '【任务达成】', '步长 0.5'],
    ['speaking', '需结合录音复核', '【发音（训练参考）】', '0 到 9 的整数'],
  ] as const)('provides a complete subject-specific JSON contract for %s', (kind, rule, heading, scoreRule) => {
    vi.stubEnv('AI_SYSTEM_PROMPT', undefined)
    vi.stubEnv('AI_SYSTEM_PROMPT_TASK1', undefined)
    vi.stubEnv('AI_SYSTEM_PROMPT_SPEAKING', undefined)
    const prompt = aiSystemPrompt(RUBRICS[kind], kind)
    const example = JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1))
    expect(Object.keys(example)).toEqual(['scores', 'reasons', 'summary', 'teacherComment', 'annotations', 'suggestions'])
    expect(Object.keys(example.scores)).toEqual(SCORE_KEYS_BY_KIND[kind])
    expect(Object.keys(example.reasons)).toEqual(SCORE_KEYS_BY_KIND[kind])
    expect(prompt).toContain('## 四维评分依据')
    expect(prompt).toContain('它对该维度的影响，以及为什么符合当前档位')
    for (const text of [rule, heading, scoreRule, '【词汇资源】【语法与准确性】', '【优先改进建议】', '四项给 0']) {
      expect(prompt).toContain(text)
    }
    if (kind === 'task2') {
      for (const text of ['不强制讨论反方', '利大于弊', '双问题题', '名人事例', '250 个英文词']) {
        expect(prompt).toContain(text)
      }
    }
    if (kind === 'speaking') {
      for (const text of ['Part 1–3', '相邻档位', '不因缺音频将该项记为 0', '最多 40 个英文词']) {
        expect(prompt).toContain(text)
      }
      expect(prompt).not.toContain('步长 0.5')
      expect(prompt).toContain('不把它当作实际音素、重音、节奏、连读或语调的证据')
    }
    if (kind === 'task1') {
      for (const text of ['G 类书信', '仅有链接', '哪些内容无法核实', '地图检查', '流程图检查', '不固定扣分或设置分数上限', 'annotations 最多 3 条']) {
        expect(prompt).toContain(text)
      }
    }
  })
})

describe('volcengine grading provider', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
  it('recovers a missing suggestions field from the priority feedback without replacing an explicit empty list', () => {
    const result = { ...validResult, teacherComment: '【整体表现】结构清楚。\n【优先改进建议】为每个理由补充一个具体例子。' }
    expect(normalizeAi({ ...result, suggestions: undefined }, answer.answerText, 'answer-v1').suggestions)
      .toEqual(['为每个理由补充一个具体例子。'])
    expect(normalizeAi({ ...result, suggestions: [] }, answer.answerText, 'answer-v1').suggestions).toEqual([])
  })
  it('keeps a valid annotation when a model adds an extra field', () => {
    const raw = { ...validResult, annotations: [{ ...validResult.annotations[0]!, Why: 'Extra model field' }] }
    const review = normalizeAi(raw, answer.answerText, 'answer-v1')
    expect(review.annotations[0]?.range?.start).toBe(0)
    expect(review.annotations[0]).not.toHaveProperty('Why')
  })
  it('sends an authorized chat completion with the essay and validates the parsed JSON', async () => {
    vi.stubEnv('ARK_API_KEY', 'test-key')
    vi.stubEnv('ARK_MODEL', 'doubao-test')
    const fetchMock = vi.fn(async () => jsonResponse(JSON.stringify(validResult)))
    vi.stubGlobal('fetch', fetchMock)

    const output = await volcengineAi.grade(request)
    expect(output).toEqual(validResult)
    const review = normalizeAi(output, answer.answerText, answer.answerVersion, volcenginePromptVersion)
    expect(review.scores.tr).toBe(6)
    const quote = 'City parks should be accessible to everyone.'
    expect(review.annotations[0]?.range).toEqual({
      start: answer.answerText.indexOf(quote),
      end: answer.answerText.indexOf(quote) + quote.length,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/chat/completions')
    expect(init.headers).toMatchObject({ authorization: 'Bearer test-key' })
    const body = JSON.parse(init.body as string) as {
      model: string
      messages: Array<{ role: string; content: string }>
      response_format?: { type: string }
    }
    expect(body.model).toBe('doubao-test')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages[0]!.content).toContain('IELTS Writing Task 2')
    expect(body.messages[1]!.content).toContain(answer.answerText)
  })

  it('accepts fenced markdown output and a custom base URL', async () => {
    vi.stubEnv('ARK_API_KEY', 'test-key')
    vi.stubEnv('ARK_MODEL', 'doubao-test')
    vi.stubEnv('ARK_BASE_URL', 'https://ark.example.test/api/v3/')
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse('```json\n' + JSON.stringify(validResult) + '\n```')))

    expect(await volcengineAi.grade(request)).toEqual(validResult)
    const [url] = (vi.mocked(fetch).mock.calls[0] as [string, RequestInit])
    expect(url).toBe('https://ark.example.test/api/v3/chat/completions')
  })

  it('fails fast when credentials are missing and surfaces auth failures clearly', async () => {
    vi.stubEnv('AI_PROVIDER', 'volcengine')
    delete process.env.ARK_API_KEY
    await expect(volcengineAi.grade(request)).rejects.toThrow('未配置 ARK_API_KEY 或 ARK_MODEL')

    vi.stubEnv('ARK_API_KEY', 'bad-key')
    vi.stubEnv('ARK_MODEL', 'doubao-test')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'AuthenticationError', message: 'invalid api key' } }),
      { status: 401 },
    )))
    await expect(volcengineAi.grade(request)).rejects.toThrow('API Key 无效或无权限')
  })

  it('reports upstream errors, timeouts, and malformed output as retryable failures', async () => {
    vi.stubEnv('ARK_API_KEY', 'test-key')
    vi.stubEnv('ARK_MODEL', 'doubao-test')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))
    await expect(volcengineAi.grade(request)).rejects.toThrow('火山方舟返回 429')

    vi.stubEnv('ARK_TIMEOUT_MS', '20')
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))
    await expect(volcengineAi.grade(request)).rejects.toThrow('超时')

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('无法输出 JSON 的长篇大论')))
    await expect(volcengineAi.grade(request)).rejects.toThrow('没有可解析的 JSON')
  })
})

describe('volcengine vision grading (task 1)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
  const task1 = demoTasks[3]!
  const task1Answer = normalizeAnswer(demoCard(task1.examHistoryId)!, task1, 'task1')!
  const task1Request = {
    prompt: task1Answer.promptText,
    answer: task1Answer.answerText,
    kind: 'task1' as const,
    rubric: RUBRICS.task1,
    promptVersion: volcenginePromptVersion('task1'),
    images: task1Answer.promptImages,
  }

  it('sends chart images to the configured vision model as multimodal content', async () => {
    vi.stubEnv('ARK_API_KEY', 'test-key')
    vi.stubEnv('ARK_MODEL', 'doubao-test')
    vi.stubEnv('ARK_VISION_MODEL', 'doubao-vision-test')
    const fetchMock = vi.fn(async () => jsonResponse(JSON.stringify(validResult)))
    vi.stubGlobal('fetch', fetchMock)

    expect(await volcengineAi.grade(task1Request)).toEqual(validResult)
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    const body = JSON.parse(init.body as string) as {
      model: string
      messages: Array<{ role: string; content: unknown }>
    }
    // 图表题走独立视觉模型，正文与图片以多段 content 传递。
    expect(body.model).toBe('doubao-vision-test')
    const user = body.messages[1]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(user[0]!.type).toBe('text')
    expect(user[0]!.text).toContain(task1Answer.answerText)
    expect(user[1]).toEqual({ type: 'image_url', image_url: { url: task1Answer.promptImages[0] } })
    const system = body.messages[0]!.content as string
    expect(system).toContain('Writing Task 1')
    expect(system).toContain('ta（Task Achievement）')
    expect(system).toContain('【任务达成】')
  })

  it('fails fast when chart images are present but no vision model is configured', async () => {
    vi.stubEnv('ARK_API_KEY', 'test-key')
    vi.stubEnv('ARK_MODEL', 'doubao-test')
    delete process.env.ARK_VISION_MODEL
    const fetchMock = vi.fn(async () => jsonResponse(JSON.stringify(validResult)))
    vi.stubGlobal('fetch', fetchMock)

    await expect(volcengineAi.grade(task1Request)).rejects.toThrow('ARK_VISION_MODEL')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('omits the thinking field by default and honors ARK_THINKING when configured', async () => {
    vi.stubEnv('ARK_API_KEY', 'test-key')
    vi.stubEnv('ARK_MODEL', 'doubao-test')
    const fetchMock = vi.fn(async () => jsonResponse(JSON.stringify(validResult)))
    vi.stubGlobal('fetch', fetchMock)

    await volcengineAi.grade(request)
    expect(Object.keys(JSON.parse((fetchMock.mock.calls[0]![1]!.body) as string))).not.toContain('thinking')

    vi.stubEnv('ARK_THINKING', 'disabled')
    await volcengineAi.grade(request)
    expect(JSON.parse((fetchMock.mock.calls[1]![1]!.body) as string).thinking).toEqual({ type: 'disabled' })

    vi.stubEnv('ARK_THINKING', 'bogus')
    await volcengineAi.grade(request)
    expect(Object.keys(JSON.parse((fetchMock.mock.calls[2]![1]!.body) as string))).not.toContain('thinking')
  })

  it('derives the task 1 prompt version from the vision model so switching triggers re-grading', () => {    delete process.env.AI_SYSTEM_PROMPT
    delete process.env.AI_PROMPT_EXTRA
    delete process.env.AI_SYSTEM_PROMPT_TASK1
    delete process.env.AI_PROMPT_EXTRA_TASK1
    vi.stubEnv('AI_SYSTEM_PROMPT_TASK2', undefined)
    vi.stubEnv('AI_PROMPT_EXTRA_TASK2', undefined)
    vi.stubEnv('ARK_VISION_MODEL', 'doubao-vision-a')
    const first = volcenginePromptVersion('task1')
    expect(first).toMatch(/^ielts-task1-volc-v4-c[0-9a-f]{8}$/)
    vi.stubEnv('ARK_VISION_MODEL', 'doubao-vision-b')
    const second = volcenginePromptVersion('task1')
    expect(second).not.toBe(first)
    // 文本模型不影响 task1 版本；task2 版本与视觉模型无关。
    vi.stubEnv('ARK_MODEL', 'doubao-other')
    expect(volcenginePromptVersion('task1')).toBe(second)
    expect(volcenginePromptVersion('task2')).toBe('ielts-task2-volc-v5')
  })
})
