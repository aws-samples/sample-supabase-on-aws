/**
 * JWT Secrets HTTP Client
 * 
 * This module provides HTTP client functions to interact with JWT secrets endpoints.
 * It demonstrates how to retrieve global and project-specific JWT secrets via HTTP API.
 */

/**
 * JWT Secret Response Types
 */
export interface GlobalJwtSecretResponse {
  global_jwt_secret: {
    configured: boolean
    length: number
    masked_value: string
    source: string
    environment_variables: {
      SUPABASE_JWT_SECRET: boolean
      JWT_SECRET: boolean
    }
  }
  supabase_url: string | null
  algorithm: string
  created_at: string
  updated_at: string
}

export interface ProjectJwtSecretResponse {
  project_ref: string
  active_jwt_secret: {
    configured: boolean
    length: number
    masked_value: string
    source: 'global' | 'project-specific' | 'legacy'
    algorithm: string
  } | null
  available_sources: {
    global: JwtSecretSource
    project_specific: JwtSecretSource
    legacy: JwtSecretSource
  }
  priority_order: string[]
  user_access: {
    user_id: string
    access_type: string
    organization_id?: number
  }
  created_at: string
  updated_at: string
}

export interface JwtSecretSource {
  configured: boolean
  length: number
  masked_value: string | null
  environment_variables?: Record<string, boolean>
  source?: string
}

export interface JwtSecretRevealResponse {
  project_ref: string
  revealed_secret: {
    value: string
    source: string
    algorithm: string
    length: number
  }
  security_warning: string
  access_log: {
    user_id: string
    purpose: string
    timestamp: string
    ip_address: string
  }
  usage_instructions: {
    environment_variable: string
    verification_command: string
    security_note: string
  }
}

export interface JwtTokenVerificationResponse {
  project_ref: string
  verification_result: {
    is_valid: boolean
    secret_source?: string
    decoded_payload?: any
    token_info?: {
      algorithm: string
      issued_at: string | null
      expires_at: string | null
      is_expired: boolean
      time_to_expiry: number | null
    }
    error?: string
    details?: string
    attempted_sources?: string[]
  }
  verification_metadata: {
    verified_by: string
    verified_at: string
    secret_source_used?: string
    all_sources_attempted?: boolean
  }
}

/**
 * JWT Secrets HTTP Client Class
 */
export class JwtSecretsClient {
  private baseUrl: string
  private authToken: string

  constructor(baseUrl: string = '', authToken: string = '') {
    this.baseUrl = baseUrl
    this.authToken = authToken
  }

  /**
   * Set authentication token
   */
  setAuthToken(token: string) {
    this.authToken = token
  }

  /**
   * Get request headers with authentication
   */
  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    }

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`
    }

    return headers
  }

  /**
   * Get global JWT secret information
   */
  async getGlobalJwtSecret(): Promise<GlobalJwtSecretResponse> {
    const response = await fetch(`${this.baseUrl}/api/v1/config/auth/jwt-secrets`, {
      method: 'GET',
      headers: this.getHeaders(),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error?.message || `HTTP ${response.status}`)
    }

    return response.json()
  }

  /**
   * Get project-specific JWT secret information
   */
  async getProjectJwtSecret(projectRef: string): Promise<ProjectJwtSecretResponse> {
    const response = await fetch(`${this.baseUrl}/api/v1/projects/${projectRef}/config/auth/jwt-secrets`, {
      method: 'GET',
      headers: this.getHeaders(),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error?.message || `HTTP ${response.status}`)
    }

    return response.json()
  }

  /**
   * Reveal the actual JWT secret value (DANGEROUS - requires special permissions)
   */
  async revealProjectJwtSecret(
    projectRef: string, 
    purpose: string
  ): Promise<JwtSecretRevealResponse> {
    const response = await fetch(`${this.baseUrl}/api/v1/projects/${projectRef}/config/auth/jwt-secrets/reveal`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        confirm_reveal: true,
        purpose
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error?.message || `HTTP ${response.status}`)
    }

    return response.json()
  }

  /**
   * Verify a JWT token against project secrets
   */
  async verifyJwtToken(
    projectRef: string, 
    jwtToken: string
  ): Promise<JwtTokenVerificationResponse> {
    const response = await fetch(`${this.baseUrl}/api/v1/projects/${projectRef}/config/auth/jwt-secrets/verify`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        jwt_token: jwtToken
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error?.message || `HTTP ${response.status}`)
    }

    return response.json()
  }
}

/**
 * Convenience functions for direct usage
 */

/**
 * Get global JWT secret information
 */
export async function fetchGlobalJwtSecret(authToken: string, baseUrl: string = ''): Promise<GlobalJwtSecretResponse> {
  const client = new JwtSecretsClient(baseUrl, authToken)
  return client.getGlobalJwtSecret()
}

/**
 * Get project JWT secret information
 */
export async function fetchProjectJwtSecret(
  projectRef: string, 
  authToken: string, 
  baseUrl: string = ''
): Promise<ProjectJwtSecretResponse> {
  const client = new JwtSecretsClient(baseUrl, authToken)
  return client.getProjectJwtSecret(projectRef)
}

/**
 * Verify JWT token
 */
export async function verifyProjectJwtToken(
  projectRef: string, 
  jwtToken: string, 
  authToken: string, 
  baseUrl: string = ''
): Promise<JwtTokenVerificationResponse> {
  const client = new JwtSecretsClient(baseUrl, authToken)
  return client.verifyJwtToken(projectRef, jwtToken)
}

/**
 * Example usage:
 * 
 * ```typescript
 * import { JwtSecretsClient, fetchGlobalJwtSecret, fetchProjectJwtSecret } from './jwt-secrets-client'
 * 
 * // Using the client class
 * const client = new JwtSecretsClient('https://your-supabase-studio.com', 'your-auth-token')
 * 
 * // Get global JWT secret info
 * const globalSecret = await client.getGlobalJwtSecret()
 * console.log('Global JWT configured:', globalSecret.global_jwt_secret.configured)
 * console.log('Masked value:', globalSecret.global_jwt_secret.masked_value)
 * 
 * // Get project-specific JWT secret info
 * const projectSecret = await client.getProjectJwtSecret('my-project-ref')
 * console.log('Active secret source:', projectSecret.active_jwt_secret?.source)
 * console.log('Available sources:', Object.keys(projectSecret.available_sources))
 * 
 * // Verify a JWT token
 * const verification = await client.verifyJwtToken('my-project-ref', '<your-jwt-token>')
 * console.log('Token valid:', verification.verification_result.is_valid)
 * 
 * // Using convenience functions
 * const globalInfo = await fetchGlobalJwtSecret('your-auth-token')
 * const projectInfo = await fetchProjectJwtSecret('my-project', 'your-auth-token')
 * ```
 */