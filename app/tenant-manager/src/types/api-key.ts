/**
 * API key types for multi-API-key management
 */

export type ApiKeyType = 'publishable' | 'secret'
export type ApiKeyRole = 'anon' | 'service_role'
export type ApiKeyStatus = 'active' | 'revoked'

export interface ApiKey {
  id: string
  project_ref: string
  name: string
  type: ApiKeyType
  role: ApiKeyRole
  prefix: string
  hashed_secret: string
  jwt: string
  jwt_key_id: string
  status: ApiKeyStatus
  description: string | null
  created_at: string
  updated_at: string
  revoked_at: string | null
}

export interface CreateApiKeyInput {
  name: string
  type: ApiKeyType
  role: ApiKeyRole
  description?: string
}

export interface ApiKeyCreatedResponse {
  id: string
  name: string
  type: ApiKeyType
  role: ApiKeyRole
  prefix: string
  opaque_key: string
  jwt: string
  description: string | null
  created_at: string
}

export interface ApiKeyListItem {
  id: string
  name: string
  type: ApiKeyType
  role: ApiKeyRole
  prefix: string
  jwt: string
  opaque_key: string
  status: ApiKeyStatus
  description: string | null
  created_at: string
}
