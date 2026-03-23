/**
 * Cluster Repository
 * 
 * Data access layer for database cluster operations.
 * Provides CRUD operations for the _studio.db_instances table.
 * 
 * Requirements: 14.3
 */

import { executeQuery } from './database-client'
import type { Cluster } from './types'

/**
 * Custom error for database connection failures
 */
class DatabaseConnectionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message)
    this.name = 'DatabaseConnectionError'
  }
}

export interface ClusterRepository {
  findById(id: number, connectionString: string): Promise<Cluster | null>
  findByIdentifier(identifier: string, connectionString: string): Promise<Cluster | null>
  findAll(connectionString: string): Promise<Cluster[]>
  findByStatus(status: string, connectionString: string): Promise<Cluster[]>
  findByRegion(region: string, connectionString: string): Promise<Cluster[]>
  create(cluster: Omit<Cluster, 'id' | 'created_at' | 'updated_at'>, connectionString: string): Promise<Cluster>
  update(id: number, updates: Partial<Cluster>, connectionString: string): Promise<Cluster>
  delete(id: number, connectionString: string): Promise<void>
  updateStatus(identifier: string, status: string, connectionString: string): Promise<Cluster>
  updateCapacity(identifier: string, maxDatabases: number, connectionString: string): Promise<Cluster>
  incrementCurrentDatabases(identifier: string, connectionString: string): Promise<void>
  decrementCurrentDatabases(identifier: string, connectionString: string): Promise<void>
}

/**
 * Default implementation of ClusterRepository using executeSql
 * 
 * Wraps all database operations with error handling for connection failures.
 */
export class DefaultClusterRepository implements ClusterRepository {
  /**
   * Execute SQL with error handling
   */
  private async executeSqlWithErrorHandling<T>(
    sql: string,
    connectionString: string,
    operation: string
  ): Promise<T> {
    try {
      const result = await executeQuery<T>(connectionString, sql)
      return result as unknown as T
    } catch (error) {
      // Check for connection-related errors
      if (
        error instanceof Error &&
        (error.message.includes('connection') ||
          error.message.includes('ECONNREFUSED') ||
          error.message.includes('ETIMEDOUT') ||
          error.message.includes('timeout'))
      ) {
        throw new DatabaseConnectionError(
          `Database connection failed during ${operation}`,
          error
        )
      }
      
      // Re-throw other errors
      throw error
    }
  }

  async findById(id: number, connectionString: string): Promise<Cluster | null> {
    const sql = /* SQL */ `
      SELECT * FROM _studio.db_instances
      WHERE id = ${id}
    `
    
    const result = await this.executeSqlWithErrorHandling<Cluster[]>(
      sql,
      connectionString,
      'findById'
    )
    return result.length > 0 ? result[0] : null
  }

  async findByIdentifier(identifier: string, connectionString: string): Promise<Cluster | null> {
    const sql = /* SQL */ `
      SELECT * FROM _studio.db_instances
      WHERE identifier = '${identifier}'
    `
    
    const result = await this.executeSqlWithErrorHandling<Cluster[]>(
      sql,
      connectionString,
      'findByIdentifier'
    )
    return result.length > 0 ? result[0] : null
  }

  async findAll(connectionString: string): Promise<Cluster[]> {
    const sql = /* SQL */ `
      SELECT * FROM _studio.db_instances
      ORDER BY created_at DESC
    `
    
    return await this.executeSqlWithErrorHandling<Cluster[]>(
      sql,
      connectionString,
      'findAll'
    )
  }

  async findByStatus(status: string, connectionString: string): Promise<Cluster[]> {
    const sql = /* SQL */ `
      SELECT * FROM _studio.db_instances
      WHERE status = '${status}'
      ORDER BY created_at DESC
    `
    
    return await this.executeSqlWithErrorHandling<Cluster[]>(
      sql,
      connectionString,
      'findByStatus'
    )
  }

  async findByRegion(region: string, connectionString: string): Promise<Cluster[]> {
    const sql = /* SQL */ `
      SELECT * FROM _studio.db_instances
      WHERE region = '${region}'
      ORDER BY created_at DESC
    `
    
    return await this.executeSqlWithErrorHandling<Cluster[]>(
      sql,
      connectionString,
      'findByRegion'
    )
  }

  async create(
    cluster: Omit<Cluster, 'id' | 'created_at' | 'updated_at'>,
    connectionString: string
  ): Promise<Cluster> {
    const sql = /* SQL */ `
      INSERT INTO _studio.db_instances (
        identifier, name, host, port, admin_user, auth_method, admin_credential,
        is_management_instance, region, status, weight, max_databases, current_databases
      ) VALUES (
        '${cluster.identifier}',
        '${cluster.name}',
        '${cluster.host}',
        ${cluster.port},
        '${cluster.admin_user}',
        '${cluster.auth_method}',
        '${cluster.admin_credential}',
        ${cluster.is_management_instance},
        '${cluster.region}',
        '${cluster.status}',
        ${cluster.weight},
        ${cluster.max_databases},
        ${cluster.current_databases}
      )
      RETURNING *
    `
    
    const result = await this.executeSqlWithErrorHandling<Cluster[]>(
      sql,
      connectionString,
      'create'
    )
    return result[0]
  }

  async update(
    id: number,
    updates: Partial<Cluster>,
    connectionString: string
  ): Promise<Cluster> {
    const setClauses: string[] = []
    
    if (updates.name !== undefined) setClauses.push(`name = '${updates.name}'`)
    if (updates.host !== undefined) setClauses.push(`host = '${updates.host}'`)
    if (updates.port !== undefined) setClauses.push(`port = ${updates.port}`)
    if (updates.admin_user !== undefined) setClauses.push(`admin_user = '${updates.admin_user}'`)
    if (updates.auth_method !== undefined) setClauses.push(`auth_method = '${updates.auth_method}'`)
    if (updates.admin_credential !== undefined) setClauses.push(`admin_credential = '${updates.admin_credential}'`)
    if (updates.region !== undefined) setClauses.push(`region = '${updates.region}'`)
    if (updates.status !== undefined) setClauses.push(`status = '${updates.status}'`)
    if (updates.weight !== undefined) setClauses.push(`weight = ${updates.weight}`)
    if (updates.max_databases !== undefined) setClauses.push(`max_databases = ${updates.max_databases}`)
    if (updates.current_databases !== undefined) setClauses.push(`current_databases = ${updates.current_databases}`)
    
    setClauses.push(`updated_at = NOW()`)
    
    const sql = /* SQL */ `
      UPDATE _studio.db_instances
      SET ${setClauses.join(', ')}
      WHERE id = ${id}
      RETURNING *
    `
    
    const result = await this.executeSqlWithErrorHandling<Cluster[]>(
      sql,
      connectionString,
      'update'
    )
    return result[0]
  }

  async delete(id: number, connectionString: string): Promise<void> {
    const sql = /* SQL */ `
      DELETE FROM _studio.db_instances
      WHERE id = ${id}
    `
    
    await this.executeSqlWithErrorHandling<void>(
      sql,
      connectionString,
      'delete'
    )
  }

  async updateStatus(
    identifier: string,
    status: string,
    connectionString: string
  ): Promise<Cluster> {
    const sql = /* SQL */ `
      UPDATE _studio.db_instances
      SET status = '${status}', updated_at = NOW()
      WHERE identifier = '${identifier}'
      RETURNING *
    `
    
    const result = await this.executeSqlWithErrorHandling<Cluster[]>(
      sql,
      connectionString,
      'updateStatus'
    )
    if (result.length === 0) {
      throw new Error(`Cluster with identifier '${identifier}' not found`)
    }
    return result[0]
  }

  async updateCapacity(
    identifier: string,
    maxDatabases: number,
    connectionString: string
  ): Promise<Cluster> {
    const sql = /* SQL */ `
      UPDATE _studio.db_instances
      SET max_databases = ${maxDatabases}, updated_at = NOW()
      WHERE identifier = '${identifier}'
      RETURNING *
    `
    
    const result = await this.executeSqlWithErrorHandling<Cluster[]>(
      sql,
      connectionString,
      'updateCapacity'
    )
    if (result.length === 0) {
      throw new Error(`Cluster with identifier '${identifier}' not found`)
    }
    return result[0]
  }

  async incrementCurrentDatabases(
    identifier: string,
    connectionString: string
  ): Promise<void> {
    const sql = /* SQL */ `
      UPDATE _studio.db_instances
      SET current_databases = current_databases + 1, updated_at = NOW()
      WHERE identifier = '${identifier}'
    `
    
    await this.executeSqlWithErrorHandling<void>(
      sql,
      connectionString,
      'incrementCurrentDatabases'
    )
  }

  async decrementCurrentDatabases(
    identifier: string,
    connectionString: string
  ): Promise<void> {
    const sql = /* SQL */ `
      UPDATE _studio.db_instances
      SET current_databases = current_databases - 1, updated_at = NOW()
      WHERE identifier = '${identifier}'
      AND current_databases > 0
    `
    
    await this.executeSqlWithErrorHandling<void>(
      sql,
      connectionString,
      'decrementCurrentDatabases'
    )
  }
}
