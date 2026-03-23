import { IS_PLATFORM } from 'lib/constants'
import { constructHeaders } from '../apiHelpers'
import { encryptString, getConnectionString } from './util'

/**
 * Ensure x-connection-encrypted header is present in the request headers.
 *
 * Uses a 3-tier fallback:
 * 1. Browser flow: x-connection-encrypted already in headers -> pass through
 * 2. Multi-tenant API flow: fetch credentials from Tenant-Manager by ref -> encrypt & inject
 * 3. Single-tenant fallback: use local POSTGRES_* env vars
 */
export async function ensureConnectionEncrypted(
  headers: { [prop: string]: any },
  ref?: string
): Promise<Record<string, string>> {
  const cleansed = constructHeaders(headers)

  if (cleansed['x-connection-encrypted'] || IS_PLATFORM) {
    return cleansed
  }

  if (ref) {
    const { getDatabaseCredentials } = await import('lib/api/tenant-manager/projects')
    const credentials = await getDatabaseCredentials(ref)
    if (credentials) {
      const connStr = `postgresql://${credentials.user}:${credentials.password}@${credentials.host}:${credentials.port}/${credentials.db_name}?sslmode=verify-ca`
      cleansed['x-connection-encrypted'] = encryptString(connStr)
      return cleansed
    }
  }

  cleansed['x-connection-encrypted'] = encryptString(getConnectionString({ readOnly: true }))
  return cleansed
}
