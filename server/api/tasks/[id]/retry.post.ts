import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { retry } from '../../../lib/grading'
import { getTaskId, parseBody } from '../../../utils/grading-request'
import { requireTeacher, validateWriteOrigin } from '../../../utils/grading-session'

export default defineEventHandler(async event => {
  validateWriteOrigin(event)
  const teacher = await requireTeacher(event)
  await parseBody(event, z.object({}).strict())
  return await retry(getTaskId(event), teacher.id)
})
