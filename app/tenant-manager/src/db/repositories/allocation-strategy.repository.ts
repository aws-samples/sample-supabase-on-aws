/**
 * Allocation strategy repository - CRUD for _tenant.project_allocation_strategies
 */

import { getManagementDb } from '../connection.js'
import type { AllocationStrategyRow, NewAllocationStrategy, AllocationStrategyUpdate } from '../types.js'

/**
 * Find the currently active strategy
 */
export async function findActiveStrategy(): Promise<AllocationStrategyRow | null> {
  const db = getManagementDb()
  const result = await db
    .selectFrom('_tenant.project_allocation_strategies')
    .selectAll()
    .where('is_active', '=', true)
    .executeTakeFirst()
  return result ?? null
}

/**
 * Find all strategies
 */
export async function findAllStrategies(): Promise<AllocationStrategyRow[]> {
  const db = getManagementDb()
  return db
    .selectFrom('_tenant.project_allocation_strategies')
    .selectAll()
    .orderBy('created_at', 'desc')
    .execute()
}

/**
 * Find strategy by name
 */
export async function findStrategyByName(name: string): Promise<AllocationStrategyRow | null> {
  const db = getManagementDb()
  const result = await db
    .selectFrom('_tenant.project_allocation_strategies')
    .selectAll()
    .where('name', '=', name)
    .executeTakeFirst()
  return result ?? null
}

/**
 * Create a new strategy
 */
export async function insertStrategy(strategy: NewAllocationStrategy): Promise<AllocationStrategyRow> {
  const db = getManagementDb()
  return db
    .insertInto('_tenant.project_allocation_strategies')
    .values({
      ...strategy,
      config: strategy.config ? JSON.stringify(strategy.config) : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

/**
 * Update a strategy by name
 */
export async function updateStrategyByName(
  name: string,
  updates: AllocationStrategyUpdate
): Promise<AllocationStrategyRow | null> {
  const db = getManagementDb()
  const updateData: Record<string, unknown> = { ...updates, updated_at: new Date() }
  if (updates['config'] !== undefined) {
    updateData['config'] = updates['config'] ? JSON.stringify(updates['config']) : null
  }
  const result = await db
    .updateTable('_tenant.project_allocation_strategies')
    .set(updateData)
    .where('name', '=', name)
    .returningAll()
    .executeTakeFirst()
  return result ?? null
}

/**
 * Delete a strategy by name
 */
export async function deleteStrategyByName(name: string): Promise<boolean> {
  const db = getManagementDb()
  const result = await db
    .deleteFrom('_tenant.project_allocation_strategies')
    .where('name', '=', name)
    .executeTakeFirst()
  return (result.numDeletedRows ?? 0n) > 0n
}

/**
 * Activate a strategy (deactivates all others in a transaction)
 */
export async function activateStrategy(name: string): Promise<AllocationStrategyRow | null> {
  const db = getManagementDb()

  return db.transaction().execute(async (trx) => {
    // Deactivate all strategies
    await trx
      .updateTable('_tenant.project_allocation_strategies')
      .set({ is_active: false, updated_at: new Date() })
      .where('is_active', '=', true)
      .execute()

    // Activate the target strategy
    const result = await trx
      .updateTable('_tenant.project_allocation_strategies')
      .set({ is_active: true, updated_at: new Date() })
      .where('name', '=', name)
      .returningAll()
      .executeTakeFirst()

    return result ?? null
  })
}
