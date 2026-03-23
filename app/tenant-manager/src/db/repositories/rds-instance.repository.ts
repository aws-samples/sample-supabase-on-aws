/**
 * RDS instance repository - Kysely-based queries for _tenant.db_instances table
 * Replaces all dblink-based RDS instance queries
 */

import { sql } from 'kysely'
import { getManagementDb } from '../connection.js'
import type { DbInstance, NewDbInstance, DbInstanceUpdate } from '../types.js'
import type { DbInstanceStatus } from '../../types/rds-instance.js'

export interface ListRdsInstancesOptions {
  status?: DbInstanceStatus
  region?: string
  page?: number
  limit?: number
}

/**
 * List RDS instances with filtering and pagination
 */
export async function findRdsInstances(options: ListRdsInstancesOptions = {}): Promise<DbInstance[]> {
  const { status, region, page = 1, limit = 50 } = options
  const offset = (page - 1) * limit
  const db = getManagementDb()

  let query = db.selectFrom('_tenant.db_instances').selectAll()

  if (status) {
    query = query.where('status', '=', status)
  }
  if (region) {
    query = query.where('region', '=', region)
  }

  return query.orderBy('id', 'asc').limit(limit).offset(offset).execute()
}

/**
 * Count RDS instances with filtering
 */
export async function countRdsInstances(
  options: Omit<ListRdsInstancesOptions, 'page' | 'limit'> = {}
): Promise<number> {
  const { status, region } = options
  const db = getManagementDb()

  let query = db
    .selectFrom('_tenant.db_instances')
    .select(sql<number>`count(*)::int`.as('count'))

  if (status) {
    query = query.where('status', '=', status)
  }
  if (region) {
    query = query.where('region', '=', region)
  }

  const result = await query.executeTakeFirstOrThrow()
  return result.count
}

/**
 * Get RDS instance by ID
 */
export async function findRdsInstanceById(id: number): Promise<DbInstance | null> {
  const db = getManagementDb()
  const result = await db
    .selectFrom('_tenant.db_instances')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  return result ?? null
}

/**
 * Get RDS instance by identifier
 */
export async function findRdsInstanceByIdentifier(identifier: string): Promise<DbInstance | null> {
  const db = getManagementDb()
  const result = await db
    .selectFrom('_tenant.db_instances')
    .selectAll()
    .where('identifier', '=', identifier)
    .executeTakeFirst()
  return result ?? null
}

/**
 * Create a new RDS instance
 */
export async function insertRdsInstance(instance: NewDbInstance): Promise<DbInstance> {
  const db = getManagementDb()
  return db
    .insertInto('_tenant.db_instances')
    .values(instance)
    .returningAll()
    .executeTakeFirstOrThrow()
}

/**
 * Update an RDS instance
 */
export async function updateRdsInstanceById(id: number, updates: DbInstanceUpdate): Promise<DbInstance | null> {
  const db = getManagementDb()
  const result = await db
    .updateTable('_tenant.db_instances')
    .set(updates)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
  return result ?? null
}

/**
 * Delete an RDS instance
 */
export async function deleteRdsInstanceById(id: number): Promise<boolean> {
  const db = getManagementDb()
  const result = await db
    .deleteFrom('_tenant.db_instances')
    .where('id', '=', id)
    .executeTakeFirst()
  return (result.numDeletedRows ?? 0n) > 0n
}

/**
 * Update current_databases count
 */
export async function updateDatabaseCount(id: number, delta: number): Promise<boolean> {
  const db = getManagementDb()
  const result = await db
    .updateTable('_tenant.db_instances')
    .set({
      current_databases: sql`current_databases + ${delta}`,
    })
    .where('id', '=', id)
    .executeTakeFirst()
  return (result.numUpdatedRows ?? 0n) > 0n
}

/**
 * Set instance status to draining
 */
export async function setDraining(id: number): Promise<boolean> {
  const db = getManagementDb()
  const result = await db
    .updateTable('_tenant.db_instances')
    .set({ status: 'draining' })
    .where('id', '=', id)
    .executeTakeFirst()
  return (result.numUpdatedRows ?? 0n) > 0n
}

/**
 * Get instances available for new projects (active and not full)
 */
export async function findAvailableInstances(): Promise<DbInstance[]> {
  const db = getManagementDb()
  return db
    .selectFrom('_tenant.db_instances')
    .selectAll()
    .where('status', '=', 'active')
    .where(({ eb }) => eb('current_databases', '<', eb.ref('max_databases')))
    .orderBy('weight', 'desc')
    .orderBy('current_databases', 'asc')
    .execute()
}
