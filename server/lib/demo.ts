export const DEMO_ROUND = {
  examUid: 'E1267933648299773952',
  examRoundUid: 'ER1312416130135052288',
  name: 'IELTS 机考 · Round9（模拟）',
}

const writingFixtures = [
  {
    historyId: 880001,
    studentCode: 'DEMO-001',
    sourceStatus: '已批改',
    teacher: 1,
    essay: 'City parks should be accessible to everyone. Public spaces matter. 🌱\n\n'
      + 'Free access helps people exercise without paying for a gym. It also gives families a place to meet. '
      + 'However, maintenance costs can rise if a park attracts more visitors.\n\n'
      + 'Local councils could fund basic maintenance through their general budgets. Public spaces matter.',
    aiFails: false,
    firstSyncFails: false,
  },
  {
    historyId: 880002,
    studentCode: 'DEMO-002',
    sourceStatus: '未批改',
    teacher: 1,
    essay: 'I think public parks should be free for all visitors. They are places where children and adults can relax.\n\n'
      + 'Parks cost money to maintain. Cities could pay for maintenance through their budgets and collect donations '
      + 'for optional activities. This would keep the park available to people with different incomes.',
    aiFails: true,
    firstSyncFails: true,
  },
  {
    historyId: 880003,
    studentCode: 'DEMO-003',
    sourceStatus: '未批改',
    teacher: 2,
    essay: 'Public parks should be free because everyone needs a safe place to walk and exercise.\n\n'
      + 'Local councils can set aside part of their budget for cleaning and repairs. '
      + 'A small fee for private events could cover some of those costs.',
    aiFails: false,
    firstSyncFails: false,
  },
]

const writingSection = 42014
const taskOneUid = 'demo-task-1'
export const taskTwoUid = 'demo-task-2'

export const demoTasks = writingFixtures.map((fixture, index) => ({
  id: 'demo-writing-' + (index + 1),
  examUid: DEMO_ROUND.examUid,
  examRoundUid: DEMO_ROUND.examRoundUid,
  examHistoryId: String(fixture.historyId),
  questionUid: taskTwoUid,
  teacherId: 'demo-teacher-' + fixture.teacher,
}))

export const demoVersion = 'demo-answer-v1'

export const demoList = {
  code: 'success',
  data: {
    totalCount: writingFixtures.length + 1,
    data: [
      ...writingFixtures.map(fixture => ({
        examHistoryId: String(fixture.historyId),
        examSubject: '11,12,14',
        studentCode: fixture.studentCode,
        correctStatusTitle: fixture.sourceStatus,
      })),
      { examHistoryId: '880099', examSubject: '13', studentCode: 'DEMO-SPK', correctStatusTitle: '未批改' },
    ],
  },
}

const demoQuizzes = [
  { uid: taskOneUid, quizSeq: 1, htmlContent: '<p>Task 1. Summarise the data shown in the table.</p>' },
  {
    uid: taskTwoUid,
    quizSeq: 2,
    htmlContent: '<h2>Writing Task 2</h2><p>Some people think city parks should be free for all visitors. '
      + 'Others believe visitors should pay to help maintain them.</p>'
      + '<p>Discuss both views and give your own opinion.</p>',
  },
]

export function demoCard(examHistoryId: string) {
  const fixture = writingFixtures.find(item => String(item.historyId) === examHistoryId)
  if (!fixture) return null

  return {
    code: 'success',
    data: {
      examHistoryId: fixture.historyId,
      paperAnswerHistoryList: [
        { examSubject: 11, examVolSubId: 42011, answerHistoryList: [] },
        {
          examSubject: 14,
          examVolSubId: writingSection,
          examStatus: 2,
          task2Score: null,
          answerHistoryList: [
            { questionUid: taskOneUid, questionAnswerList: ['A fictional Task 1 answer.'] },
            { questionUid: taskTwoUid, questionAnswerList: [fixture.essay] },
          ],
        },
      ],
      volQuizzesDTOList: [{ examVolSubId: writingSection, answerQuizs: demoQuizzes }],
    },
  }
}

export function demoBehavior(examHistoryId: string) {
  return writingFixtures.find(item => String(item.historyId) === examHistoryId)
}
