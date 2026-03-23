/**
 * Allocation Strategy Repository
 * 
 * Data access layer for allocation strategy operations.
 * Provides CRUD operations for the _studio.project_allocation_strategies table.
 */

import { executeSql } from 'data/sql/execute-sql-query'

export interface AllocationStrategyRecord {
  id: string
  name: string
  strategy_type: 'manual' | 'hash' | 'round_robin' | 'weighted_round_robin' | 'least_connections'
  description: string | null
  config: Record<string, any> | null
  is_active: boolean
  created_at: Date
  updated_at: Date
}

export interface AllocationStrategyRepository {
  findByName(name: string, projectRef: string, connectionString: string): Promise<AllocationStrategyRecord | null>
  findAll(projectRef: string, connectionString: string): Promise<AllocationStrategyRecord[]>
  findActive(projectRef: string, connectionString: string): Promise<AllocationStrategyRecord | null>
  create(strategy: Omit<AllocationStrategyRecord, 'id' | 'created_at' | 'updated_at'>, projectRef: string, connectionString: string): Promise<AllocationStrategyRecord>
  update(name: string, updates: Partial<AllocationStrategyRecord>, projectRef: string, connectionString: string): Promise<AllocationStrategyRecord>
  upsert(strategy: Omit<AllocationStrategyRecord, 'id' | 'created_at' | 'updated_at'>, projectRef: string, connectionString: string): Promise<AllocationStrategyRecord>
  delete(name: string, projectRef: string, connectionString: string): Promise<void>
}

/**
 * Default implementation of AllocationStrategyRepository using executeSql
 */
export class DefaultAllocationStrategyRepository implements AllocationStrategyRepository {
  async findByName(name: string, projectRef: string, connectionString: string): Promise<AllocationStrategyRecord | null> {
    const sql = /* SQL */ `
      SELECT * FROM _studio.project_allocation_strategies
      WHERE name = '${name}'
    `
    
    const { result } = await executeSql<AllocationStrategyRecord[]>({ projectRef, connectionString, sql })
    return result.length > 0 ? result[0] : null
  }

  async findAll(projectRef: string, connectionString: string): Promise<AllocationStrategyRecord[]> {
    const sql = /* SQL */ `
      SELECT * FROM _studio.project_allocation_strategies
      ORDER BY created_at DESC
    `
    
    const { result } = await executeSql<AllocationStrategyRecord[]>({ projectRef, connectionString, sql })
    return result
  }

  async findActive(projectRef: string, connectionString: string): Promise<AllocationStrategyRecord | null> {
    const sql = /* SQL */ `
      SELECT * FROM _studio.project_allocation_strategies
      WHERE is_active = true
      LIMIT 1
    `
    
    const { result } = await executeSql<AllocationStrategyRecord[]>({ projectRef, connectionString, sql })
    return result.length > 0 ? result[0] : null
  }

  async create(
    strategy: Omit<AllocationStrategyRecord, 'id' | 'created_at' | 'updated_at'>,
    projectRef: string,
    connectionString: string
  ): Promise<AllocationStrategyRecord> {
    const configJson = strategy.config ? JSON.stringify(strategy.config) : 'null'
    const description = strategy.description ? `'${strategy.description.replace(/'/g, "''")}'` : 'null'
    
    const sql = /* SQL */ `
      INSERT INTO _studio.project_allocation_strategies (
        name, strategy_type, description, config, is_active
      ) VALUES (
        '${strategy.name}',
        '${strategy.strategy_type}',
        ${description},
        '${configJson}'::jsonb,
        ${strategy.is_active}
      )
      RETURNING *
    `
    
    const { result } = await executeSql<AllocationStrategyRecord[]>({ projectRef, connectionString, sql })
    return result[0]
  }

  async update(
    name: string,
    updates: Partial<AllocationStrategyRecord>,
    projectRef: string,
    connectionString: string
  ): Promise<AllocationStrategyRecord> {
    const setClauses: string[] = []
    
    if (updates.strategy_type !== undefined) {
      setClauses.push(`strategy_type = '${updates.strategy_type}'`)
    }
    if (updates.description !== undefined) {
      const description = updates.description ? `'${updates.description.replace(/'/g, "''")}'` : 'null'
      setClauses.push(`description = ${description}`)
    }
    if (updates.config !== undefined) {
      const configJson = updates.config ? JSON.stringify(updates.config) : 'null'
      setClauses.push(`config = '${configJson}'::jsonb`)
    }
    if (updates.is_active !== undefined) {
      setClauses.push(`is_active = ${updates.is_active}`)
    }
    
    setClauses.push(`updated_at = NOW()`)
    
    const sql = /* SQL */ `
      UPDATE _studio.project_allocation_strategies
      SET ${setClauses.join(', ')}
      WHERE name = '${name}'
      RETURNING *
    `
    
    const { result } = await executeSql<AllocationStrategyRecord[]>({ projectRef, connectionString, sql })
    return result[0]
  }

  async upsert(
    strategy: Omit<AllocationStrategyRecord, 'id' | 'created_at' | 'updated_at'>,
    projectRef: string,
    connectionString: string
  ): Promise<AllocationStrategyRecord> {
    const configJson = strategy.config ? JSON.stringify(strategy.config) : 'null'
    const description = strategy.description ? `'${strategy.description.replace(/'/g, "''")}'` : 'null'
    
    const sql = /* SQL */ `
      INSERT INTO _studio.project_allocation_strategies (
        name, strategy_type, description, config, is_active
      ) VALUES (
        '${strategy.name}',
        '${strategy.strategy_type}',
        ${description},
        '${configJson}'::jsonb,
        ${strategy.is_active}
      )
      ON CONFLICT (name) DO UPDATE SET
        strategy_type = EXCLUDED.strategy_type,
        description = EXCLUDED.description,
        config = EXCLUDED.config,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
      RETURNING *
    `
    
    const { result } = await executeSql<AllocationStrategyRecord[]>({ projectRef, connectionString, sql })
    return result[0]
  }

  async delete(name: string, projectRef: string, connectionString: string): Promise<void> {
    const sql = /* SQL */ `
      DELETE FROM _studio.project_allocation_strategies
      WHERE name = '${name}'
    `
    
    await executeSql({ projectRef, connectionString, sql })
  }
}
