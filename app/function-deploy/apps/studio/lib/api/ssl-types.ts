/**
 * SSL Configuration Types for Project Database Connections
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */

/**
 * SSL Configuration interface for project database connections
 */
export interface SSLConfig {
  enabled: boolean
  rejectUnauthorized?: boolean
  ca?: string
  cert?: string
  key?: string
  mode?: SSLMode
}

/**
 * SSL Mode enumeration for PostgreSQL connections
 */
export type SSLMode = 'require' | 'prefer' | 'allow' | 'disable' | 'verify-ca' | 'verify-full'

/**
 * SSL Configuration source tracking
 */
export type SSLConfigSource = 
  | 'project_ssl_config'
  | 'connection_string'
  | 'project_env_override'
  | 'global_env_config'
  | 'default_disabled'

/**
 * SSL Error types for enhanced error handling
 */
export interface SSLError extends Error {
  code?: string
  sslMode?: SSLMode
  certificateIssue?: boolean
  connectionRefused?: boolean
}

/**
 * SSL Connection validation result
 */
export interface SSLValidationResult {
  isValid: boolean
  sslEnabled: boolean
  sslMode?: SSLMode
  errors: string[]
  warnings: string[]
  certificateInfo?: {
    hasCaCert: boolean
    hasClientCert: boolean
    hasClientKey: boolean
  }
}

/**
 * Enhanced Project Metadata with SSL configuration
 */
export interface ProjectMetadataWithSSL {
  id: number
  ref: string
  name: string
  database_name: string
  database_user: string
  database_password_hash: string
  database_host?: string
  database_port?: number
  ssl_config?: SSLConfig
  organization_id: number
  owner_user_id: string
  status: string
  region: string
  connection_string: string
  inserted_at: string
  updated_at: string
}

/**
 * SSL Configuration for database connection pools
 */
export interface DatabaseSSLConfig {
  rejectUnauthorized?: boolean
  ca?: string | Buffer
  cert?: string | Buffer
  key?: string | Buffer
  checkServerIdentity?: (hostname: string, cert: any) => Error | undefined
}

/**
 * SSL Error response for API endpoints
 */
export interface SSLErrorResponse {
  success: false
  error: {
    code: string
    message: string
    sslMode?: SSLMode
    suggestions: string[]
  }
}

/**
 * SSL Configuration test result
 */
export interface SSLTestResult {
  success: boolean
  sslEnabled: boolean
  sslMode?: SSLMode
  connectionTime?: number
  error?: string
  fallbackUsed?: boolean
}