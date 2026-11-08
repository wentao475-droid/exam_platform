import { defineEventHandler, setResponseHeader } from 'h3'
import { getSessionUser } from '../../utils/grading-session'
import { getReadMode } from '../../lib/live-platform'

export default defineEventHandler(async event => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return { user: await getSessionUser(event), readMode: getReadMode() }
})
