/**
 * Token generation and validation utilities for self-hosted environments
 */

import crypto from 'crypto'
import type { AccessTokenRecord, CreateAccessTokenRequest } from './types'

/**
 * Generates a cryptographically secure access token
 */
export function generateAccessToken(): string {
  // Generate a 32-byte random token and encode as base64url
  const buffer = crypto.randomBytes(32)
  return buffer.toString('base64url')
}

/**
 * Generates a secure hash of a token for storage
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * Validates token name format
 */
export function validateTokenName(name: string): boolean {
  // Token name should be 1-50 characters, alphanumeric with spaces, hyphens, underscores
  const nameRegex = /^[a-zA-Z0-9\s\-_]{1,50}$/
  return nameRegex.test(name.trim())
}

/**
 * Validates token expiration date
 */
export function validateTokenExpiration(expiresAt?: string): boolean {
  if (!expiresAt) return true // null expiration is valid (no expiration)
  
  const expirationDate = new Date(expiresAt)
  const now = new Date()
  
  // Check if date is valid and in the future
  return !isNaN(expirationDate.getTime()) && expirationDate > now
}

/**
 * Checks if a token is expired
 */
export function isTokenExpired(token: AccessTokenRecord): boolean {
  if (!token.expires_at) return false // No expiration date means never expires
  
  const expirationDate = new Date(token.expires_at)
  const now = new Date()
  
  return expirationDate <= now
}

/**
 * Creates a new access token record from request
 */
export function createAccessTokenRecord(
  request: CreateAccessTokenRequest,
  token: string
): AccessTokenRecord {
  const now = new Date().toISOString()
  
  return {
    id: crypto.randomUUID(),
    name: request.name.trim(),
    token_hash: hashToken(token),
    created_at: now,
    expires_at: request.expires_at || null,
    scope: request.scope || 'V0',
  }
}

/**
 * Converts internal token record to public API response format
 */
export function tokenRecordToResponse(record: AccessTokenRecord) {
  return {
    id: record.id,
    name: record.name,
    created_at: record.created_at,
    expires_at: record.expires_at,
    scope: record.scope,
    token_alias: `${record.name.substring(0, 10)}...${record.id.substring(0, 8)}`,
    last_used_at: record.last_used_at,
  }
}

/**
 * Validates secret name format (environment variable naming conventions)
 */
export function validateSecretName(name: string): boolean {
  // Environment variable names can be uppercase or lowercase, alphanumeric with underscores
  // Must start with a letter (uppercase or lowercase), 1-100 characters
  // Supports "supabase" prefix in any casing
  const secretNameRegex = /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/
  return secretNameRegex.test(name)
}

/**
 * Validates secret value (basic validation)
 */
export function validateSecretValue(value: string): boolean {
  // Secret values should not be empty and not exceed reasonable length
  return value.length > 0 && value.length <= 10000
}