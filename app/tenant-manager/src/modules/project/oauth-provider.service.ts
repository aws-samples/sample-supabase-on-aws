/**
 * Per-tenant external OAuth provider service.
 *
 * Stores provider credentials (encrypted) in the supabase_platform DB and
 * exposes them in two shapes:
 *   - masked, for admin GET responses (never leaks the secret)
 *   - GoTrue-native (conf.ProviderConfiguration JSON), for the project config
 *     endpoint that GoTrue's tenant manager pulls.
 */

import { encryptSecret, decryptSecret } from '../../common/crypto/encryption.js'
import {
  upsertExternalOAuthProvider,
  getExternalOAuthProvider,
  getExternalOAuthProviders,
  deleteExternalOAuthProvider,
} from '../../db/platform-queries.js'
import type { GoogleProviderInput } from './oauth-provider.schemas.js'

export const GOOGLE_PROVIDER = 'google'

/**
 * GoTrue-native OAuth provider config. Field names and types mirror
 * conf.OAuthProviderConfiguration so GoTrue can decode it directly.
 * Note: client_id is an array to match GoTrue's `ClientID []string`.
 */
export interface GoTrueOAuthProviderConfig {
  enabled: boolean
  client_id: string[]
  secret: string
  redirect_uri: string
  skip_nonce_check: boolean
}

export interface GoTrueExternalConfig {
  google?: GoTrueOAuthProviderConfig
}

/** Masked provider config for admin GET responses. */
export interface MaskedProviderConfig {
  provider: string
  enabled: boolean
  client_id: string
  redirect_uri: string | null
  skip_nonce_check: boolean
  /** Whether a client secret is stored; the value itself is never returned. */
  secret_set: boolean
}

/**
 * Store (upsert) the Google provider config for a project. The client_secret is
 * encrypted at rest. When disabled with no credentials supplied, empty strings
 * are persisted (GoTrue ignores a disabled provider).
 */
export async function setGoogleProvider(
  projectRef: string,
  input: GoogleProviderInput,
): Promise<void> {
  await upsertExternalOAuthProvider(projectRef, GOOGLE_PROVIDER, {
    enabled: input.enabled,
    clientId: input.client_id ?? '',
    encryptedSecret: input.client_secret ? encryptSecret(input.client_secret) : '',
    redirectUri: input.redirect_uri ?? null,
    skipNonceCheck: input.skip_nonce_check ?? false,
  })
}

/**
 * Read the Google provider config for a project with the secret masked.
 * Returns null when no config exists.
 */
export async function getGoogleProviderMasked(
  projectRef: string,
): Promise<MaskedProviderConfig | null> {
  const row = await getExternalOAuthProvider(projectRef, GOOGLE_PROVIDER)
  if (!row) return null
  return {
    provider: row.provider,
    enabled: row.enabled,
    client_id: row.client_id,
    redirect_uri: row.redirect_uri,
    skip_nonce_check: row.skip_nonce_check,
    secret_set: row.client_secret !== '',
  }
}

/** Delete the Google provider config for a project. */
export async function deleteGoogleProvider(projectRef: string): Promise<void> {
  await deleteExternalOAuthProvider(projectRef, GOOGLE_PROVIDER)
}

/**
 * Build the GoTrue-native external config for a project by decrypting stored
 * secrets and mapping rows into conf.ProviderConfiguration JSON shape. Returns
 * null when the project has no external providers configured, so callers can
 * omit the `external` key entirely.
 */
export async function buildExternalConfigForGoTrue(
  projectRef: string,
): Promise<GoTrueExternalConfig | null> {
  const rows = await getExternalOAuthProviders(projectRef)
  const google = rows.find((row) => row.provider === GOOGLE_PROVIDER)
  if (!google) return null

  return {
    google: {
      enabled: google.enabled,
      client_id: google.client_id ? [google.client_id] : [],
      secret: google.client_secret ? decryptSecret(google.client_secret) : '',
      redirect_uri: google.redirect_uri ?? '',
      skip_nonce_check: google.skip_nonce_check,
    },
  }
}
