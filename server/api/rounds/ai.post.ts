import { defineEventHandler, getRequestHeader, sendStream, setResponseHeader } from 'h3'
import { roundStreamType, type RoundAiEvent } from '../../../shared/grading'
import { requestRoundAi } from '../../lib/grading'
import { roundBody } from '../../lib/validation'
import { parseBody } from '../../utils/grading-request'
import { requireTeacher, validateWriteOrigin } from '../../utils/grading-session'

export default defineEventHandler(async event => {
  validateWriteOrigin(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const teacher = await requireTeacher(event)
  const { url } = await parseBody(event, roundBody)
  if (getRequestHeader(event, 'accept') !== roundStreamType) return await requestRoundAi(url, teacher.id)

  setResponseHeader(event, 'Content-Type', roundStreamType + '; charset=utf-8')
  setResponseHeader(event, 'X-Accel-Buffering', 'no')
  let disconnected = false
  let cancelled = false
  event.node.res.once('close', () => { disconnected = true })
  const stream = new ReadableStream<string>({
    start(controller) {
      const send = (update: RoundAiEvent) => {
        if (!disconnected) controller.enqueue(JSON.stringify(update) + '\n')
      }
      void requestRoundAi(url, teacher.id, send)
        .then(result => send({ type: 'done', result }))
        .catch((failure: { statusCode?: number; data?: { code?: string } }) =>
          send({ type: 'error', status: failure.statusCode, code: failure.data?.code }))
        .finally(() => { if (!cancelled) controller.close() })
    },
    cancel() {
      disconnected = true
      cancelled = true
    },
  })
  return await sendStream(event, stream)
})
