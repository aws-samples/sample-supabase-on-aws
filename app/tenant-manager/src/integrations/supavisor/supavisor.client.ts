/**
 * Supavisor connection pooler integration
 * Handles tenant registration and deletion with the Supavisor service
 */

import { getEnv } from '../../config/index.js'
import { BaseClient } from '../base-client.js'
import type { TenantConfig, ServiceResult } from '../../types/index.js'

function createSupavisorClient(): BaseClient {
  const env = getEnv()
  return new BaseClient({
    baseUrl: env.SUPAVISOR_URL,
    authToken: env.SUPAVISOR_API_KEY || env.JWT_SECRET,
  })
}

/**
 * Register a new tenant with Supavisor
 */
export async function registerSupavisorTenant(config: TenantConfig): Promise<ServiceResult> {
  const { projectRef, dbName, dbHost, dbPort, dbPassword } = config
  const env = getEnv()

  const client = createSupavisorClient()
  const result = await client['request']({
    method: 'PUT',
    path: `/api/tenants/${projectRef}`,
    body: {
      tenant: {
        external_id: projectRef,
        db_host: dbHost,
        db_port: dbPort,
        db_database: dbName,
        db_user: 'postgres',
        db_password: dbPassword,
        pool_size: env.POOLER_DEFAULT_POOL_SIZE,
        max_client_conn: env.POOLER_MAX_CLIENT_CONN,
        pool_mode: 'transaction',
        require_user: false,
        auth_query: null,
      },
    },
  })

  if (!result.ok) {
    return { success: false, error: `Failed to register Supavisor tenant: ${result.status} ${result.error}` }
  }

  return { success: true }
}

/**
 * Delete a tenant from Supavisor
 */
export async function deleteSupavisorTenant(projectRef: string): Promise<ServiceResult> {
  const client = createSupavisorClient()
  const result = await client['request']({
    method: 'DELETE',
    path: `/api/tenants/${projectRef}`,
  })

  // 404 is acceptable
  if (!result.ok && result.status !== 404) {
    return { success: false, error: `Failed to delete Supavisor tenant: ${result.status} ${result.error}` }
  }

  return { success: true }
}

/**
 * Get tenant info from Supavisor
 */
export async function getSupavisorTenant(
  projectRef: string
): Promise<ServiceResult<unknown>> {
  const client = createSupavisorClient()
  const result = await client['request']({
    method: 'GET',
    path: `/api/tenants/${projectRef}`,
  })

  if (result.status === 404) {
    return { success: false, error: 'Tenant not found' }
  }

  if (!result.ok) {
    return { success: false, error: `Failed to get Supavisor tenant: ${result.status} ${result.error}` }
  }

  return { success: true, data: result.data }
}

/**
 * Update Supavisor tenant configuration
 */
export async function updateSupavisorTenant(
  projectRef: string,
  updates: {
    poolSize?: number
    maxClientConn?: number
    poolMode?: 'transaction' | 'session' | 'statement'
  }
): Promise<ServiceResult> {
  const client = createSupavisorClient()

  const tenant: Record<string, unknown> = {}
  if (updates.poolSize !== undefined) tenant['pool_size'] = updates.poolSize
  if (updates.maxClientConn !== undefined) tenant['max_client_conn'] = updates.maxClientConn
  if (updates.poolMode !== undefined) tenant['pool_mode'] = updates.poolMode

  const result = await client['request']({
    method: 'PUT',
    path: `/api/tenants/${projectRef}`,
    body: { tenant },
  })

  if (!result.ok) {
    return { success: false, error: `Failed to update Supavisor tenant: ${result.status} ${result.error}` }
  }

  return { success: true }
}

/**
 * Check if Supavisor is healthy
 */
export async function checkSupavisorHealth(): Promise<{ healthy: boolean; error?: string }> {
  const client = createSupavisorClient()
  const result = await client['request']({
    method: 'GET',
    path: '/api/health',
  })

  return { healthy: result.ok, ...(result.ok ? {} : { error: result.error }) }
}
