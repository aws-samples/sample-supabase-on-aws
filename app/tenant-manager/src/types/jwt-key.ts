/**
 * JWT signing key types for key rotation
 */

export type JwtKeyStatus = 'current' | 'previous' | 'standby'

export interface JwtKey {
  id: string
  secret: string
  status: JwtKeyStatus
  algorithm: 'HS256'
  created_at: string
  rotated_at: string | null
}

export interface JwtKeyPublicInfo {
  id: string
  status: JwtKeyStatus
  algorithm: 'HS256'
  created_at: string
  rotated_at: string | null
}

export interface JwtKeyRotationResult {
  current: JwtKeyPublicInfo
  previous: JwtKeyPublicInfo | null
  api_keys_resigned: number
}
