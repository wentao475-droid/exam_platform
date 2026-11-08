# AI Grading Workspace

面向教师的 IELTS Writing Task 2 阅卷工作台。通过考试轮次定位答卷，一键生成整轮模拟 AI 评分、原文批注和教师评语初稿，保存教师草稿，确认成绩并查看模拟回写结果。页面使用 Nuxt、Vue 3 和 Element Plus，草稿、确认记录和模拟回执保存在 PostgreSQL。

## 本地启动

需要 Node.js 22.22.3+ 或 24.15.0+（使用对应的偶数主版本）、npm，以及可连接的 PostgreSQL。仓库提供 PostgreSQL 16 的 Docker Compose 配置。

```bash
npm ci
cp .env.example .env
docker compose up -d --wait db
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev -- --host 127.0.0.1
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。如果已有 PostgreSQL，可在 `.env` 填写对应的 `DATABASE_URL`，数据库连接后从生成 Prisma 客户端开始操作。演示数据库应单独创建。

### 在 ExFAT 移动硬盘上的工作区

npm 和 Nuxt 需要支持符号链接的文件系统。可以在当前仓库内执行以下命令，把源码同步到 Mac 内置盘后再安装、运行。继续修改源仓库后，可重复运行同一条同步命令。

```bash
grading_workspace="$HOME/Library/Caches/ai-grading-workspace-dev/workspace"
mkdir -p "$grading_workspace"
rsync -rt --delete --exclude '.git' --exclude '._*' --exclude '.DS_Store' \
  --exclude 'node_modules' --exclude '.nuxt' --exclude '.output' \
  --exclude '.env' --exclude '.env.local' --exclude '.env.live' --exclude 'test-results' ./ "$grading_workspace/"
cd "$grading_workspace"
```

## 演示流程

1. 用 `teacher1@example.test` 登录，密码为 `demo-teacher-2026`。选择内置演示轮次或粘贴该轮次链接。演示轮次中的学生、答卷和评分均为虚构数据。
2. 在轮次任务列表点击「AI 批改」。系统处理当前轮次内分配给该教师的所有可阅作文，列表筛选只改变显示。打开第一篇作文，查看 AI 评分和原文批注，核对预填的教师评语。可以编辑评语和四维分，保存草稿后刷新检查内容是否恢复。确认提交后查看模拟回写成功。
3. 第二篇作文演示 AI 失败后手工阅卷，以及模拟回写失败后重试。保存草稿并确认，看到首次模拟回写失败后点击重试。
4. 用 `teacher2@example.test` 和同一演示密码登录，验证该教师只可见分配给自己的答卷。

重新运行整轮 AI 批改时，已完成 AI 批改且作答版本相同的作文会跳过，失败的作文可以再次尝试。AI 评语预填到没有教师草稿的作文中，教师已保存的评语会保留。教师独立填写四维分并确认提交。

所有演示账号、回写目标和评分规则仅用于本地验收。原考试平台的整卷状态独立展示。0–9 分、0.5 步长为本地演示设置，均值按四项等权保存。教师在确认前可以继续修改草稿。确认后以保存的评分快照为准。

默认使用一个演示轮次和固定 Task 2 题目。真实读取使用单独配置，评分和回写仍采用模拟服务。

## 真实答卷读取

启用前，请在原平台结束已暴露的会话，由平台管理员提供新签发、获准用于联调的只读凭证。凭证只在本机服务端环境中配置。`.env.example` 记录配置字段，实际的 `.env` 保存在本地。

1. 为获准的教师创建独立账号。运行一次下方命令前，通过本机环境设置 `EXAM_LIVE_TEACHER_EMAIL`、`EXAM_LIVE_TEACHER_NAME`、`EXAM_LIVE_TEACHER_PASSWORD`。创建后清理临时密码配置。

   ```bash
   node --env-file=.env --import tsx prisma/provision-live-teacher.ts
   ```

2. 在本机 `.env` 设置 `EXAM_READ_MODE=live` 和新签发的 `EXAM_PLATFORM_V_TOKEN`。`EXAM_PLATFORM_V_TOKEN_TYPE` 默认 `e-n-p`。若原平台管理员确认还需要 Cookie，可配置 `EXAM_PLATFORM_COOKIE`。
3. 在 `.env` 的 `EXAM_LIVE_ROUNDS` 填写 JSON 数组，为每个轮次指定 `examUid`、`examRoundUid`、展示名称 `name`、获准的 `teacherEmail`，以及试卷明确的 `taskTwoQuestionUids`。每个轮次配置一位教师。首次联调建议填写 `examHistoryIds`，限制在已授权的测试答卷。使用 `.env.example` 的结构示例，替换所有占位值。
4. 重启阅卷台，用该教师账号登录，粘贴已配置的轮次链接，用一篇 Writing 测试答卷核对题目与原文。真实读取时，AI 评分和成绩回写依然是模拟操作，原平台的成绩发布由原平台控制。切回 `EXAM_READ_MODE=demo` 并重启可恢复演示流程。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

PostgreSQL 集成测试使用独立的 `grading_test` 数据库。用 Compose 启动数据库后，首次执行 `docker compose exec -T db createdb -U grading grading_test`，随后运行以下命令。测试会重置该库中的演示阅卷记录。

```bash
(
  export DATABASE_URL='postgresql://grading:grading@127.0.0.1:55432/grading_test?schema=public'
  npm run db:migrate
  npm run db:seed
  GRADING_INTEGRATION=1 npm test
)
```

本地验收覆盖了 Chrome 中的轮次加载、批注定位、服务重启后恢复草稿、手工评分和模拟回写重试。PostgreSQL 集成测试另行验证并发草稿、重复提交、回写超时恢复、答卷版本冲突和任务权限。

正式接入的字段、请求方式和验收待办见 [接口说明](docs/api.md)。
