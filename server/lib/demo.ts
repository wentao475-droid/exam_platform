export const DEMO_ROUND = {
  examUid: 'E1267933648299773952',
  examRoundUid: 'ER1312416130135052288',
  name: 'IELTS 机考 · Round9（模拟）',
}

export const taskOneUid = 'demo-task-1'
export const taskTwoUid = 'demo-task-2'
export const demoSpeakingUid = 'demo-speaking-1'

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
    task1Answer: 'The bar chart shows how many people visited four types of attractions in one city in 2019.\n\n'
      + 'Overall, the museum was the most popular attraction, while the library received the fewest visits.\n\n'
      + 'The museum attracted 130 thousand visitors, which was the highest figure. The zoo came second with 100 thousand, '
      + 'and the gallery followed with 85 thousand. The library recorded 60 thousand visits, the lowest of the four.',
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
    task1Answer: 'The chart compares visitor numbers across four attractions.\n\n'
      + 'The museum had the most visitors at 130 thousand. The zoo and the gallery had 100 thousand and 85 thousand. '
      + 'The library had the least, at 60 thousand.',
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
    task1Answer: 'The bar chart gives information about city attractions.\n\n'
      + 'Museums were the most visited place with 130 thousand people. Zoos had 100 thousand and galleries had 85 thousand. '
      + 'Libraries were the least popular with only 60 thousand visitors.',
    aiFails: false,
    firstSyncFails: false,
  },
]

const speakingFixtures = [
  {
    historyId: 880099,
    studentCode: 'DEMO-SPK',
    sourceStatus: '未批改',
    teacher: 1,
    transcript: 'Examiner: Describe a place you like to visit. You should say where it is, how often you go there, and why you like it.\n\n'
      + 'Well, my favourite place is a small library near my home. I usually go there on weekends, maybe two or three times a month. '
      + 'The library is quiet and the staff are friendly. A small reading room by the window is my favourite spot.\n\n'
      + 'I like it because I can focus on my study there. Also, many students visit it, so I can share notes with them after reading.',
    aiFails: false,
    firstSyncFails: false,
  },
]

const writingSection = 42014
const speakingSection = 42013

export const demoTasks = [
  ...writingFixtures.map((fixture, index) => ({
    id: 'demo-writing-' + (index + 1),
    examUid: DEMO_ROUND.examUid,
    examRoundUid: DEMO_ROUND.examRoundUid,
    examHistoryId: String(fixture.historyId),
    questionUid: taskTwoUid,
    kind: 'task2',
    teacherId: 'demo-teacher-' + fixture.teacher,
  })),
  ...writingFixtures.map((fixture, index) => ({
    id: 'demo-writing-' + (index + 1) + '-task1',
    examUid: DEMO_ROUND.examUid,
    examRoundUid: DEMO_ROUND.examRoundUid,
    examHistoryId: String(fixture.historyId),
    questionUid: taskOneUid,
    kind: 'task1',
    teacherId: 'demo-teacher-' + fixture.teacher,
  })),
  ...speakingFixtures.map((fixture, index) => ({
    id: 'demo-speaking-' + (index + 1),
    examUid: DEMO_ROUND.examUid,
    examRoundUid: DEMO_ROUND.examRoundUid,
    examHistoryId: String(fixture.historyId),
    questionUid: demoSpeakingUid,
    kind: 'speaking',
    teacherId: 'demo-teacher-' + fixture.teacher,
  })),
]

export const demoVersion = 'demo-answer-v1'

export const demoList = {
  code: 'success',
  data: {
    totalCount: writingFixtures.length + speakingFixtures.length,
    data: [
      ...writingFixtures.map(fixture => ({
        examHistoryId: String(fixture.historyId),
        examSubject: '11,12,14',
        studentCode: fixture.studentCode,
        correctStatusTitle: fixture.sourceStatus,
      })),
      ...speakingFixtures.map(fixture => ({
        examHistoryId: String(fixture.historyId),
        examSubject: '13',
        studentCode: fixture.studentCode,
        correctStatusTitle: fixture.sourceStatus,
      })),
    ],
  },
}

// A simple bar chart rendered as inline SVG so the Task 1 demo works offline.
const chartSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="240">'
  + '<rect width="420" height="240" fill="#ffffff"/>'
  + '<rect x="50" y="110" width="60" height="90" fill="#4a7dc4"/>'
  + '<rect x="150" y="60" width="60" height="140" fill="#4a7dc4"/>'
  + '<rect x="250" y="90" width="60" height="110" fill="#4a7dc4"/>'
  + '<rect x="350" y="130" width="60" height="70" fill="#4a7dc4"/>'
  + '<line x1="40" y1="200" x2="415" y2="200" stroke="#333"/>'
  + '<text x="52" y="218" font-size="13">Museum 130k</text>'
  + '<text x="152" y="218" font-size="13">Zoo 100k</text>'
  + '<text x="248" y="218" font-size="13">Gallery 85k</text>'
  + '<text x="344" y="218" font-size="13">Library 60k</text>'
  + '</svg>'
const chartImageSrc = 'data:image/svg+xml;base64,' + Buffer.from(chartSvg, 'utf8').toString('base64')

const demoQuizzes = [
  {
    uid: taskOneUid,
    quizSeq: 1,
    htmlContent: '<p>Task 1. The chart below shows visitor numbers at four city attractions in 2019.</p>'
      + `<img src="${chartImageSrc}" alt="2019 年四类场所参观人数柱状图">`,
  },
  {
    uid: taskTwoUid,
    quizSeq: 2,
    htmlContent: '<h2>Writing Task 2</h2><p>Some people think city parks should be free for all visitors. '
      + 'Others believe visitors should pay to help maintain them.</p>'
      + '<p>Discuss both views and give your own opinion.</p>',
  },
]

const demoSpeakingQuiz = [{
  uid: demoSpeakingUid,
  quizSeq: 1,
  htmlContent: '<h2>Speaking Part 2</h2><p>Describe a place you like to visit. '
    + 'You should say where it is, how often you go there, and why you like it.</p>',
}]

export function demoCard(examHistoryId: string) {
  const speaking = speakingFixtures.find(item => String(item.historyId) === examHistoryId)
  if (speaking) {
    return {
      code: 'success',
      data: {
        examHistoryId: speaking.historyId,
        paperAnswerHistoryList: [{
          examSubject: 13,
          examVolSubId: speakingSection,
          answerHistoryList: [{ questionUid: demoSpeakingUid, questionAnswerList: [speaking.transcript] }],
        }],
        volQuizzesDTOList: [{ examVolSubId: speakingSection, answerQuizs: demoSpeakingQuiz }],
      },
    }
  }

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
            { questionUid: taskOneUid, questionAnswerList: [fixture.task1Answer] },
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
    ?? speakingFixtures.find(item => String(item.historyId) === examHistoryId)
}
