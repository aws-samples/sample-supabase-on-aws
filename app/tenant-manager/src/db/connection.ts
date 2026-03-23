/**
 * Database connection pool management
 * Three-pool architecture:
 * - Management pool: Kysely-wrapped pool for _supabase database CRUD
 * - System pool: Raw pg.Pool for postgres database DDL (CREATE/DROP DATABASE)
 * - Tenant factory: Creates temporary pg.Client connections to tenant databases
 */

import pg from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import type { Database } from './types.js'
import {
  getManagementPoolConfig,
  getSystemPoolConfig,
  getTenantClientConfig,
} from '../config/database.js'
import { closePlatformPool } from './platform-connection.js'

const { Pool, Client } = pg

let managementDb: Kysely<Database> | null = null
let managementPool: pg.Pool | null = null
let systemPool: pg.Pool | null = null

/**
 * Get the Kysely management database instance
 * Connects to _supabase database for projects/db_instances CRUD
 */
export function getManagementDb(): Kysely<Database> {
  if (!managementDb) {
    const config = getManagementPoolConfig()
    managementPool = new Pool(config)
    managementDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: managementPool,
      }),
    })
  }
  return managementDb
}

/**
 * Get the system pool for DDL operations
 * Connects to postgres database for CREATE/DROP DATABASE, etc.
 */
export function getSystemPool(): pg.Pool {
  if (!systemPool) {
    const config = getSystemPoolConfig()
    systemPool = new Pool(config)
  }
  return systemPool
}

/**
 * Create a temporary client connection to a specific tenant database
 * The caller is responsible for calling client.end() when done
 */
export async function createTenantClient(dbName: string): Promise<pg.Client> {
  const config = getTenantClientConfig(dbName)
  const client = new Client(config)
  await client.connect()
  return client
}

/**
 * Execute a query against a tenant database with automatic connection cleanup
 */
export async function withTenantClient<T>(
  dbName: string,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = await createTenantClient(dbName)
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * Close all connection pools
 * Should be called during graceful shutdown
 */
export async function closeAllPools(): Promise<void> {
  const errors: Error[] = []

  if (managementDb) {
    try {
      await managementDb.destroy()
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
    managementDb = null
    managementPool = null
  }

  if (systemPool) {
    try {
      await systemPool.end()
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
    systemPool = null
  }

  try {
    await closePlatformPool()
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)))
  }

  if (errors.length > 0) {
    console.error('Errors closing database pools:', errors.map((e) => e.message).join('; '))
  }
}

/**
 * Check if management database is reachable
 */
export async function checkManagementDbHealth(): Promise<{ healthy: boolean; latencyMs?: number }> {
  try {
    const start = Date.now()
    const db = getManagementDb()
    await db.selectFrom('_tenant.projects').select('id').limit(1).execute()
    return { healthy: true, latencyMs: Date.now() - start }
  } catch {
    return { healthy: false }
  }
}

/**
 * Check if system database is reachable
 */
export async function checkSystemDbHealth(): Promise<boolean> {
  try {
    const pool = getSystemPool()
    const result = await pool.query('SELECT 1')
    return result.rowCount === 1
  } catch {
    return false
  }
}
