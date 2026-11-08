import { defineEventHandler } from 'h3'
import { signOut, validateWriteOrigin } from '../../utils/grading-session'
import { getReadMode } from '../../lib/live-platform'

export default defineEventHandler(async event => {
  validateWriteOrigin(event)
  await signOut(event)
  return { user: null, readMode: getReadMode() }
})
