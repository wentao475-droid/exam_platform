import { z } from 'zod'

const score = z.number().min(0).max(9).multipleOf(0.5)
export const scoresSchema = z.object({ tr: score, cc: score, lr: score, gra: score }).strict()

export const loginSchema = z.object({
  email: z.string().email().max(254).transform(email => email.toLowerCase()),
  password: z.string().min(1).max(200),
}).strict()

export const roundBody = z.object({ url: z.string().min(1).max(4096) }).strict()
export const taskIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)

export const versionBody = z.object({ answerVersion: z.string().min(1).max(200) }).strict()
export const submitBody = versionBody.extend({ revision: z.number().int().nonnegative() }).strict()
export const draftBody = submitBody.extend({
  scores: scoresSchema,
  comment: z.string().max(12000),
}).strict()

export const aiResultSchema = z.object({
  scores: scoresSchema,
  reasons: z.object({
    tr: z.string().min(1).max(4000),
    cc: z.string().min(1).max(4000),
    lr: z.string().min(1).max(4000),
    gra: z.string().min(1).max(4000),
  }).strict(),
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
