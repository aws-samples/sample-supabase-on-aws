/**
 * Database Client for Cluster Management
 * 
 * Provides direct database access for cluster management operations.
 * This bypasses the Platform API and connects directly to PostgreSQL.
 */

import { Pool } from 'pg'

const pools = new Map<string, Pool>()

/**
 * Get or create a connection pool for the given connection string
 */
function getPool(connectionString: string): Pool {
  if (!pools.has(connectionString)) {
    const pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: true, ca: require('fs').readFileSync(process.env.RDS_CA_CERT_PATH || '/etc/ssl/certs/rds-global-bundle.pem', 'utf-8') }
        : false,
    })
    pools.set(connectionString, pool)
  }
  return pools.get(connectionString)!
}

/**
 * Execute a SQL query and return the results
 */
export async function executeQuery<T = any>(
  connectionString: string,
  sql: string
): Promise<T[]> {
  const pool = getPool(connectionString)
  
  try {
    const result = await pool.query(sql)
    return result.rows as T[]
  } catch (error) {
    console.error('Database query error:', error)
    throw error
  }
}

/**
 * Close all connection pools
 */
export async function closeAllPools(): Promise<void> {
  for (const [, pool] of pools) {
    await pool.end()
  }
  pools.clear()
}
