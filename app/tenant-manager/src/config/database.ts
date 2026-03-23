/**
 * Database connection pool configuration
 */

import { getEnv } from './env.js'
import { getRdsSslConfig } from './ssl.js'

export interface PoolConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
  max: number
  idleTimeoutMillis: number
  connectionTimeoutMillis: number
  ssl: { rejectUnauthorized: true; ca: string } | false
}

/**
 * Get management pool config (connects to _supabase database)
 */
export function getManagementPoolConfig(): PoolConfig {
  const env = getEnv()
  return {
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER_READ_WRITE,
    password: env.POSTGRES_PASSWORD,
    database: '_supabase',
    max: env.MANAGEMENT_DB_POOL_SIZE,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: getRdsSslConfig(),
  }
}

/**
 * Get system pool config (connects to postgres database for DDL operations)
 */
export function getSystemPoolConfig(): PoolConfig {
  const env = getEnv()
  return {
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER_READ_WRITE,
    password: env.POSTGRES_PASSWORD,
    database: 'postgres',
    max: env.SYSTEM_DB_POOL_SIZE,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: getRdsSslConfig(),
  }
}

/**
 * Get tenant client config (connects to a specific tenant database)
 */
export function getTenantClientConfig(dbName: string): {
  host: string
  port: number
  user: string
  password: string
  database: string
  ssl: { rejectUnauthorized: true; ca: string } | false
} {
  const env = getEnv()
  return {
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER_READ_WRITE,
    password: env.POSTGRES_PASSWORD,
    database: dbName,
    ssl: getRdsSslConfig(),
  }
}
