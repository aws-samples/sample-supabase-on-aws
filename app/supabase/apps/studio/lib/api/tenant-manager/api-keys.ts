/**
 * API Keys service wrapper for Tenant-Manager
 */

import { tenantManagerFetch } from './client'

// TM API Key response shape
interface TMAPIKey {
  id: string
  prefix: string
  role: string
  status: string
  jwt?: string
  created_at: string
  updated_at?: string
  opaque_key?: string
}

// Studio-expected API Key shape (matches ApiKeyResponse schema)
export interface StudioAPIKey {
  api_key: string | null
  description: string | null
  hash: string | null
  id: string | null
  inserted_at: string | null
  name: string
  prefix: string | null
  secret_jwt_template: { role: string } | null
  type: 'legacy' | 'publishable' | 'secret' | null
  updated_at: string | null
}

/**
 * Map TM API key response to Studio-expected format
 */
function mapTMKeyToStudio(tmKey: TMAPIKey): StudioAPIKey {
  return {
    api_key: tmKey.opaque_key ?? tmKey.jwt ?? null,
    description: null,
    hash: null,
    id: tmKey.id,
    inserted_at: tmKey.created_at,
    name: tmKey.role, // e.g. "anon", "service_role"
    prefix: tmKey.prefix ?? null,
    secret_jwt_template: tmKey.role ? { role: tmKey.role } : null,
    type: 'secret',
    updated_at: tmKey.updated_at ?? null,
  }
}

/**
 * List all API keys for a project (only active ones).
 * Throws on TM errors so callers can distinguish failure from empty results.
 */
export async function listAPIKeys(ref: string): Promise<StudioAPIKey[]> {
  const response = await tenantManagerFetch<TMAPIKey[]>(
    `/admin/v1/projects/${ref}/api-keys`
  )

  if (response.error) {
    throw new Error(`Failed to list API keys from Tenant-Manager: ${response.error.message}`)
  }

  const keys = response.data || []
  // Only return active keys
  return keys.filter((k) => k.status === 'active').map(mapTMKeyToStudio)
}

/**
 * Create a new API key for a project
 * Returns the mapped key plus the opaque_key (only available at creation time)
 */
export async function createAPIKey(
  ref: string,
  body: { name: string; type: string; description?: string | null; secret_jwt_template?: { role: string } | null }
): Promise<{ key: StudioAPIKey; opaque_key?: string } | null> {
  const tmBody: Record<string, unknown> = {
    role: body.secret_jwt_template?.role ?? body.name,
  }

  const response = await tenantManagerFetch<TMAPIKey>(
    `/admin/v1/projects/${ref}/api-keys`,
    {
      method: 'POST',
      body: JSON.stringify(tmBody),
    }
  )

  if (response.error) {
    console.error('Failed to create API key via Tenant-Manager:', response.error)
    return null
  }

  if (!response.data) return null

  return {
    key: mapTMKeyToStudio(response.data),
    opaque_key: response.data.opaque_key,
  }
}

/**
 * Get a single API key by ID
 */
export async function getAPIKey(ref: string, keyId: string): Promise<StudioAPIKey | null> {
  const response = await tenantManagerFetch<TMAPIKey>(
    `/admin/v1/projects/${ref}/api-keys/${keyId}`
  )

  if (response.error) {
    if (response.error.statusCode === 404) return null
    console.error('Failed to get API key from Tenant-Manager:', response.error)
    return null
  }

  if (!response.data) return null

  return mapTMKeyToStudio(response.data)
}

/**
 * Delete an API key by ID
 */
export async function deleteAPIKey(
  ref: string,
  keyId: string
): Promise<{ success: boolean; error?: string }> {
  const response = await tenantManagerFetch<void>(
    `/admin/v1/projects/${ref}/api-keys/${keyId}`,
    { method: 'DELETE' }
  )

  if (response.error) {
    return { success: false, error: response.error.message }
  }

  return { success: true }
}
