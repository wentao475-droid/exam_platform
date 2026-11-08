import { PrismaClient } from '@prisma/client'

const runtime = globalThis as typeof globalThis & { gradingPrisma?: PrismaClient }

export const prisma = runtime.gradingPrisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') {
  runtime.gradingPrisma = prisma
}
