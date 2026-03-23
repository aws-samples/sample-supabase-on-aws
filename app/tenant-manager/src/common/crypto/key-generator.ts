/**
 * Cryptographic utilities for multi-tenant project management
 * Handles JWT secret generation, API key generation, and project refs
 */

import crypto from 'crypto'
import jwt from 'jsonwebtoken'

// Characters for generating project references (lowercase alphanumeric)
const REF_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const REF_LENGTH = 20

/**
 * Generate a unique project reference identifier
 * Format: 20 characters, lowercase alphanumeric
 */
export function generateProjectRef(): string {
  const bytes = crypto.randomBytes(REF_LENGTH)
  let ref = ''
  for (let i = 0; i < REF_LENGTH; i++) {
    ref += REF_CHARS[bytes[i]! % REF_CHARS.length]
  }
  return ref
}

/**
 * Generate a cryptographically secure JWT secret
 * Returns a 32-byte base64-encoded string
 */
export function generateJwtSecret(): string {
  return crypto.randomBytes(32).toString('base64')
}

/**
 * Validate a project reference format
 * Must be lowercase alphanumeric with optional hyphens
 */
export function isValidProjectRef(ref: string): boolean {
  return /^[a-z0-9-]+$/.test(ref) && ref.length >= 1 && ref.length <= 64
}

/**
 * Generate a database name from project reference
 * Format: project_{ref}
 */
export function generateDbName(projectRef: string): string {
  // Replace hyphens with underscores for valid postgres identifier
  const sanitizedRef = projectRef.replace(/-/g, '_')
  return `project_${sanitizedRef}`
}

/**
 * Verify a JWT token with a given secret
 * Returns the decoded payload or null if invalid
 */
export function verifyApiKey(token: string, jwtSecret: string): jwt.JwtPayload | null {
  try {
    const decoded = jwt.verify(token, jwtSecret)
    if (typeof decoded === 'string') {
      return null
    }
    return decoded
  } catch {
    return null
  }
}
