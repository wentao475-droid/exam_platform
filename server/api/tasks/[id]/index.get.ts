import { defineEventHandler, setResponseHeader } from 'h3'
import { taskDetail } from '../../../lib/grading'
import { getTaskId } from '../../../utils/grading-request'
import { requireTeacher } from '../../../utils/grading-session'

export default defineEventHandler(async event => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const teacher = await requireTeacher(event)
  return await taskDetail(getTaskId(event), teacher.id)
})
