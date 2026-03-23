/**
 * Unit tests for key-generator and encryption
 */

import { describe, it, expect, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import {
  generateProjectRef,
  generateJwtSecret,
  isValidProjectRef,
  generateDbName,
  verifyApiKey,
} from '../../src/common/crypto/key-generator.js'
import { encryptSecret, decryptSecret } from '../../src/common/crypto/encryption.js'

// Mock the config module
vi.mock('../../src/config/index.js', () => ({
  getEnv: () => ({
    ENCRYPTION_KEY: 'test-encryption-key-32-characters!',
  }),
}))

describe('key-generator', () => {
  describe('generateProjectRef', () => {
    it('should generate a 20 character string', () => {
      const ref = generateProjectRef()
      expect(ref).toHaveLength(20)
    })

    it('should only contain lowercase alphanumeric characters', () => {
      const ref = generateProjectRef()
      expect(ref).toMatch(/^[a-z0-9]+$/)
    })

    it('should generate unique refs', () => {
      const refs = new Set<string>()
      for (let i = 0; i < 100; i++) {
        refs.add(generateProjectRef())
      }
      expect(refs.size).toBe(100)
    })
  })

  describe('generateJwtSecret', () => {
    it('should generate a base64 encoded string', () => {
      const secret = generateJwtSecret()
      expect(() => Buffer.from(secret, 'base64')).not.toThrow()
    })

    it('should generate unique secrets', () => {
      const secrets = new Set<string>()
      for (let i = 0; i < 100; i++) {
        secrets.add(generateJwtSecret())
      }
      expect(secrets.size).toBe(100)
    })
  })

  describe('isValidProjectRef', () => {
    it('should accept valid refs', () => {
      expect(isValidProjectRef('test-project')).toBe(true)
      expect(isValidProjectRef('myproject123')).toBe(true)
      expect(isValidProjectRef('a')).toBe(true)
      expect(isValidProjectRef('abc-def-123')).toBe(true)
    })

    it('should reject invalid refs', () => {
      expect(isValidProjectRef('')).toBe(false)
      expect(isValidProjectRef('Test-Project')).toBe(false) // uppercase
      expect(isValidProjectRef('test_project')).toBe(false) // underscore
      expect(isValidProjectRef('test project')).toBe(false) // space
      expect(isValidProjectRef('a'.repeat(65))).toBe(false) // too long
    })
  })

  describe('generateDbName', () => {
    it('should generate a valid database name', () => {
      expect(generateDbName('test-project')).toBe('project_test_project')
      expect(generateDbName('myproject123')).toBe('project_myproject123')
    })

    it('should replace hyphens with underscores', () => {
      expect(generateDbName('my-test-project')).toBe('project_my_test_project')
    })
  })

  describe('encryptSecret and decryptSecret', () => {
    it('should encrypt and decrypt a secret', () => {
      const original = 'my-super-secret-value'
      const encrypted = encryptSecret(original)
      const decrypted = decryptSecret(encrypted)

      expect(encrypted).not.toBe(original)
      expect(decrypted).toBe(original)
    })

    it('should produce different ciphertext for same plaintext (random IV)', () => {
      const secret = 'test-secret'
      const encrypted1 = encryptSecret(secret)
      const encrypted2 = encryptSecret(secret)

      // With random IV, they should be different
      expect(encrypted1).not.toBe(encrypted2)

      // But both should decrypt to the same value
      expect(decryptSecret(encrypted1)).toBe(secret)
      expect(decryptSecret(encrypted2)).toBe(secret)
    })
  })

  describe('verifyApiKey', () => {
    it('should verify a valid token', () => {
      const jwtSecret = generateJwtSecret()
      const token = jwt.sign({ role: 'anon', iss: 'supabase', ref: 'test-project' }, jwtSecret)

      const result = verifyApiKey(token, jwtSecret)
      expect(result).not.toBeNull()
      expect(result?.role).toBe('anon')
    })

    it('should return null for invalid token', () => {
      const result = verifyApiKey('invalid-token', 'some-secret')
      expect(result).toBeNull()
    })

    it('should return null for wrong secret', () => {
      const jwtSecret = generateJwtSecret()
      const token = jwt.sign({ role: 'anon', iss: 'supabase', ref: 'test-project' }, jwtSecret)

      const result = verifyApiKey(token, 'wrong-secret')
      expect(result).toBeNull()
    })
  })
})
