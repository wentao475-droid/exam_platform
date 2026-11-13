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
| `POST /api/tasks/:id/ai` | `{ answerVersion, regenerate? }` | 更新后的任务详情，`regenerate: true` 重新运行单篇 AI 批改 |
| `PUT /api/tasks/:id/draft` | `{ answerVersion, revision, scores, comment }` | 更新后的任务详情 |
| `POST /api/tasks/:id/submit` | `{ answerVersion, revision }` | 包含正式快照和回写状态的任务详情 |
| `POST /api/tasks/:id/retry` | `{}` | 更新后的任务详情 |

轮次页用 `Accept: application/x-ndjson` 分批接收任务。第一行 `round` 包含轮次信息和候选答卷数。后续 `tasks` 行包含新增任务及已检查答卷数，最后一行为 `done`。中途失败返回 `error`，已收到的任务仍可查看。默认请求仍返回完整的 JSON 轮次。

`scores` 的四个字段为 `tr`、`cc`、`lr`、`gra`，对应 Task Response、Coherence and Cohesion、Lexical Resource、Grammatical Range and Accuracy。保存草稿仅校验本地已知的答卷版本和草稿修订号，不读取原平台；确认提交时校验原平台最新答卷版本后才回传。确认操作提交已保存的草稿，冻结确认时的分数、均值和评语。重试沿用该快照的幂等键。

任务状态分为 `PENDING`、`DRAFT` 和 `CONFIRMED`。回写状态独立返回 `NOT_SUBMITTED`、`PENDING`、`SYNCING`、`SYNCED`、`FAILED` 或 `CONFLICT`。回写失败或冲突以任务详情中的状态和消息表示。AI 调用失败以 HTTP 错误表示，教师仍可提交手工评分。草稿修订冲突时重新读取任务，再编辑最新版本。

整轮 AI 批改根据轮次和当前教师的授权范围选择任务，结果分为 `graded`、`skipped` 和 `failed`。重新发起同一轮时跳过已有同版本 AI 结果的任务，失败项可以继续尝试。任务摘要以 `aiStatus` 表示是否已有 AI 结果。任务详情的 `ai.teacherComment` 可用于预填评语；已保存的教师草稿优先。

`readMode` 为 `demo` 或 `live`，会话、轮次与任务详情均返回该字段。`live` 表示原平台答卷只读接入；AI 批改按 `AI_PROVIDER` 配置。上游读取错误只向前端返回本地定义的状态和提示。

回写由 `EXAM_LIVE_WRITE` 控制，默认关闭（只核对版本、不写入）。设为 `1` 后，确认提交调用原平台写接口写入真实成绩：

| 写入内容 | 请求 | 说明 |
| --- | --- | --- |
| 成绩与批改 | `POST /management/BizVisioncup/v1/api/visioncup/exam/manualCorrect` | 请求体 `{ examHistoryId, scoreLevel, comment, volList }`：顶层 `scoreLevel` 为总分（一位小数）、`comment` 为评语，各分卷回传 `examHistoryPaperId`、`examVolSubId`、`scoreLevel`（项目分）、`task1Score`、`task2Score` 与 `examManualCorrectQuizDTOList` |

写作分卷（`examSubject=14`）写入四维均分 `task2Score`、按两题均值雅思取整的 `scoreLevel`（规则待原平台确认）和 Task 2 的 `correctContent` 批改内容；口语分卷（`examSubject=13`）写入整场四维均分作为分卷 `scoreLevel`，`task1Score`/`task2Score` 保持原值。顶层 `scoreLevel`（总分）仅在答卷只有一个可阅卷分卷、且听力/阅读分卷尚无分数时写入该科目档位，同时含多科目成绩的答卷按答题卡原值回传。听力、阅读分卷按答题卡原值回传。顶层 `comment` 为教师评语，必须与 `scoreLevel` 一起提交——缺这两项时平台仍返回 `success` 但不落成绩。提交前重新读取答题卡核对答卷版本，版本变化返回 `CONFLICT`；授权失败、网络失败或原平台返回非 `success` 均为 `FAILED`，可安全重试；已 `SYNCED` 的确认记录也可重新回写（幂等键不变，答案变更转 `CONFLICT`）。

## 原考试平台对接

已核对的样例包含列表与答题卡两份响应。上游读取目标固定为 `https://portal.visioneschool.com`。

| 读取内容 | 请求 | 参数 |
| --- | --- | --- |
| 轮次列表 | `POST /management/BizVisioncup/examQuery/pageExamHistoryInfo` | JSON 请求体 `{ pageNumber, pageSize, examCategory, examRounds: [examRoundUid] }`，`examCategory` 使用 IELTS 的 `4` |
| 答题卡 | `GET /management/BizVisioncup/examQuery/exam/getExamVolQuizzesAndAnswerFile` | 查询参数 `examHistoryId`，取自上一请求 |

按组合卷科目码 `14` 筛选 Writing，再以字符串化的 `examHistoryId` 关联答题卡。通过 `examVolSubId` 匹配分卷，通过题目 `uid` 与作答 `questionUid` 匹配 Task 2，读取 `questionAnswerList`。当前接入以题目及正文内容生成校验版本。原样例的 `volVersion` 是试卷版本，真实作答版本字段待确认。

首次联调用已授权的测试账号与测试答卷核对分页、空答卷、教师访问范围和平台实际要求的服务端授权。回写接入已按抓包实现，仍需与原平台确认：`scoreLevel` 的计算规则、`correctContent` 期望的内容格式，以及原平台何时生成报告和向学生发布成绩。
