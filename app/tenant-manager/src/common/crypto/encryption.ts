/**
 * AES encryption utilities with improved security (random IV)
 * Maintains backward compatibility with legacy fixed-IV format
 */

import crypto from 'crypto'
import { getEnv } from '../../config/index.js'

const ALGORITHM = 'aes-256-cbc'
const IV_LENGTH = 16

/**
 * Derive a 256-bit key from the encryption key string
 */
function deriveKey(keyString: string): Buffer {
  return crypto.createHash('sha256').update(keyString).digest()
}

/**
 * Encrypt a string using AES-256-CBC with random IV
 * Output format: base64(IV + ciphertext)
 */
export function encryptSecret(secret: string): string {
  const env = getEnv()
  const key = deriveKey(env.ENCRYPTION_KEY)
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(secret, 'utf8')
  encrypted = Buffer.concat([encrypted, cipher.final()])
  // Prepend IV to ciphertext
  const combined = Buffer.concat([iv, encrypted])
  return combined.toString('base64')
}

/**
 * Decrypt a string encrypted with the new format (random IV)
 * Or the legacy format (fixed IV)
 */
export function decryptSecret(encrypted: string): string {
  const env = getEnv()
  const key = deriveKey(env.ENCRYPTION_KEY)

  const data = Buffer.from(encrypted, 'base64')

  // New format: first 16 bytes are IV, rest is ciphertext
  // Legacy format: entire buffer is ciphertext (IV was all zeros)
  // We try new format first, fall back to legacy
  try {
    if (data.length > IV_LENGTH) {
      const iv = data.subarray(0, IV_LENGTH)
      const ciphertext = data.subarray(IV_LENGTH)
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
      let decrypted = decipher.update(ciphertext)
      decrypted = Buffer.concat([decrypted, decipher.final()])
      return decrypted.toString('utf8')
    }
  } catch {
    // Fall through to legacy format
  }

  // Legacy format: fixed zero IV
  return decryptSecretLegacy(encrypted, key)
}

/**
 * Decrypt using legacy format (fixed zero IV)
 * Used for backward compatibility with existing encrypted data
 */
function decryptSecretLegacy(encrypted: string, key: Buffer): string {
  const iv = Buffer.alloc(IV_LENGTH, 0)
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  let decrypted = decipher.update(encrypted, 'base64', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}
