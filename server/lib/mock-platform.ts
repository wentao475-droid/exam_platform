import type { TaskKind } from '../../shared/grading'
import { SCORE_KEYS_BY_KIND } from '../../shared/grading'
import { DEMO_ROUND, demoBehavior, demoCard, demoList, demoSpeakingUid, taskOneUid, taskTwoUid } from './demo'
import { prisma } from './prisma'
import { normalizeAnswer, normalizeList, type ExamPlatformAdapter, type RoundKey } from './source'
import { scoresSchemaFor } from './validation'

function isDemoRound(round: RoundKey) {
  return round.examUid === DEMO_ROUND.examUid && round.examRoundUid === DEMO_ROUND.examRoundUid
}

const kindByUid: Record<string, TaskKind> = {
  [taskOneUid]: 'task1',
  [taskTwoUid]: 'task2',
  [demoSpeakingUid]: 'speaking',
}

export const mockPlatform: ExamPlatformAdapter = {
  async listWriting(round) {
    if (!isDemoRound(round)) return null
    return { name: DEMO_ROUND.name, rows: normalizeList(demoList, [14, 13]).rows }
  },

  async readAnswer(ref) {
    const kind = kindByUid[ref.questionUid]
    if (!isDemoRound(ref) || !kind) return null

    const raw = demoCard(ref.examHistoryId)
    if (!raw) return null
    const answer = normalizeAnswer(raw, ref, kind)
    const state = await prisma.mockAnswerVersion.findUnique({ where: { examHistoryId: ref.examHistoryId } })
    return answer && state ? { ...answer, answerVersion: state.version } : null
  },

  async writeResult(result, attempt) {
    if (!isDemoRound(result) || !kindByUid[result.questionUid]) {
      return { state: 'FAILED', message: '演示回写不支持该题目' }
    }
    const { idempotencyKey, examHistoryId, questionUid, answerVersion, scores, mean, comment } = result
    const scoreKeys = SCORE_KEYS_BY_KIND[result.kind]
    return await prisma.$transaction(async tx => {
      const receiptKey = { idempotencyKey }
      // A no-op update locks the source version until the simulated remote write commits.
      const current = await tx.mockAnswerVersion.updateMany({
        where: { examHistoryId, version: answerVersion },
        data: { version: answerVersion },
      })
      const prior = await tx.mockReceipt.findUnique({ where: receiptKey })
      if (prior) {
        const previousScores = scoresSchemaFor(result.kind).safeParse(prior.scores)
        const sameResult = prior.examHistoryId === examHistoryId && prior.questionUid === questionUid
          && prior.answerVersion === answerVersion && prior.mean === mean && prior.comment === comment
          && previousScores.success && scoreKeys.every(key => previousScores.data[key] === scores[key])
        return sameResult
          ? { state: 'SYNCED' }
          : { state: 'FAILED', message: '模拟回写幂等键与既有记录不匹配' }
      }
      if (!current.count) return { state: 'CONFLICT', message: '作答版本已更新，请重新读取并复核' }
      if (demoBehavior(examHistoryId)?.firstSyncFails && attempt === 1) {
        return { state: 'FAILED', message: '模拟接口首次回写失败，可重试' }
      }
      const existing = await tx.mockReceipt.findUnique({
        where: { examHistoryId_questionUid_answerVersion: { examHistoryId, questionUid, answerVersion } },
      })
      if (existing) return { state: 'FAILED', message: '该作答版本已有回写记录' }
      await tx.mockReceipt.create({
        data: { idempotencyKey, examHistoryId, questionUid, answerVersion, scores, mean, comment },
      })
      return { state: 'SYNCED' }
    })
  },
}
