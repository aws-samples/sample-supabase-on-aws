// Constants specific to self-hosted environments

// Lazy read to guarantee the runtime value is used (not a build-time snapshot)
export function getEncryptionKey(): string {
  return process.env.PG_META_CRYPTO_KEY || 'SAMPLE_KEY'
}
export const POSTGRES_PORT = process.env.POSTGRES_PORT || 5432
export const POSTGRES_HOST = process.env.POSTGRES_HOST || 'db'
export const POSTGRES_DATABASE = process.env.POSTGRES_DB || 'postgres'
export const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'postgres'
export const POSTGRES_USER_READ_WRITE = process.env.POSTGRES_USER_READ_WRITE || 'supabase_admin'
export const POSTGRES_USER_READ_ONLY =
  process.env.POSTGRES_USER_READ_ONLY || 'supabase_read_only_user'
export const TEMPLATE_DATABASE_NAME = process.env.TEMPLATE_DATABASE_NAME
