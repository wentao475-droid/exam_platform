// 遍历轮次全部答卷，按题干特征汇总科目题目 UID（20 minutes → task1，40 minutes → task2）。
// 用法：node --env-file=.env --import tsx scripts/inspect-round.ts [Round7] [--all]
const origin = 'https://portal.visioneschool.com'
const base = origin + '/management/BizVisioncup/examQuery'
const headers = {
  accept: 'application/json',
  'content-type': 'application/json',
  'v-token': process.env.EXAM_PLATFORM_V_TOKEN!,
  'v-token-type': process.env.EXAM_PLATFORM_V_TOKEN_TYPE || 'e-n-p',
}
const rounds: Array<Record<string, unknown>> = JSON.parse(process.env.EXAM_LIVE_ROUNDS ?? '[]')
const want = process.argv[2] ?? 'Round7'
const round = rounds.find(r => String(r.name).includes(want))
if (!round) throw new Error('未找到轮次 ' + want)
console.log('轮次:', round.name)

const historyIds: string[] = []
for (let page = 1; page <= 10; page++) {
  const res = await fetch(base + '/pageExamHistoryInfo', {
    method: 'POST',
    headers,
    body: JSON.stringify({ pageNumber: page, pageSize: 100, examCategory: 4, examRounds: [round.examRoundUid] }),
  })
  const body = await res.json() as any
  const rows: any[] = body?.data?.data ?? []
  historyIds.push(...rows.map(r => String(r.examHistoryId)))
  if (historyIds.length >= Number(body?.data?.totalCount ?? 0)) break
}
console.log('答卷数:', historyIds.length)

const found = new Map<string, { kind: string; count: number; hasImg: boolean }>()
for (const historyId of historyIds) {
  const res = await fetch(base + '/exam/getExamVolQuizzesAndAnswerFile?' + new URLSearchParams({ examHistoryId: historyId }), { headers })
  const card = await res.json() as any
  if (card?.code !== 'success') { console.log('答卷', historyId, '读取失败'); continue }
  for (const vol of card.data.volQuizzesDTOList ?? []) {
    for (const quiz of vol.answerQuizs ?? []) {
      const html = String(quiz.htmlContent ?? quiz.content ?? '')
      const text = html.replace(/<[^>]+>/g, '')
      const kind = /40 minutes/.test(text) ? 'task2' : /20 minutes/.test(text) ? 'task1' : 'other'
      const key = quiz.uid
      const prev = found.get(key)
      found.set(key, { kind, count: (prev?.count ?? 0) + 1, hasImg: (prev?.hasImg ?? false) || /<img/i.test(html) })
    }
  }
}
for (const [uid, info] of [...found].sort((a, b) => a[1].kind.localeCompare(b[1].kind))) {
  console.log(info.kind, '|', uid, '| 出现答卷数:', info.count, '| 含图:', info.hasImg)
}
