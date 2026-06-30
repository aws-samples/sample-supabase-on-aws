import { describe, it, expect, beforeAll } from 'vitest'

// getEnv() validates required env vars lazily on first call. Set them before
// the crypto module reads ENCRYPTION_KEY.
beforeAll(() => {
  process.env.ADMIN_API_KEY = 'test-admin-key'
  process.env.JWT_SECRET = 'test-jwt-secret'
  process.env.ENCRYPTION_KEY = 'test-encryption-key-0123456789'
  process.env.AWS_REGION = 'us-east-1'
})

describe('encryption', () => {
  it('round-trips a secret', async () => {
    const { encryptSecret, decryptSecret } = await import('../../src/common/crypto/encryption.js')
    const plain = 'GOCSPX-super-secret-value'
    const cipher = encryptSecret(plain)

    expect(cipher).not.toBe(plain)
    expect(decryptSecret(cipher)).toBe(plain)
  })

  it('uses a random IV so two encryptions of the same value differ', async () => {
    const { encryptSecret, decryptSecret } = await import('../../src/common/crypto/encryption.js')
    const plain = 'same-value'

    const a = encryptSecret(plain)
    const b = encryptSecret(plain)

    expect(a).not.toBe(b)
    // both still decrypt back to the original
    expect(decryptSecret(a)).toBe(plain)
    expect(decryptSecret(b)).toBe(plain)
  })

  it('handles unicode and empty-ish values', async () => {
    const { encryptSecret, decryptSecret } = await import('../../src/common/crypto/encryption.js')
    for (const plain of ['a', 'café-🔐-密钥', ' ']) {
      expect(decryptSecret(encryptSecret(plain))).toBe(plain)
    }
  })
})
