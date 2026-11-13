import { z } from 'zod'
import { SCORE_KEYS_BY_KIND, type ScoreKey, type TaskKind } from '../../shared/grading'

const score = z.number().min(0).max(9).multipleOf(0.5)

const scoreShapes: Record<TaskKind, z.ZodRawShape> = {
  task2: { tr: score, cc: score, lr: score, gra: score },
  task1: { ta: score, cc: score, lr: score, gra: score },
  speaking: { fc: score, lr: score, gra: score, p: score },
}

export function scoresSchemaFor(kind: TaskKind) {
  return z.object(scoreShapes[kind]).strict()
}

const reasonShapeFor = (kind: TaskKind) =>
  Object.fromEntries(SCORE_KEYS_BY_KIND[kind].map(key => [key, z.string().min(1).max(4000)])) as Record<ScoreKey, z.ZodString>

export function aiResultSchemaFor(kind: TaskKind) {
  return z.object({
    scores: scoresSchemaFor(kind),
    reasons: z.object(reasonShapeFor(kind)).strict(),
    summary: z.string().min(1).max(4000),
    teacherComment: z.string().trim().min(1).max(12000),
    annotations: z.array(z.object({
      quote: z.string().min(1).max(3000),
      comment: z.string().min(1).max(4000),
      suggestion: z.string().max(4000),
      start: z.number().int().nonnegative().optional(),
    }).strict()).max(100),
    suggestions: z.array(z.string().min(1).max(4000)).max(30),
  }).strict()
}

// Backwards-compatible aliases for the task2 shapes.
export const scoresSchema = scoresSchemaFor('task2')
export const aiResultSchema = aiResultSchemaFor('task2')

export const loginSchema = z.object({
  email: z.string().email().max(254).transform(email => email.toLowerCase()),
  password: z.string().min(1).max(200),
}).strict()

export const roundBody = z.object({ url: z.string().min(1).max(4096) }).strict()
export const taskIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)

export const versionBody = z.object({ answerVersion: z.string().min(1).max(200) }).strict()
export const taskAiBody = versionBody.extend({ regenerate: z.boolean().optional() }).strict()
export const submitBody = versionBody.extend({ revision: z.number().int().nonnegative() }).strict()

/** 草稿解析分两步：端点先用 wire 校验外层（scores 仅要求是对象），saveDraft 内按 task.kind 补齐校验。 */
export const draftBase = submitBody.extend({ comment: z.string().max(12000) }).strict()
export const draftWire = draftBase.extend({ scores: z.record(z.string(), z.unknown()) }).strict()
export const draftBodyFor = (kind: TaskKind) => draftBase.extend({ scores: scoresSchemaFor(kind) }).strict()
export const draftBody = draftBodyFor('task2')
