import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const deriveKey = promisify(scrypt)
const keyLength = 64

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  const key = await deriveKey(password, salt, keyLength) as Buffer
  return salt + ':' + key.toString('hex')
}

export async function verifyPassword(password: string, hash?: string) {
  const [salt, expected] = hash?.split(':') ?? []
  const key = await deriveKey(password, salt ?? 'unknown-user-salt', keyLength) as Buffer
  const reference = Buffer.from(expected ?? '', 'hex')
  return reference.length === key.length && timingSafeEqual(key, reference)
}

export function newSessionToken() {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}
