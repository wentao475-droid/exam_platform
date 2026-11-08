import { DEMO_ROUND, demoTasks, demoVersion } from '../server/lib/demo'
import { hashPassword } from '../server/lib/credentials'
import { prisma } from '../server/lib/prisma'

async function seed() {
  const passwordHash = await hashPassword(process.env.DEMO_TEACHER_PASSWORD ?? 'demo-teacher-2026')
  await prisma.$transaction(async tx => {
    for (const teacher of [1, 2]) {
      const id = 'demo-teacher-' + teacher
      const data = {
        email: 'teacher' + teacher + '@example.test',
        name: '演示教师 ' + teacher,
        passwordHash,
      }
      await tx.user.upsert({ where: { id }, create: { id, ...data }, update: data })
    }
    for (const task of demoTasks) {
      await tx.task.upsert({ where: { id: task.id }, create: task, update: {} })
      await tx.mockAnswerVersion.upsert({
        where: { examHistoryId: task.examHistoryId },
        create: { examHistoryId: task.examHistoryId, version: demoVersion },
        update: {},
      })
    }
  })
  console.log('Seeded fictional accounts and tasks for ' + DEMO_ROUND.name)
}

seed()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
