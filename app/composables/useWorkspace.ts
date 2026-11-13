import type { ReadMode, SessionUser } from '~~/shared/grading'

export function useWorkspace() {
  const teacher = useState<SessionUser | null>('workspace-teacher', () => null)
  const roundUrl = useState('workspace-round-url', () => '')
  const readMode = useState<ReadMode>('workspace-read-mode', () => 'demo')
  return { teacher, roundUrl, readMode }
}

const platformErrors: Record<string, string> = {
  LIVE_NOT_CONFIGURED: '真实数据读取尚未完成配置，请联系管理员。',
  LIVE_ROUND_FORBIDDEN: '当前教师账号未获授权读取该轮次，请确认链接或联系管理员。',
  LIVE_UPSTREAM_AUTH: '原考试平台的读取授权无效或已过期，请联系管理员更新。',
  LIVE_UPSTREAM_UNAVAILABLE: '暂时无法读取原考试平台，请稍后重试。',
}

export function requestError(error: unknown, fallback: string) {
  const failure = error as { status?: number; data?: { message?: string; statusMessage?: string; data?: { code?: string; message?: string } } } | undefined
  const code = failure?.data?.data?.code
  if (code && Object.hasOwn(platformErrors, code)) return platformErrors[code]!
  if (failure?.status === 401) return '登录已失效，请重新登录。'
  if (failure?.status === 403) return '当前账号无权执行此操作。'
  if (failure?.status && failure.status >= 500) return fallback
  return failure?.data?.data?.message || failure?.data?.message || failure?.data?.statusMessage || fallback
}
