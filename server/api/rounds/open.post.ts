import { defineEventHandler, getRequestHeader, sendIterable, setResponseHeader } from 'h3'
import { roundStreamType, type RoundLoadEvent } from '../../../shared/grading'
import { loadRound, openRound } from '../../lib/grading'
import { roundBody } from '../../lib/validation'
import { parseBody } from '../../utils/grading-request'
import { requireTeacher, validateWriteOrigin } from '../../utils/grading-session'

export default defineEventHandler(async event => {
  validateWriteOrigin(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const teacher = await requireTeacher(event)
  const { url } = await parseBody(event, roundBody)
  if (getRequestHeader(event, 'accept') !== roundStreamType) return await openRound(url, teacher.id)

  const controller = new AbortController()
  event.node.res.once('close', () => controller.abort())
  const updates = loadRound(url, teacher.id, controller.signal)
  // Preserve normal HTTP errors until the round and its source list are validated.
  const first = await updates.next()
  setResponseHeader(event, 'Content-Type', roundStreamType + '; charset=utf-8')
  setResponseHeader(event, 'X-Accel-Buffering', 'no')
  async function* events(): AsyncGenerator<RoundLoadEvent> {
    if (first.done) return
    yield first.value
    try {
      yield* updates
    } catch {
      yield { type: 'error', message: '部分答卷暂未加载完成，请重新加载轮次。' }
    }
  }
  return await sendIterable(event, events(), { serializer: update => JSON.stringify(update) + '\n' })
})
