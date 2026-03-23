/**
 * Environment detection utilities for self-hosted API endpoints
 */

/**
 * Determines if the current environment is self-hosted
 * This can be used to conditionally enable self-hosted API implementations
 */
export function isSelfHosted(): boolean {
  // Check for self-hosted environment indicators
  return (
    // Check if we're not on the platform (common package export)
    process.env.NEXT_PUBLIC_ENVIRONMENT !== 'platform' ||
    // Check for explicit self-hosted flag
    process.env.SUPABASE_SELF_HOSTED === 'true' ||
    // Check if platform API URL is not set (indicating self-hosted)
    !process.env.NEXT_PUBLIC_API_URL?.includes('supabase.co')
  )
}

/**
 * Gets the storage base path for self-hosted environments
 */
export function getStorageBasePath(): string {
  return process.env.SUPABASE_STORAGE_PATH || '.supabase'
}

/**
 * Gets the encryption key for self-hosted storage
 */
export function getEncryptionKey(): string {
  const key = process.env.SUPABASE_ENCRYPTION_KEY
  
  if (!key) {
    console.warn(
      'SUPABASE_ENCRYPTION_KEY not set. Using default key. ' +
      'Please set a secure encryption key in production.'
    )
    return 'default-key-change-in-production'
  }
  
  return key
}