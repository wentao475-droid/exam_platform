import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { hashPassword } from '../server/lib/credentials'
import { prisma } from '../server/lib/prisma'

const accountSchema = z.object({
  email: z.string().email().transform(email => email.toLowerCase())
    .refine(email => !email.endsWith('@example.test')),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(200).refine(password => password !== 'demo-teacher-2026'),
})

async function provision() {
  const account = accountSchema.safeParse({
    email: process.env.EXAM_LIVE_TEACHER_EMAIL,
    name: process.env.EXAM_LIVE_TEACHER_NAME,
    password: process.env.EXAM_LIVE_TEACHER_PASSWORD,
  })
  if (!account.success) {
    throw new Error('Set EXAM_LIVE_TEACHER_EMAIL, EXAM_LIVE_TEACHER_NAME and a new password (at least 12 characters).')
  }
  const { email, name, password } = account.data
  const passwordHash = await hashPassword(password)
  await prisma.$transaction(async tx => {
    const existing = await tx.user.findUnique({ where: { email }, select: { id: true } })
    if (!existing) {
      await tx.user.create({ data: { id: 'live-teacher-' + randomUUID(), email, name, passwordHash } })
      return
    }
    if (!existing.id.startsWith('live-teacher-')) throw new Error('Use a separate local teacher email.')
    await tx.user.update({ where: { id: existing.id }, data: { name, passwordHash } })
    await tx.session.deleteMany({ where: { userId: existing.id } })
  })
  console.log('Live teacher account saved.')
}

provision().catch(error => {
  console.error(error instanceof Error && !('clientVersion' in error) ? error.message : 'Unable to provision teacher.')
  process.exitCode = 1
}).finally(async () => {
  await prisma.$disconnect()
})
