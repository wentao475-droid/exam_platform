import { createError, deleteCookie, getCookie, getHeader, getRequestURL, setCookie, type H3Event } from 'h3'
import { hashToken, newSessionToken, verifyPassword } from '../lib/credentials'
import { prisma } from '../lib/prisma'
import { canUseLiveAccount, getReadMode } from '../lib/live-platform'
import type { SessionUser } from '../../shared/grading'

const cookieName = 'grading_session'
const sessionMaxAge = 8 * 60 * 60
const userSelection = { id: true, name: true, role: true } as const

export function validateWriteOrigin(event: H3Event) {
  const origin = getHeader(event, 'origin')
  if (getHeader(event, 'sec-fetch-site') === 'cross-site'
    || (origin && origin !== getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).origin)) {
    throw createError({ statusCode: 403, statusMessage: 'Cross-origin request denied' })
  }
}

export async function getSessionUser(event: H3Event): Promise<SessionUser | null> {
  const token = getCookie(event, cookieName)
  if (!token) return null
  const session = await prisma.session.findFirst({
    where: { tokenHash: hashToken(token), expiresAt: { gt: new Date() } },
    select: { user: { select: { ...userSelection, email: true } } },
  })
  if (!session) return null
  const { id, email, name, role } = session.user
  return getReadMode() === 'live' && !canUseLiveAccount(id, email) ? null : { id, name, role }
}

export async function requireTeacher(event: H3Event) {
  const user = await getSessionUser(event)
  if (!user) throw createError({ statusCode: 401, statusMessage: 'Sign in required' })
  if (user.role !== 'TEACHER') throw createError({ statusCode: 403, statusMessage: 'Teacher role required' })
  return user
}

export async function signIn(event: H3Event, email: string, password: string) {
  const record = await prisma.user.findUnique({ where: { email }, select: { ...userSelection, passwordHash: true } })
  const verified = await verifyPassword(password, record?.passwordHash)
  if (!record || !verified || (getReadMode() === 'live' && !canUseLiveAccount(record.id, email))) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid email or password' })
  }
  const token = newSessionToken()
  const previous = getCookie(event, cookieName)
  await prisma.$transaction(async tx => {
    if (previous) await tx.session.deleteMany({ where: { tokenHash: hashToken(previous) } })
    await tx.session.create({
      data: { tokenHash: hashToken(token), userId: record.id, expiresAt: new Date(Date.now() + sessionMaxAge * 1000) },
    })
  })
  setCookie(event, cookieName, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: getRequestURL(event, { xForwardedProto: true }).protocol === 'https:',
    path: '/',
    maxAge: sessionMaxAge,
  })
  return { id: record.id, name: record.name, role: record.role } satisfies SessionUser
}

export async function signOut(event: H3Event) {
  const token = getCookie(event, cookieName)
  if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } })
  deleteCookie(event, cookieName, { path: '/' })
}
