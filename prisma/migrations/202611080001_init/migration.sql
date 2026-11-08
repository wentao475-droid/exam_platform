-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('TEACHER');

-- CreateEnum
CREATE TYPE "SyncState" AS ENUM ('PENDING', 'SYNCING', 'SYNCED', 'FAILED', 'CONFLICT');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('AI_REVIEW', 'SAVE_DRAFT', 'CONFIRM', 'SYNC_START', 'SYNC_SUCCESS', 'SYNC_FAIL', 'SYNC_CONFLICT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'TEACHER',
    "passwordHash" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "examUid" TEXT NOT NULL,
    "examRoundUid" TEXT NOT NULL,
    "examHistoryId" TEXT NOT NULL,
    "questionUid" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "draft" JSONB,
    "ai" JSONB,
    "activeSubmissionId" TEXT,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "answerVersion" TEXT NOT NULL,
    "scores" JSONB NOT NULL,
    "mean" DOUBLE PRECISION NOT NULL,
    "comment" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "state" "SyncState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "message" TEXT,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Audit" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockAnswerVersion" (
    "examHistoryId" TEXT NOT NULL,
    "version" TEXT NOT NULL,

    CONSTRAINT "MockAnswerVersion_pkey" PRIMARY KEY ("examHistoryId")
);

-- CreateTable
CREATE TABLE "MockReceipt" (
    "idempotencyKey" TEXT NOT NULL,
    "examHistoryId" TEXT NOT NULL,
    "questionUid" TEXT NOT NULL,
    "answerVersion" TEXT NOT NULL,
    "scores" JSONB NOT NULL,
    "mean" DOUBLE PRECISION NOT NULL,
    "comment" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockReceipt_pkey" PRIMARY KEY ("idempotencyKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Task_activeSubmissionId_key" ON "Task"("activeSubmissionId");

-- CreateIndex
CREATE INDEX "Task_teacherId_examUid_examRoundUid_idx" ON "Task"("teacherId", "examUid", "examRoundUid");

-- CreateIndex
CREATE UNIQUE INDEX "Task_examUid_examRoundUid_examHistoryId_questionUid_key" ON "Task"("examUid", "examRoundUid", "examHistoryId", "questionUid");

-- CreateIndex
CREATE INDEX "Submission_taskId_idx" ON "Submission"("taskId");

-- CreateIndex
CREATE INDEX "Audit_taskId_createdAt_idx" ON "Audit"("taskId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MockReceipt_examHistoryId_questionUid_answerVersion_key" ON "MockReceipt"("examHistoryId", "questionUid", "answerVersion");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_activeSubmissionId_fkey" FOREIGN KEY ("activeSubmissionId") REFERENCES "Submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Audit" ADD CONSTRAINT "Audit_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Audit" ADD CONSTRAINT "Audit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

