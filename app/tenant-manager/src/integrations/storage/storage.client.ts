/**
 * supabase/storage-api integration (MULTI_TENANT mode).
 *
 * Storage runs in upstream multi-tenant mode (see infra/lib/supabase-stack.ts
 * StorageService block). Each project must be registered with the storage
 * Admin API at port 5001 so storage-api knows which DB / JWT secret to use
 * when serving /storage/v1/* requests for that tenant.
 *
 * Best-effort semantics: failures here must not block project provisioning,
 * because storage is an additive surface — projects without storage tenant
 * still have working REST/Functions/Auth. Errors come back as ServiceResult.
 */

import { getEnv } from '../../config/index.js'
import type { TenantConfig, ServiceResult } from '../../types/index.js'

interface StorageTenantPayload {
  anonKey: string
  serviceKey: string
  jwtSecret: string
  databaseUrl: string
  fileSizeLimit?: number
  features?: Record<string, unknown>
}

function buildDatabaseUrl(config: TenantConfig): string {
  const { dbHost, dbPort, dbName, dbPassword } = config
  // storage-api connects with the cluster-superuser role (postgres) so its
  // boot-time migration can CREATE/ALTER the storage schema and grant the
  // anon/authenticated/service_role roles the rights it needs. The tenant
  // template (template-initializer.ts) defines supabase_storage_admin without
  // LOGIN/PASSWORD, so it is unusable for direct connections; postgres has
  // the same superuser scope and already authenticates here.
  const password = encodeURIComponent(dbPassword)
  return `postgresql://postgres:${password}@${dbHost}:${dbPort}/${dbName}?sslmode=verify-ca`
}

function getStorageAdminAuth(): { url: string; key: string } {
  const env = getEnv()
  const key = env.ADMIN_API_KEY
  if (!key) {
    throw new Error('ADMIN_API_KEY env var is required to talk to storage-api Admin endpoint')
  }
  return { url: env.STORAGE_ADMIN_URL, key }
}

export async function registerStorageTenant(config: TenantConfig): Promise<ServiceResult> {
  let auth: { url: string; key: string }
  try {
    auth = getStorageAdminAuth()
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  const payload: StorageTenantPayload = {
    anonKey: config.anonKey,
    serviceKey: config.serviceRoleKey,
    jwtSecret: config.jwtSecret,
    databaseUrl: buildDatabaseUrl(config),
  }

  const path = `/tenants/${encodeURIComponent(config.projectRef)}`
  try {
    const resp = await fetch(`${auth.url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // storage-api Admin guards on the `apikey` header, not Authorization.
        // See app/storage/src/http/plugins/apikey.ts.
        apikey: auth.key,
      },
      body: JSON.stringify(payload),
    })

    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      return {
        success: false,
        error: `storage-api POST ${path} returned ${resp.status}: ${body.slice(0, 500)}`,
      }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function deleteStorageTenant(projectRef: string): Promise<ServiceResult> {
  let auth: { url: string; key: string }
  try {
    auth = getStorageAdminAuth()
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  const path = `/tenants/${encodeURIComponent(projectRef)}`
  try {
    const resp = await fetch(`${auth.url}${path}`, {
      method: 'DELETE',
      headers: { apikey: auth.key },
    })

    if (resp.ok) return { success: true }
    if (resp.status === 404) return { success: true } // idempotent

    const body = await resp.text().catch(() => '')
    return {
      success: false,
      error: `storage-api DELETE ${path} returned ${resp.status}: ${body.slice(0, 500)}`,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
