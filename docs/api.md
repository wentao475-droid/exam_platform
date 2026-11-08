# 阅卷台 API

本地接口使用 JSON。登录后通过同源会话 Cookie 识别教师。教师只能读取和修改分配给自己的任务。响应结构定义在 `shared/grading.ts`。

| 请求 | 请求体 | 成功响应 |
| --- | --- | --- |
| `GET /api/session` | — | `{ user, readMode }`，未登录时 `user` 为 `null` |
| `POST /api/session` | `{ email, password }` | `{ user, readMode }` |
| `DELETE /api/session` | — | `{ user: null, readMode }` |
| `POST /api/rounds/open` | `{ url }` | 轮次信息和分配给该教师的任务摘要 |
| `POST /api/rounds/ai` | `{ url }` | `{ round, results }`，包含更新后的任务和本次批改结果 |
| `GET /api/tasks/:id` | — | 任务详情 |
| `POST /api/tasks/:id/ai` | `{ answerVersion }` | 更新后的任务详情 |
| `PUT /api/tasks/:id/draft` | `{ answerVersion, revision, scores, comment }` | 更新后的任务详情 |
| `POST /api/tasks/:id/submit` | `{ answerVersion, revision }` | 包含正式快照和回写状态的任务详情 |
| `POST /api/tasks/:id/retry` | `{}` | 更新后的任务详情 |

`scores` 的四个字段为 `tr`、`cc`、`lr`、`gra`，对应 Task Response、Coherence and Cohesion、Lexical Resource、Grammatical Range and Accuracy。保存时校验答卷版本和草稿修订号。确认操作提交已保存的草稿，冻结确认时的分数、均值和评语。重试沿用该快照的幂等键。

任务状态分为 `PENDING`、`DRAFT` 和 `CONFIRMED`。回写状态独立返回 `NOT_SUBMITTED`、`PENDING`、`SYNCING`、`SYNCED`、`FAILED` 或 `CONFLICT`。模拟回写失败或冲突以任务详情中的状态和消息表示。AI 调用失败以 HTTP 错误表示，教师仍可提交手工评分。草稿修订冲突时重新读取任务，再编辑最新版本。

整轮 AI 批改根据轮次和当前教师的授权范围选择任务，结果分为 `graded`、`skipped` 和 `failed`。重新发起同一轮时跳过已有同版本 AI 结果的任务，失败项可以继续尝试。任务摘要以 `aiStatus` 表示是否已有 AI 结果。任务详情的 `ai.teacherComment` 可用于预填评语；已保存的教师草稿优先。

`readMode` 为 `demo` 或 `live`，会话、轮次与任务详情均返回该字段。`live` 表示原平台答卷只读接入，AI 和回写仍为模拟。上游读取错误只向前端返回本地定义的状态和提示。

## 原考试平台对接

已核对的样例包含列表与答题卡两份响应。上游读取目标固定为 `https://portal.visioneschool.com`。

| 读取内容 | 请求 | 参数 |
| --- | --- | --- |
| 轮次列表 | `POST /management/BizVisioncup/examQuery/pageExamHistoryInfo` | JSON 请求体 `{ pageNumber, pageSize, examCategory, examRounds: [examRoundUid] }`，`examCategory` 使用 IELTS 的 `4` |
| 答题卡 | `GET /management/BizVisioncup/examQuery/exam/getExamVolQuizzesAndAnswerFile` | 查询参数 `examHistoryId`，取自上一请求 |

按组合卷科目码 `14` 筛选 Writing，再以字符串化的 `examHistoryId` 关联答题卡。通过 `examVolSubId` 匹配分卷，通过题目 `uid` 与作答 `questionUid` 匹配 Task 2，读取 `questionAnswerList`。当前接入以题目及正文内容生成校验版本。原样例的 `volVersion` 是试卷版本，真实作答版本字段待确认。

首次联调用已授权的测试账号与测试答卷核对分页、空答卷、教师访问范围和平台实际要求的服务端授权。正式回写仍需确认独立的接口与权限、Task 2 成绩字段和精度、作答版本与幂等规则，以及原平台何时生成报告和向学生发布成绩。真实 AI 模型另行接入。
