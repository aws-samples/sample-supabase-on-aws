/**
 * Tenant-Manager project helpers for function-deploy
 */

import { tenantManagerFetch } from './client'

/**
 * Trigger PostgREST schema cache reload for a project.
 * Fire-and-forget — caller should `.catch(() => {})`.
 */
export async function triggerSchemaReload(ref: string): Promise<void> {
  const response = await tenantManagerFetch<{ message: string }>(
    `/internal/v1/projects/${ref}/reload-schema`,
    { method: 'POST', body: '{}' },
  )
  if (response.error) {
    console.warn(`[schema-reload] Failed to trigger reload for ${ref}:`, response.error.message)
  } else {
    console.debug(`[schema-reload] Reload triggered for ${ref}`)
  }
}
