/**
 * Auth (GoTrue) Multi-Tenant Service Integration
 * Handles registering and managing Auth service tenants
 */

import { getEnv } from '../../config/index.js'
import { BaseClient } from '../base-client.js'
import type { TenantConfig, ServiceResult } from '../../types/index.js'

interface AuthTenantResponse {
  tenant_id: string
  site_url?: string
  created_at?: string
}

function createAuthClient(): BaseClient {
  const env = getEnv()
  return new BaseClient({
    baseUrl: env.GOTRUE_URL,
    authToken: env.GOTRUE_ADMIN_KEY || env.JWT_SECRET,
  })
}

/**
 * Register a new Auth tenant with the GoTrue service
 */
export async function registerAuthTenant(config: TenantConfig): Promise<ServiceResult> {
  const { projectRef, dbName, dbHost, dbPort, dbPassword, jwtSecret, siteUrl } = config
  const env = getEnv()

  const databaseUrl = `postgresql://postgres:${dbPassword}@${dbHost}:${dbPort}/${dbName}`

  const client = createAuthClient()
  const result = await client['request']({
    method: 'PUT',
    path: `/admin/tenants/${projectRef}`,
    body: {
      database_url: databaseUrl,
      jwt_secret: jwtSecret,
      site_url: siteUrl || env.SITE_URL,
    },
  })

  if (!result.ok) {
    console.error('Failed to register Auth tenant:', { projectRef, error: result.error })
    return { success: false, error: result.error || `HTTP ${result.status}` }
  }

  console.debug('Auth tenant registered successfully:', { projectRef })
  return { success: true }
}

/**
 * Delete an Auth tenant from the GoTrue service
 */
export async function deleteAuthTenant(projectRef: string): Promise<ServiceResult> {
  const client = createAuthClient()
  const result = await client['request']({
    method: 'DELETE',
    path: `/admin/tenants/${projectRef}`,
  })

  // 404 is acceptable
  if (!result.ok && result.status !== 404) {
    console.error('Failed to delete Auth tenant:', { projectRef, error: result.error })
    return { success: false, error: result.error || `HTTP ${result.status}` }
  }

  console.debug('Auth tenant deleted successfully:', { projectRef })
  return { success: true }
}

/**
 * Get Auth tenant information
 */
export async function getAuthTenant(
  projectRef: string
): Promise<ServiceResult<AuthTenantResponse>> {
  const client = createAuthClient()
  const result = await client['request']<AuthTenantResponse>({
    method: 'GET',
    path: `/admin/tenants/${projectRef}`,
  })

  if (!result.ok) {
    if (result.status === 404) {
      return { success: false, error: 'Tenant not found' }
    }
    return { success: false, error: result.error || `HTTP ${result.status}` }
  }

  return { success: true, data: result.data }
}

/**
 * List all Auth tenants
 */
export async function listAuthTenants(): Promise<ServiceResult<AuthTenantResponse[]>> {
  const client = createAuthClient()
  const result = await client['request']<AuthTenantResponse[]>({
    method: 'GET',
    path: '/admin/tenants',
  })

  if (!result.ok) {
    return { success: false, error: result.error || `HTTP ${result.status}` }
  }

  return { success: true, data: result.data }
}

/**
 * Check if Auth multi-tenant mode is enabled
 */
export function isAuthMultiTenantEnabled(): boolean {
  const env = getEnv()
  return env.GOTRUE_MULTI_TENANT
}

/**
 * Get the Auth service URL
 */
export function getAuthServiceUrl(): string {
  const env = getEnv()
  return env.GOTRUE_URL
}
