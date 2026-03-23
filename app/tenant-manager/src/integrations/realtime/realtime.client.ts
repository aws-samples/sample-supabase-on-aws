/**
 * Realtime service integration
 * Handles tenant registration and deletion with the Realtime service
 */

import { getEnv } from '../../config/index.js'
import { BaseClient } from '../base-client.js'
import type { TenantConfig, ServiceResult } from '../../types/index.js'

function createRealtimeClient(): BaseClient {
  const env = getEnv()
  return new BaseClient({
    baseUrl: env.REALTIME_URL,
    authToken: env.API_JWT_SECRET || env.JWT_SECRET,
  })
}

/**
 * Register a new tenant with Realtime service
 */
export async function registerRealtimeTenant(config: TenantConfig): Promise<ServiceResult> {
  const { projectRef, dbName, dbHost, dbPort, dbPassword, jwtSecret } = config

  const client = createRealtimeClient()
  const result = await client['request']({
    method: 'PUT',
    path: `/api/tenants/${projectRef}`,
    body: {
      tenant: {
        external_id: projectRef,
        name: projectRef,
        jwt_secret: jwtSecret,
        extensions: [
          {
            type: 'postgres_cdc_rls',
            settings: {
              db_host: dbHost,
              db_port: String(dbPort),
              db_name: dbName,
              db_user: 'supabase_admin',
              db_password: dbPassword,
              region: 'local',
              poll_interval: 100,
              poll_max_changes: 100,
              poll_max_record_bytes: 1048576,
              ip_version: 4,
            },
          },
        ],
      },
    },
  })

  if (!result.ok) {
    return { success: false, error: `Failed to register Realtime tenant: ${result.status} ${result.error}` }
  }

  return { success: true }
}

/**
 * Delete a tenant from Realtime service
 */
export async function deleteRealtimeTenant(projectRef: string): Promise<ServiceResult> {
  const client = createRealtimeClient()
  const result = await client['request']({
    method: 'DELETE',
    path: `/api/tenants/${projectRef}`,
  })

  // 404 is acceptable
  if (!result.ok && result.status !== 404) {
    return { success: false, error: `Failed to delete Realtime tenant: ${result.status} ${result.error}` }
  }

  return { success: true }
}

/**
 * Get tenant info from Realtime service
 */
export async function getRealtimeTenant(
  projectRef: string
): Promise<ServiceResult<unknown>> {
  const client = createRealtimeClient()
  const result = await client['request']({
    method: 'GET',
    path: `/api/tenants/${projectRef}`,
  })

  if (result.status === 404) {
    return { success: false, error: 'Tenant not found' }
  }

  if (!result.ok) {
    return { success: false, error: `Failed to get Realtime tenant: ${result.status} ${result.error}` }
  }

  return { success: true, data: result.data }
}

/**
 * Check Realtime tenant health
 */
export async function checkRealtimeTenantHealth(
  projectRef: string
): Promise<{ healthy: boolean; error?: string }> {
  const client = createRealtimeClient()
  const result = await client['request']({
    method: 'GET',
    path: `/api/tenants/${projectRef}/health`,
  })

  return { healthy: result.ok, ...(result.ok ? {} : { error: result.error }) }
}

/**
 * Check if Realtime service is healthy
 */
export async function checkRealtimeHealth(): Promise<{ healthy: boolean; error?: string }> {
  const client = createRealtimeClient()
  const result = await client['request']({
    method: 'GET',
    path: '/api/health',
  })

  return { healthy: result.ok, ...(result.ok ? {} : { error: result.error }) }
}
