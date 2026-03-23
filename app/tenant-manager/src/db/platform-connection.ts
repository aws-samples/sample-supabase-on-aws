/**
 * Connection pool for supabase_platform database.
 * Used for Lambda-related data and runtime config queries.
 * Separate from the management pool (_supabase DB).
 */

import pg from 'pg'
import { getEnv } from '../config/index.js'
import { getRdsSslConfig } from '../config/ssl.js'

const { Pool } = pg

let platformPool: pg.Pool | null = null

/**
 * Get or create the supabase_platform connection pool.
 * Falls back to management DB credentials if platform-specific vars are not set.
 */
export function getPlatformPool(): pg.Pool {
  if (!platformPool) {
    const env = getEnv()
    platformPool = new Pool({
      host: env.PLATFORM_DB_HOST || env.POSTGRES_HOST,
      port: env.PLATFORM_DB_PORT || env.POSTGRES_PORT,
      user: env.PLATFORM_DB_USER || env.POSTGRES_USER_READ_WRITE,
      password: env.PLATFORM_DB_PASSWORD || env.POSTGRES_PASSWORD,
      database: env.PLATFORM_DB_NAME,
      ssl: getRdsSslConfig(),
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })

    platformPool.on('error', (err) => {
      console.error('[platform-db] Unexpected pool error:', err.message)
    })
  }
  return platformPool
}

/**
 * Execute a query against supabase_platform.
 */
export async function platformQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const pool = getPlatformPool()
  return pool.query<T>(text, params)
}

/**
 * Close the platform connection pool.
 */
export async function closePlatformPool(): Promise<void> {
  if (platformPool) {
    await platformPool.end()
    platformPool = null
  }
}
