import { defineEventHandler } from 'h3'
import { requestAi } from '../../../lib/grading'
import { versionBody } from '../../../lib/validation'
import { getTaskId, parseBody } from '../../../utils/grading-request'
import { requireTeacher, validateWriteOrigin } from '../../../utils/grading-session'

export default defineEventHandler(async event => {
  validateWriteOrigin(event)
  const teacher = await requireTeacher(event)
  const { answerVersion } = await parseBody(event, versionBody)
  return await requestAi(getTaskId(event), teacher.id, answerVersion)
})
