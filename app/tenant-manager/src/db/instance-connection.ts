/**
 * Per-instance connection pool management for multi-RDS provisioning
 * Manages dynamic connection pools to individual RDS instances
 * Does NOT depend on connection.ts (avoids circular dependencies)
 */

import pg from 'pg'
import { getCredentialProvider } from '../common/crypto/credential-provider.js'
import { getRdsSslConfig } from '../config/ssl.js'
import type { DbInstance } from '../types/rds-instance.js'

const { Pool, Client } = pg

/**
 * Connection info resolved for a specific RDS instance
 */
export interface InstanceConnectionInfo {
  instanceId: number
  host: string
  port: number
  user: string
  password: string
}

// Cache of per-instance system pools (instanceId -> pg.Pool)
const instancePools = new Map<number, pg.Pool>()

/**
 * Resolve credentials for an RDS instance
 * Decrypts password or fetches from AWS Secrets Manager based on auth_method
 */
export async function resolveInstanceCredentials(instance: DbInstance): Promise<InstanceConnectionInfo> {
  const provider = getCredentialProvider(instance.auth_method)
  const password = await provider.getCredential(instance)

  return {
    instanceId: instance.id,
    host: instance.host,
    port: instance.port,
    user: instance.admin_user,
    password,
  }
}

/**
 * Get or create a system pool for a specific RDS instance
 * Connects to the 'postgres' database on the instance for DDL operations
 */
export function getInstanceSystemPool(conn: InstanceConnectionInfo): pg.Pool {
  let pool = instancePools.get(conn.instanceId)
  if (!pool) {
    pool = new Pool({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: 'postgres',
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: getRdsSslConfig(),
    })
    instancePools.set(conn.instanceId, pool)
  }
  return pool
}

/**
 * Execute a function with a temporary client connected to a specific database
 * on a specific RDS instance
 */
export async function withInstanceTenantClient<T>(
  conn: InstanceConnectionInfo,
  dbName: string,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: dbName,
    ssl: getRdsSslConfig(),
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * Remove and close a cached instance pool
 * Used when an instance is deleted or its connection info changes
 */
export async function removeInstancePool(instanceId: number): Promise<void> {
  const pool = instancePools.get(instanceId)
  if (pool) {
    try {
      await pool.end()
    } catch (error) {
      console.error(
        `Error closing pool for instance ${instanceId}:`,
        error instanceof Error ? error.message : error
      )
    }
    instancePools.delete(instanceId)
  }
}

/**
 * Close all cached instance pools
 * Should be called during graceful shutdown
 */
export async function closeAllInstancePools(): Promise<void> {
  const errors: Error[] = []

  for (const [instanceId, pool] of instancePools) {
    try {
      await pool.end()
    } catch (error) {
      errors.push(
        error instanceof Error ? error : new Error(`Failed to close pool for instance ${instanceId}`)
      )
    }
  }

  instancePools.clear()

  if (errors.length > 0) {
    console.error('Errors closing instance pools:', errors.map((e) => e.message).join('; '))
  }
}
