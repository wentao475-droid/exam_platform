import { createError, getRouterParam, readValidatedBody, type H3Event } from 'h3'
import type { z } from 'zod'
import { taskIdSchema } from '../lib/validation'

export async function parseBody<T>(event: H3Event, schema: z.ZodType<T, z.ZodTypeDef, unknown>) {
  return await readValidatedBody(event, value => {
    const result = schema.safeParse(value)
    if (!result.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid request', data: { issues: result.error.flatten() } })
    }
    return result.data
  })
}

export function getTaskId(event: H3Event) {
  const result = taskIdSchema.safeParse(getRouterParam(event, 'id'))
  if (!result.success) throw createError({ statusCode: 400, statusMessage: 'Invalid task ID' })
  return result.data
}
