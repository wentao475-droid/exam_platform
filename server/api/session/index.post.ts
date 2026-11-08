import { defineEventHandler, setResponseHeader } from 'h3'
import { loginSchema } from '../../lib/validation'
import { getReadMode } from '../../lib/live-platform'
import { parseBody } from '../../utils/grading-request'
import { signIn, validateWriteOrigin } from '../../utils/grading-session'

export default defineEventHandler(async event => {
  validateWriteOrigin(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const { email, password } = await parseBody(event, loginSchema)
  return { user: await signIn(event, email, password), readMode: getReadMode() }
})
