import { NextApiRequest, NextApiResponse } from 'next'
import { getProjectDatabaseClient } from './project-database-client'
import { ProjectIsolationContext } from './secure-api-wrapper'
import { DataApiConfigResponse } from './data-api-config-data-access'

/**
 * Project-specific PostgREST-like engine
 * Implements core PostgREST functionality for project-specific databases
 */
export class ProjectPostgRESTEngine {
  constructor(
    private context: ProjectIsolationContext,
    private config: DataApiConfigResponse
  ) {}

  /**
   * Handle REST API request using PostgREST-like logic
   */
  async handleRequest(req: NextApiRequest, res: NextApiResponse, tableName: string): Promise<void> {
    const { method } = req
    
    try {
      switch (method) {
        case 'GET':
          await this.handleSelect(req, res, tableName)
          break
        case 'POST':
          await this.handleInsert(req, res, tableName)
          break
        case 'PATCH':
          await this.handleUpdate(req, res, tableName)
          break
        case 'DELETE':
          await this.handleDelete(req, res, tableName)
          break
        default:
          res.status(405).json({
            code: 'METHOD_NOT_ALLOWED',
            message: `HTTP method ${method} is not supported`,
            hint: 'Use GET, POST, PATCH, or DELETE methods'
          })
      }
    } catch (error) {
      console.error('PostgREST engine error:', error)
      
      if (error instanceof Error) {
        if (error.message.includes('relation') && error.message.includes('does not exist')) {
          return res.status(404).json({
            code: 'PGRST116',
            message: `The result contains 0 rows`,
            details: `Could not find the relation "${tableName}" in the schema cache`,
            hint: 'Verify that the table exists and is accessible'
          })
        }
        
        if (error.message.includes('permission denied')) {
          return res.status(403).json({
            code: 'PGRST301',
            message: 'Permission denied',
            details: error.message,
            hint: 'Check that the database user has the required permissions'
          })
        }
      }
      
      res.status(500).json({
        code: 'PGRST000',
        message: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  /**
   * Handle SELECT queries (GET requests)
   */
  private async handleSelect(req: NextApiRequest, res: NextApiResponse, tableName: string): Promise<void> {
    const projectDbClient = getProjectDatabaseClient()
    
    // Parse select parameter
    const selectParam = req.query.select as string
    const selectClause = selectParam && selectParam !== '*' ? selectParam : '*'
    
    // Build SELECT query
    let query = `SELECT ${selectClause} FROM ${tableName}`
    const params: any[] = []
    const whereConditions: string[] = []
    let paramIndex = 1
    
    // Parse query parameters for filtering
    for (const [key, value] of Object.entries(req.query)) {
      // Skip special parameters
      if (['path', 'limit', 'offset', 'order', 'select'].includes(key)) continue
      
      // Handle array values (multiple conditions for same column)
      const values = Array.isArray(value) ? value : [value]
      
      for (const val of values) {
        if (typeof val === 'string') {
          // Handle PostgREST operator format: ?column=operator.value or ?column.operator=value
          if (key.includes('.')) {
            // Format: ?column.operator=value (e.g., ?id.eq=5)
            const [column, operator] = key.split('.')
            this.addWhereCondition(whereConditions, params, column, operator, val, paramIndex)
            paramIndex++
          } else if (val.includes('.')) {
            // Format: ?column=operator.value (e.g., ?id=eq.5)
            const [operator, ...valueParts] = val.split('.')
            const actualValue = valueParts.join('.') // Handle values with dots
            this.addWhereCondition(whereConditions, params, key, operator, actualValue, paramIndex)
            paramIndex++
          } else {
            // Simple equality
            whereConditions.push(`${key} = $${paramIndex}`)
            params.push(val)
            paramIndex++
          }
        }
      }
    }
    
    if (whereConditions.length > 0) {
      query += ` WHERE ${whereConditions.join(' AND ')}`
    }
    
    // Handle ordering
    const orderParam = req.query.order as string
    if (orderParam) {
      const orderClauses = orderParam.split(',').map(clause => {
        const [column, direction] = clause.split('.')
        return `${column} ${direction?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`
      })
      query += ` ORDER BY ${orderClauses.join(', ')}`
    }
    
    // Handle pagination
    const limitParam = req.query.limit as string
    const offsetParam = req.query.offset as string
    
    if (limitParam) {
      const limit = Math.min(parseInt(limitParam, 10), this.config.maxRows)
      query += ` LIMIT ${limit}`
    } else {
      query += ` LIMIT ${this.config.maxRows}`
    }
    
    if (offsetParam) {
      const offset = parseInt(offsetParam, 10)
      query += ` OFFSET ${offset}`
    }
    
    const result = await projectDbClient.queryProjectDatabase(
      this.context.projectRef,
      this.context.userId,
      query,
      params,
      { skipPermissionCheck: true } // Skip permission check since project isolation middleware already validated
    )
    
    // Set PostgREST-like headers
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Range', `0-${result.rows.length - 1}/*`)
    
    res.status(200).json(result.rows)
  }

  /**
   * Handle INSERT queries (POST requests)
   */
  private async handleInsert(req: NextApiRequest, res: NextApiResponse, tableName: string): Promise<void> {
    const projectDbClient = getProjectDatabaseClient()
    const data = req.body
    
    console.log(`[handleInsert] Starting INSERT for table: ${tableName}, projectRef: ${this.context.projectRef}, userId: ${this.context.userId}`)
    
    if (!data || typeof data !== 'object') {
      return res.status(400).json({
        code: 'PGRST102',
        message: 'Invalid JSON in request body',
        hint: 'Provide the data to insert as a JSON object'
      })
    }
    
    // Handle both single object and array of objects
    const records = Array.isArray(data) ? data : [data]
    const results: any[] = []
    
    for (const record of records) {
      const columns = Object.keys(record)
      const values = Object.values(record)
      
      let query: string
      if (columns.length === 0) {
        query = `INSERT INTO ${tableName} DEFAULT VALUES RETURNING *`
      } else {
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ')
        query = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`
      }
      
      console.log(`[handleInsert] Executing query: ${query}`)
      console.log(`[handleInsert] Values:`, values)
      
      const result = await projectDbClient.queryProjectDatabase(
        this.context.projectRef,
        this.context.userId,
        query,
        values,
        { skipPermissionCheck: true }
      )
      
      console.log(`[handleInsert] Query successful, rows returned: ${result.rows?.length || 0}`)
      
      if (result.rows.length > 0) {
        results.push(result.rows[0])
      }
    }
    
    res.setHeader('Content-Type', 'application/json')
    res.status(201).json(Array.isArray(data) ? results : results[0])
  }

  /**
   * Handle UPDATE queries (PATCH requests)
   */
  private async handleUpdate(req: NextApiRequest, res: NextApiResponse, tableName: string): Promise<void> {
    const projectDbClient = getProjectDatabaseClient()
    const data = req.body
    
    if (!data || typeof data !== 'object') {
      return res.status(400).json({
        code: 'PGRST102',
        message: 'Invalid JSON in request body',
        hint: 'Provide the data to update as a JSON object'
      })
    }
    
    // Build UPDATE query
    const columns = Object.keys(data)
    const values = Object.values(data)
    const setClause = columns.map((col, index) => `${col} = $${index + 1}`).join(', ')
    
    // Add WHERE conditions from query parameters
    const whereConditions: string[] = []
    let paramIndex = values.length + 1
    
    for (const [key, value] of Object.entries(req.query)) {
      if (key === 'path' || typeof value !== 'string') continue
      
      if (key.includes('.')) {
        // Format: ?column.operator=value (e.g., ?id.eq=5)
        const [column, operator] = key.split('.')
        this.addWhereCondition(whereConditions, values, column, operator, value, paramIndex)
        paramIndex++
      } else if (value.includes('.')) {
        // Format: ?column=operator.value (e.g., ?id=eq.5)
        const [operator, ...valueParts] = value.split('.')
        const actualValue = valueParts.join('.') // Handle values with dots
        this.addWhereCondition(whereConditions, values, key, operator, actualValue, paramIndex)
        paramIndex++
      } else {
        whereConditions.push(`${key} = $${paramIndex}`)
        values.push(value)
        paramIndex++
      }
    }
    
    if (whereConditions.length === 0) {
      return res.status(400).json({
        code: 'PGRST100',
        message: 'No conditions specified for update',
        hint: 'Add query parameters to specify which records to update'
      })
    }
    
    const query = `
      UPDATE ${tableName}
      SET ${setClause}
      WHERE ${whereConditions.join(' AND ')}
      RETURNING *
    `
    
    const result = await projectDbClient.queryProjectDatabase(
      this.context.projectRef,
      this.context.userId,
      query,
      values,
      { skipPermissionCheck: true } // Skip permission check since project isolation middleware already validated
    )
    
    res.setHeader('Content-Type', 'application/json')
    res.status(200).json(result.rows)
  }

  /**
   * Handle DELETE queries (DELETE requests)
   */
  private async handleDelete(req: NextApiRequest, res: NextApiResponse, tableName: string): Promise<void> {
    const projectDbClient = getProjectDatabaseClient()
    
    // Add WHERE conditions from query parameters
    const whereConditions: string[] = []
    const params: any[] = []
    let paramIndex = 1
    
    for (const [key, value] of Object.entries(req.query)) {
      if (key === 'path' || typeof value !== 'string') continue
      
      if (key.includes('.')) {
        // Format: ?column.operator=value (e.g., ?id.eq=5)
        const [column, operator] = key.split('.')
        this.addWhereCondition(whereConditions, params, column, operator, value, paramIndex)
        paramIndex++
      } else if (value.includes('.')) {
        // Format: ?column=operator.value (e.g., ?id=eq.5)
        const [operator, ...valueParts] = value.split('.')
        const actualValue = valueParts.join('.') // Handle values with dots
        this.addWhereCondition(whereConditions, params, key, operator, actualValue, paramIndex)
        paramIndex++
      } else {
        whereConditions.push(`${key} = $${paramIndex}`)
        params.push(value)
        paramIndex++
      }
    }
    
    if (whereConditions.length === 0) {
      return res.status(400).json({
        code: 'PGRST100',
        message: 'No conditions specified for delete',
        hint: 'Add query parameters to specify which records to delete'
      })
    }
    
    const query = `
      DELETE FROM ${tableName}
      WHERE ${whereConditions.join(' AND ')}
      RETURNING *
    `
    
    const result = await projectDbClient.queryProjectDatabase(
      this.context.projectRef,
      this.context.userId,
      query,
      params,
      { skipPermissionCheck: true } // Skip permission check since project isolation middleware already validated
    )
    
    res.setHeader('Content-Type', 'application/json')
    res.status(200).json(result.rows)
  }

  /**
   * Add WHERE condition based on PostgREST operator
   */
  private addWhereCondition(
    whereConditions: string[],
    params: any[],
    column: string,
    operator: string,
    value: string,
    paramIndex: number
  ): void {
    switch (operator) {
      case 'eq':
        whereConditions.push(`${column} = $${paramIndex}`)
        params.push(value)
        break
      case 'neq':
        whereConditions.push(`${column} != $${paramIndex}`)
        params.push(value)
        break
      case 'gt':
        whereConditions.push(`${column} > $${paramIndex}`)
        params.push(value)
        break
      case 'gte':
        whereConditions.push(`${column} >= $${paramIndex}`)
        params.push(value)
        break
      case 'lt':
        whereConditions.push(`${column} < $${paramIndex}`)
        params.push(value)
        break
      case 'lte':
        whereConditions.push(`${column} <= $${paramIndex}`)
        params.push(value)
        break
      case 'like':
        whereConditions.push(`${column} LIKE $${paramIndex}`)
        params.push(value)
        break
      case 'ilike':
        whereConditions.push(`${column} ILIKE $${paramIndex}`)
        params.push(value)
        break
      case 'in':
        const values = value.split(',')
        const placeholders = values.map((_, i) => `$${paramIndex + i}`).join(',')
        whereConditions.push(`${column} IN (${placeholders})`)
        params.push(...values)
        break
      case 'is':
        if (value.toLowerCase() === 'null') {
          whereConditions.push(`${column} IS NULL`)
        } else {
          whereConditions.push(`${column} = $${paramIndex}`)
          params.push(value)
        }
        break
      default:
        // Default to equality
        whereConditions.push(`${column} = $${paramIndex}`)
        params.push(value)
    }
  }
}

/**
 * Factory function to create a project PostgREST engine
 */
export function createProjectPostgRESTEngine(
  context: ProjectIsolationContext,
  config: DataApiConfigResponse
): ProjectPostgRESTEngine {
  return new ProjectPostgRESTEngine(context, config)
}