import { defineEventHandler } from 'h3'
import { saveDraft } from '../../../lib/grading'
import { draftWire } from '../../../lib/validation'
import { getTaskId, parseBody } from '../../../utils/grading-request'
import { requireTeacher, validateWriteOrigin } from '../../../utils/grading-session'

export default defineEventHandler(async event => {
  validateWriteOrigin(event)
  const teacher = await requireTeacher(event)
  // 外层先做宽松校验；scores 的维度完整性由 saveDraft 按 task.kind 补齐。
  return await saveDraft(getTaskId(event), teacher.id, await parseBody(event, draftWire))
})
