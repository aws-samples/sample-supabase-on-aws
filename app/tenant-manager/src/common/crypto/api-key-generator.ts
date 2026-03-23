/**
 * API key generation utilities for the multi-API-key system
 * Generates opaque keys with prefixes and corresponding JWTs
 */

import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import type { ApiKeyType } from '../../types/api-key.js'

const BASE62_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const OPAQUE_KEY_LENGTH = 32
const PREFIX_LENGTH = 8

/**
 * Generate a random base62 string of the specified length
 */
function randomBase62(length: number): string {
  const bytes = crypto.randomBytes(length)
  let result = ''
  for (let i = 0; i < length; i++) {
    result += BASE62_CHARS[bytes[i]! % BASE62_CHARS.length]
  }
  return result
}

/**
 * Generate an opaque API key with type prefix
 * Returns the full key, its prefix (for display), and a SHA-256 hash (for storage)
 */
export function generateOpaqueKey(type: ApiKeyType): {
  opaqueKey: string
  prefix: string
  hashedSecret: string
} {
  const prefixStr = type === 'publishable' ? 'sb_publishable_' : 'sb_secret_'
  const randomPart = randomBase62(OPAQUE_KEY_LENGTH)
  const opaqueKey = prefixStr + randomPart
  const displayPrefix = prefixStr + randomPart.slice(0, PREFIX_LENGTH)
  const hashedSecret = crypto.createHash('sha256').update(opaqueKey).digest('hex')

  return {
    opaqueKey,
    prefix: displayPrefix,
    hashedSecret,
  }
}

/**
 * Generate a JWT for an API key, signed with the project's JWT secret
 */
export function generateApiKeyJwt(params: {
  projectRef: string
  role: string
  jwtSecret: string
  keyId: string
  apiKeyId: string
}): string {
  const { projectRef, role, jwtSecret, keyId, apiKeyId } = params
  const now = Math.floor(Date.now() / 1000)
  const exp = now + 10 * 365 * 24 * 60 * 60 // 10 years

  return jwt.sign(
    {
      iss: 'supabase',
      iat: now,
      exp,
      ref: projectRef,
      role,
      api_key_id: apiKeyId,
    },
    jwtSecret,
    {
      header: {
        alg: 'HS256',
        typ: 'JWT',
        kid: keyId,
      },
    }
  )
}

/**
 * Re-sign an API key's JWT with a new secret and key ID
 * Preserves the original payload (iss, iat, exp, ref, role, api_key_id)
 */
export function resignApiKeyJwt(params: {
  originalJwt: string
  newJwtSecret: string
  newKeyId: string
}): string {
  const { originalJwt, newJwtSecret, newKeyId } = params
  const decoded = jwt.decode(originalJwt, { complete: true })

  if (!decoded || typeof decoded.payload === 'string') {
    throw new Error('Failed to decode original JWT for re-signing')
  }

  const payload = decoded.payload as jwt.JwtPayload

  return jwt.sign(
    {
      iss: payload.iss,
      iat: payload.iat,
      exp: payload.exp,
      ref: payload['ref'],
      role: payload['role'],
      api_key_id: payload['api_key_id'],
    },
    newJwtSecret,
    {
      header: {
        alg: 'HS256',
        typ: 'JWT',
        kid: newKeyId,
      },
    }
  )
}
