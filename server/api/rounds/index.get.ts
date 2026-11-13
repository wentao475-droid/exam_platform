import { defineEventHandler, setResponseHeader } from 'h3'
import { getReadMode, listLiveRoundsFor } from '../../lib/live-platform'
import { prisma } from '../../lib/prisma'
import { requireTeacher } from '../../utils/grading-session'

export default defineEventHandler(async event => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const { id } = await requireTeacher(event)
  if (getReadMode() !== 'live') return []

  const teacher = await prisma.user.findUnique({ where: { id }, select: { email: true } })
  return teacher ? listLiveRoundsFor(teacher.email) : []
})
