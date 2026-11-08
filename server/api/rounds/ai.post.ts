import { defineEventHandler, setResponseHeader } from 'h3'
import { requestRoundAi } from '../../lib/grading'
import { roundBody } from '../../lib/validation'
import { parseBody } from '../../utils/grading-request'
import { requireTeacher, validateWriteOrigin } from '../../utils/grading-session'

export default defineEventHandler(async event => {
  validateWriteOrigin(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const teacher = await requireTeacher(event)
  const { url } = await parseBody(event, roundBody)
  return await requestRoundAi(url, teacher.id)
})
