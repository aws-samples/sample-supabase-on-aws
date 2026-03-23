/**
 * Unit tests for API key generator
 */

import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import {
  generateOpaqueKey,
  generateApiKeyJwt,
  resignApiKeyJwt,
} from '../../src/common/crypto/api-key-generator.js'

describe('api-key-generator', () => {
  describe('generateOpaqueKey', () => {
    it('should generate a publishable key with correct prefix', () => {
      const result = generateOpaqueKey('publishable')
      expect(result.opaqueKey).toMatch(/^sb_publishable_[A-Za-z0-9]{32}$/)
      expect(result.prefix).toMatch(/^sb_publishable_[A-Za-z0-9]{8}$/)
      expect(result.hashedSecret).toHaveLength(64) // SHA-256 hex
    })

    it('should generate a secret key with correct prefix', () => {
      const result = generateOpaqueKey('secret')
      expect(result.opaqueKey).toMatch(/^sb_secret_[A-Za-z0-9]{32}$/)
      expect(result.prefix).toMatch(/^sb_secret_[A-Za-z0-9]{8}$/)
    })

    it('should generate unique keys', () => {
      const keys = new Set<string>()
      for (let i = 0; i < 100; i++) {
        keys.add(generateOpaqueKey('publishable').opaqueKey)
      }
      expect(keys.size).toBe(100)
    })

    it('should generate different hashes for different keys', () => {
      const a = generateOpaqueKey('publishable')
      const b = generateOpaqueKey('publishable')
      expect(a.hashedSecret).not.toBe(b.hashedSecret)
    })
  })

  describe('generateApiKeyJwt', () => {
    const jwtSecret = 'test-secret-for-jwt-signing'
    const keyId = '550e8400-e29b-41d4-a716-446655440000'
    const apiKeyId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

    it('should generate a valid JWT with correct payload', () => {
      const token = generateApiKeyJwt({
        projectRef: 'test-project',
        role: 'anon',
        jwtSecret,
        keyId,
        apiKeyId,
      })

      const decoded = jwt.verify(token, jwtSecret) as jwt.JwtPayload
      expect(decoded.iss).toBe('supabase')
      expect(decoded['ref']).toBe('test-project')
      expect(decoded['role']).toBe('anon')
      expect(decoded['api_key_id']).toBe(apiKeyId)
    })

    it('should include kid in JWT header', () => {
      const token = generateApiKeyJwt({
        projectRef: 'test-project',
        role: 'anon',
        jwtSecret,
        keyId,
        apiKeyId,
      })

      const decoded = jwt.decode(token, { complete: true })
      expect(decoded?.header.kid).toBe(keyId)
      expect(decoded?.header.alg).toBe('HS256')
    })

    it('should set expiration to ~10 years', () => {
      const token = generateApiKeyJwt({
        projectRef: 'test-project',
        role: 'service_role',
        jwtSecret,
        keyId,
        apiKeyId,
      })

      const decoded = jwt.verify(token, jwtSecret) as jwt.JwtPayload
      const now = Math.floor(Date.now() / 1000)
      const tenYearsInSeconds = 10 * 365 * 24 * 60 * 60
      expect(decoded.exp! - now).toBeGreaterThan(tenYearsInSeconds - 60)
      expect(decoded.exp! - now).toBeLessThan(tenYearsInSeconds + 60)
    })
  })

  describe('resignApiKeyJwt', () => {
    it('should re-sign a JWT with a new secret and key ID', () => {
      const oldSecret = 'old-jwt-secret'
      const newSecret = 'new-jwt-secret'
      const oldKeyId = 'old-key-id'
      const newKeyId = 'new-key-id'
      const apiKeyId = 'test-api-key-id'

      const originalJwt = generateApiKeyJwt({
        projectRef: 'test-project',
        role: 'anon',
        jwtSecret: oldSecret,
        keyId: oldKeyId,
        apiKeyId,
      })

      // Verify original JWT works with old secret
      expect(() => jwt.verify(originalJwt, oldSecret)).not.toThrow()

      const resignedJwt = resignApiKeyJwt({
        originalJwt,
        newJwtSecret: newSecret,
        newKeyId,
      })

      // Verify re-signed JWT works with new secret
      const decoded = jwt.verify(resignedJwt, newSecret) as jwt.JwtPayload
      expect(decoded['role']).toBe('anon')
      expect(decoded['ref']).toBe('test-project')
      expect(decoded['api_key_id']).toBe(apiKeyId)

      // Verify it has the new kid
      const headers = jwt.decode(resignedJwt, { complete: true })
      expect(headers?.header.kid).toBe(newKeyId)

      // Verify old secret no longer works
      expect(() => jwt.verify(resignedJwt, oldSecret)).toThrow()
    })

    it('should preserve the original payload fields', () => {
      const secret = 'test-secret'
      const keyId = 'key-1'
      const apiKeyId = 'api-key-1'

      const original = generateApiKeyJwt({
        projectRef: 'my-project',
        role: 'service_role',
        jwtSecret: secret,
        keyId,
        apiKeyId,
      })

      const originalDecoded = jwt.verify(original, secret) as jwt.JwtPayload

      const newSecret = 'new-secret'
      const newKeyId = 'key-2'
      const resigned = resignApiKeyJwt({
        originalJwt: original,
        newJwtSecret: newSecret,
        newKeyId,
      })

      const resignedDecoded = jwt.verify(resigned, newSecret) as jwt.JwtPayload
      expect(resignedDecoded.iss).toBe(originalDecoded.iss)
      expect(resignedDecoded.iat).toBe(originalDecoded.iat)
      expect(resignedDecoded.exp).toBe(originalDecoded.exp)
      expect(resignedDecoded['ref']).toBe(originalDecoded['ref'])
      expect(resignedDecoded['role']).toBe(originalDecoded['role'])
      expect(resignedDecoded['api_key_id']).toBe(originalDecoded['api_key_id'])
    })
  })
})
