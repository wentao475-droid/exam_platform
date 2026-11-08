import { defineEventHandler } from 'h3'
import { submit } from '../../../lib/grading'
import { submitBody } from '../../../lib/validation'
import { getTaskId, parseBody } from '../../../utils/grading-request'
import { requireTeacher, validateWriteOrigin } from '../../../utils/grading-session'

export default defineEventHandler(async event => {
  validateWriteOrigin(event)
  const teacher = await requireTeacher(event)
  return await submit(getTaskId(event), teacher.id, await parseBody(event, submitBody))
})
