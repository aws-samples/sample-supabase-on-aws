/**
 * TypeScript interfaces for self-hosted API endpoints
 * These match the API contracts defined in the design document
 */

// Access Tokens API Types
export interface AccessToken {
  id: string
  name: string
  created_at: string
  expires_at: string | null
  scope: 'V0'
  token_alias: string
}

export interface AccessTokensResponse {
  tokens: AccessToken[]
}

export interface CreateAccessTokenRequest {
  name: string
  expires_at?: string
  scope?: 'V0'
}

export interface CreateAccessTokenResponse extends AccessToken {
  token: string // Only returned on creation
}

// Project Secrets API Types
export interface SecretResponse {
  name: string
  value: string // SHA256 digest of the secret value (for display purposes)
  updated_at?: string
}

export interface SecretsResponse {
  secrets: SecretResponse[]
}

export interface CreateSecretsRequest {
  secrets: Array<{
    name: string
    value: string
  }>
}

export interface DeleteSecretsRequest {
  secretNames: string[]
}

// Internal Storage Types
export interface AccessTokenRecord {
  id: string
  name: string
  token_hash: string // Hashed version for security
  created_at: string
  expires_at: string | null
  scope: 'V0'
  last_used_at?: string
}

export interface ProjectSecretRecord {
  name: string
  value: string // Encrypted at rest
  updated_at: string
  created_by: string
  project_ref: string
}

// Error Response Type
export interface ErrorResponse {
  data: null
  error: {
    message: string
    code?: string
    details?: any
  }
}

// Storage Configuration
export interface StorageConfig {
  accessTokensPath: string
  secretsPath: string
  encryptionKey: string
}