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

// Secret response shape for secrets endpoint
export interface SecretAPIKey {
  name: string
  value: string
  updated_at: string
}

/**
 * Map TM API key response to Secret format
 */
function mapTMKeyToSecret(tmKey: TMAPIKey): SecretAPIKey {
  // Use opaque_key if available, otherwise use jwt
  const keyValue = tmKey.opaque_key ?? tmKey.jwt ?? ''
  
  return {
    name: `SUPABASE_${tmKey.role.toUpperCase()}_KEY`,
    value: keyValue,
    updated_at: tmKey.updated_at ?? tmKey.created_at,
  }
}

/**
 * List all API keys for a project as secrets format.
 * Returns empty array if TM is unavailable.
 */
export async function listAPIKeysAsSecrets(ref: string): Promise<SecretAPIKey[]> {
  try {
    const response = await tenantManagerFetch<TMAPIKey[]>(
      `/admin/v1/projects/${ref}/api-keys`
    )

    if (response.error) {
      console.warn(`Failed to fetch API keys from Tenant-Manager: ${response.error.message}`)
      return []
    }

    const keys = response.data || []
    // Only return active keys
    return keys
      .filter((k) => k.status === 'active')
      .map(mapTMKeyToSecret)
  } catch (error) {
    console.warn('Tenant-Manager unavailable:', error)
    return []
  }
}
