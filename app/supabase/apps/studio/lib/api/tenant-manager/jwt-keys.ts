/**
 * JWT Keys service wrapper for Tenant-Manager
 */

import { tenantManagerFetch } from './client'

// TM JWT Key response shape
interface TMJWTKey {
  id: string
  algorithm: string
  status: 'current' | 'previous' | 'standby'
  created_at: string
  rotated_at?: string
  public_jwk?: unknown
}

// Studio-expected SigningKeyResponse shape
export interface StudioSigningKey {
  id: string
  algorithm: 'EdDSA' | 'ES256' | 'RS256' | 'HS256'
  status: 'in_use' | 'previously_used' | 'revoked' | 'standby'
  created_at: string
  updated_at: string
  public_jwk?: unknown
}

// TM status → Studio status mapping
const STATUS_MAP: Record<string, StudioSigningKey['status']> = {
  current: 'in_use',
  previous: 'previously_used',
  standby: 'standby',
}

/**
 * Map TM JWT key to Studio-expected format
 */
function mapTMKeyToStudio(tmKey: TMJWTKey): StudioSigningKey {
  return {
    id: tmKey.id,
    algorithm: tmKey.algorithm as StudioSigningKey['algorithm'],
    status: STATUS_MAP[tmKey.status] ?? tmKey.status as StudioSigningKey['status'],
    created_at: tmKey.created_at,
    updated_at: tmKey.rotated_at ?? tmKey.created_at,
    public_jwk: tmKey.public_jwk,
  }
}

/**
 * List all JWT signing keys for a project
 */
export async function listJWTKeys(ref: string): Promise<{ keys: StudioSigningKey[] }> {
  const response = await tenantManagerFetch<TMJWTKey[]>(
    `/admin/v1/projects/${ref}/jwt-keys`
  )

  if (response.error) {
    console.error('Failed to list JWT keys from Tenant-Manager:', response.error)
    return { keys: [] }
  }

  const keys = response.data || []
  return { keys: keys.map(mapTMKeyToStudio) }
}

/**
 * Create a standby JWT signing key
 */
export async function createStandbyKey(
  ref: string,
  body?: { algorithm?: string; private_jwk?: unknown }
): Promise<StudioSigningKey | null> {
  const response = await tenantManagerFetch<TMJWTKey>(
    `/admin/v1/projects/${ref}/jwt-keys/standby`,
    {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    }
  )

  if (response.error) {
    console.error('Failed to create standby JWT key via Tenant-Manager:', response.error)
    return null
  }

  if (!response.data) return null

  return mapTMKeyToStudio(response.data)
}

/**
 * Rotate JWT signing keys (promote standby to current)
 */
export async function rotateKeys(
  ref: string
): Promise<{ current: StudioSigningKey; previous: StudioSigningKey; api_keys_resigned: boolean } | null> {
  const response = await tenantManagerFetch<{
    current: TMJWTKey
    previous: TMJWTKey
    api_keys_resigned: boolean
  }>(`/admin/v1/projects/${ref}/jwt-keys/rotate`, {
    method: 'POST',
  })

  if (response.error) {
    console.error('Failed to rotate JWT keys via Tenant-Manager:', response.error)
    return null
  }

  if (!response.data) return null

  return {
    current: mapTMKeyToStudio(response.data.current),
    previous: mapTMKeyToStudio(response.data.previous),
    api_keys_resigned: response.data.api_keys_resigned,
  }
}
