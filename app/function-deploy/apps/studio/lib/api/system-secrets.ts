/**
 * Builds the four system-default secrets that every project always exposes:
 *   SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (from tenant-manager)
 *   SUPABASE_URL, SUPABASE_PUBLIC_URL (derived from project ref + base domain)
 *
 * Both URL values point to the per-project subdomain
 * (https://{ref}.{SUPABASE_BASE_DOMAIN}) so the platform
 * matches Supabase Cloud semantics for self-hosted tenants.
 */

import { listAPIKeysAsSecrets } from './tenant-manager'
import type { MergedSecret } from './secrets-merger'

export class MissingBaseDomainError extends Error {
  constructor() {
    super(
      'SUPABASE_BASE_DOMAIN env var is required to build SUPABASE_URL/SUPABASE_PUBLIC_URL system secrets'
    )
    this.name = 'MissingBaseDomainError'
  }
}

function getBaseDomain(): string {
  const value = process.env.SUPABASE_BASE_DOMAIN
  if (!value || value.trim().length === 0) {
    throw new MissingBaseDomainError()
  }
  return value.trim()
}

function projectUrl(ref: string, baseDomain: string): string {
  return `https://${ref}.${baseDomain}`
}

export async function buildSystemSecrets(ref: string): Promise<MergedSecret[]> {
  const baseDomain = getBaseDomain()
  const apiKeys = await listAPIKeysAsSecrets(ref)

  const apiKeySecrets: MergedSecret[] = apiKeys.map((k) => ({
    name: k.name,
    value: k.value,
    updated_at: k.updated_at,
    source: 'system',
  }))

  const url = projectUrl(ref, baseDomain)
  const now = new Date().toISOString()

  const urlSecrets: MergedSecret[] = [
    { name: 'SUPABASE_URL', value: url, updated_at: now, source: 'system' },
    { name: 'SUPABASE_PUBLIC_URL', value: url, updated_at: now, source: 'system' },
  ]

  return [...apiKeySecrets, ...urlSecrets]
}
