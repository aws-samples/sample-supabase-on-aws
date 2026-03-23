import { NextApiRequest } from 'next'
import { ProjectIsolationContext } from './secure-api-wrapper'
import { getProjectDatabaseClient } from './project-database-client'

/**
 * Aggregate Query Service
 * Handles aggregate function support for PostgREST
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */
export class AggregateQueryService {
  private static instance: AggregateQueryService

  private constructor() {}

  static getInstance(): AggregateQueryService {
    if (!AggregateQueryService.instance) {
      AggregateQueryService.instance = new AggregateQueryService()
    }
    return AggregateQueryService.instance
  }

  /**
   * Parse aggregate functions from select parameter
   * Requirements: 5.1
   */
  parseAggregateOperations(selectParam: string): AggregateOperation[] {
    const operations: AggregateOperation[] = []
    
    if (!selectParam || typeof selectParam !== 'string') {
      return operations
    }

    // Split by comma and parse each selection
    const selections = selectParam.split(',').map(s => s.trim())
    
    for (const selection of selections) {
      const aggregateOp = this.parseAggregateFunction(selection)
      if (aggregateOp) {
        operations.push(aggregateOp)
      }
    }

    return operations
  }

  /**
   * Parse a single aggregate function
   * Requirements: 5.1
   */
  private parseAggregateFunction(selection: string): AggregateOperation | null {
    // Match patterns like: count(*), sum(price), avg(rating), max(created_at), min(id)
    const aggregatePattern = /^(count|sum|avg|min|max)\s*\(\s*([^)]+)\s*\)(?:\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*))?\s*$/i
    const match = selection.match(aggregatePattern)
    
    if (!match) {
      return null
    }

    const [, functionName, column, alias] = match
    const func = functionName.toLowerCase() as AggregateFunction

    // Validate function
    if (!this.isValidAggregateFunction(func)) {
      return null
    }

    // Handle special case for count(*)
    const targetColumn = column.trim() === '*' ? '*' : column.trim()

    // Validate column name (except for count(*))
    if (targetColumn !== '*' && !this.isValidColumnName(targetColumn)) {
      return null
    }

    return {
      function: func,
      column: targetColumn,
      alias: alias || `${func}_${targetColumn === '*' ? 'all' : targetColumn}`
    }
  }

  /**
   * Parse GROUP BY clause from query parameters
   * Requirements: 5.2
   */
  parseGroupBy(query: Record<string, any>): string[] {
    const groupByParam = query.group_by || query.groupBy
    
    if (!groupByParam || typeof groupByParam !== 'string') {
      return []
    }

    return groupByParam
      .split(',')
      .map(col => col.trim())
      .filter(col => col.length > 0 && this.isValidColumnName(col))
  }

  /**
   * Parse HAVING clause from query parameters
   * Requirements: 5.2
   */
  parseHavingClause(query: Record<string, any>): HavingFilter[] {
    const havingFilters: HavingFilter[] = []

    for (const [key, value] of Object.entries(query)) {
      // Look for having filters with pattern: having.aggregate_alias.operator
      if (key.startsWith('having.')) {
        const parts = key.split('.')
        if (parts.length >= 3) {
          const aggregateAlias = parts[1]
          const operator = parts[2] as HavingOperator

          if (this.isValidHavingOperator(operator)) {
            havingFilters.push({
              aggregateAlias,
              operator,
              value: this.parseHavingValue(operator, value)
            })
          }
        }
      }
    }

    return havingFilters
  }

  /**
   * Parse regular filters (WHERE clause) from query parameters
   * Requirements: 5.4
   */
  parseWhereFilters(query: Record<string, any>): WhereFilter[] {
    const whereFilters: WhereFilter[] = []

    for (const [key, value] of Object.entries(query)) {
      // Skip special parameters (including Next.js route parameters)
      if (['select', 'order', 'limit', 'offset', 'count', 'schema', 'group_by', 'groupBy', 'path', 'ref'].includes(key) ||
          key.startsWith('having.')) {
        continue
      }

      // Parse filter operators
      const parts = key.split('.')
      if (parts.length >= 2) {
        const column = parts[0]
        const operator = parts[1] as WhereOperator
        
        if (this.isValidWhereOperator(operator) && this.isValidColumnName(column)) {
          whereFilters.push({
            column,
            operator,
            value: this.parseWhereValue(operator, value)
          })
        }
      } else {
        // Check if value contains operator (format: ?column=operator.value)
        if (typeof value === 'string' && value.includes('.')) {
          const valueParts = value.split('.')
          const operator = valueParts[0] as WhereOperator
          
          if (this.isValidWhereOperator(operator)) {
            const actualValue = valueParts.slice(1).join('.')
            whereFilters.push({
              column: key,
              operator,
              value: this.parseWhereValue(operator, actualValue)
            })
            continue
          }
        }
        
        // Default to equality filter
        if (this.isValidColumnName(key)) {
          whereFilters.push({
            column: key,
            operator: 'eq',
            value
          })
        }
      }
    }

    return whereFilters
  }

  /**
   * Build aggregate SQL query
   * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
   */
  buildAggregateQuery(
    tableName: string,
    aggregateOps: AggregateOperation[],
    groupBy: string[],
    whereFilters: WhereFilter[],
    havingFilters: HavingFilter[],
    orderBy?: string,
    limit?: number,
    offset?: number
  ): { query: string; params: any[] } {
    const params: any[] = []
    let paramIndex = 1

    // Build SELECT clause
    const selectParts: string[] = []
    
    // Add GROUP BY columns to SELECT
    for (const col of groupBy) {
      selectParts.push(this.escapeIdentifier(col))
    }
    
    // Add aggregate functions to SELECT
    for (const op of aggregateOps) {
      const aggregateExpr = this.buildAggregateExpression(op)
      selectParts.push(`${aggregateExpr} AS ${this.escapeIdentifier(op.alias)}`)
    }

    const selectClause = selectParts.join(', ')
    let query = `SELECT ${selectClause} FROM ${this.escapeIdentifier(tableName)}`

    // Build WHERE clause
    if (whereFilters.length > 0) {
      const whereClause = this.buildWhereClause(whereFilters, paramIndex)
      query += ` WHERE ${whereClause.clause}`
      params.push(...whereClause.params)
      paramIndex += whereClause.params.length
    }

    // Build GROUP BY clause
    if (groupBy.length > 0) {
      const groupByClause = groupBy.map(col => this.escapeIdentifier(col)).join(', ')
      query += ` GROUP BY ${groupByClause}`
    }

    // Build HAVING clause
    if (havingFilters.length > 0) {
      const havingClause = this.buildHavingClause(havingFilters, paramIndex)
      query += ` HAVING ${havingClause.clause}`
      params.push(...havingClause.params)
      paramIndex += havingClause.params.length
    }

    // Build ORDER BY clause
    if (orderBy) {
      const sanitizedOrderBy = this.sanitizeOrderBy(orderBy)
      if (sanitizedOrderBy) {
        query += ` ORDER BY ${sanitizedOrderBy}`
      }
    }

    // Add LIMIT and OFFSET for pagination
    if (limit && limit > 0) {
      query += ` LIMIT ${Math.min(limit, 1000)}` // Cap at 1000 for safety
    }

    if (offset && offset > 0) {
      query += ` OFFSET ${offset}`
    }

    return { query, params }
  }

  /**
   * Build aggregate expression
   * Requirements: 5.1
   */
  private buildAggregateExpression(op: AggregateOperation): string {
    const { function: func, column } = op

    switch (func) {
      case 'count':
        return column === '*' ? 'COUNT(*)' : `COUNT(${this.escapeIdentifier(column)})`
      case 'sum':
        return `SUM(${this.escapeIdentifier(column)})`
      case 'avg':
        return `AVG(${this.escapeIdentifier(column)})`
      case 'min':
        return `MIN(${this.escapeIdentifier(column)})`
      case 'max':
        return `MAX(${this.escapeIdentifier(column)})`
      default:
        throw new Error(`Unsupported aggregate function: ${func}`)
    }
  }

  /**
   * Build WHERE clause
   * Requirements: 5.4
   */
  private buildWhereClause(filters: WhereFilter[], startParamIndex: number): { clause: string; params: any[] } {
    const conditions: string[] = []
    const params: any[] = []
    let paramIndex = startParamIndex

    for (const filter of filters) {
      const condition = this.buildWhereCondition(filter, paramIndex)
      if (condition) {
        conditions.push(condition.clause)
        params.push(...condition.params)
        paramIndex += condition.params.length
      }
    }

    return {
      clause: conditions.join(' AND '),
      params
    }
  }

  /**
   * Build single WHERE condition
   * Requirements: 5.4
   */
  private buildWhereCondition(filter: WhereFilter, paramIndex: number): { clause: string; params: any[] } | null {
    const { column, operator, value } = filter
    const columnRef = this.escapeIdentifier(column)

    switch (operator) {
      case 'eq':
        return { clause: `${columnRef} = $${paramIndex}`, params: [value] }
      case 'neq':
        return { clause: `${columnRef} != $${paramIndex}`, params: [value] }
      case 'gt':
        return { clause: `${columnRef} > $${paramIndex}`, params: [value] }
      case 'gte':
        return { clause: `${columnRef} >= $${paramIndex}`, params: [value] }
      case 'lt':
        return { clause: `${columnRef} < $${paramIndex}`, params: [value] }
      case 'lte':
        return { clause: `${columnRef} <= $${paramIndex}`, params: [value] }
      case 'like':
        return { clause: `${columnRef} LIKE $${paramIndex}`, params: [value] }
      case 'ilike':
        return { clause: `${columnRef} ILIKE $${paramIndex}`, params: [value] }
      case 'in':
        if (Array.isArray(value)) {
          const placeholders = value.map((_, i) => `$${paramIndex + i}`).join(', ')
          return { clause: `${columnRef} IN (${placeholders})`, params: value }
        }
        return { clause: `${columnRef} = $${paramIndex}`, params: [value] }
      case 'is':
        if (value === null) {
          return { clause: `${columnRef} IS NULL`, params: [] }
        } else if (value === true) {
          return { clause: `${columnRef} IS TRUE`, params: [] }
        } else if (value === false) {
          return { clause: `${columnRef} IS FALSE`, params: [] }
        }
        return { clause: `${columnRef} = $${paramIndex}`, params: [value] }
      default:
        console.warn(`Unsupported WHERE operator: ${operator}`)
        return null
    }
  }

  /**
   * Build HAVING clause
   * Requirements: 5.2
   */
  private buildHavingClause(filters: HavingFilter[], startParamIndex: number): { clause: string; params: any[] } {
    const conditions: string[] = []
    const params: any[] = []
    let paramIndex = startParamIndex

    for (const filter of filters) {
      const condition = this.buildHavingCondition(filter, paramIndex)
      if (condition) {
        conditions.push(condition.clause)
        params.push(...condition.params)
        paramIndex += condition.params.length
      }
    }

    return {
      clause: conditions.join(' AND '),
      params
    }
  }

  /**
   * Build single HAVING condition
   * Requirements: 5.2
   */
  private buildHavingCondition(filter: HavingFilter, paramIndex: number): { clause: string; params: any[] } | null {
    const { aggregateAlias, operator, value } = filter
    const aliasRef = this.escapeIdentifier(aggregateAlias)

    switch (operator) {
      case 'eq':
        return { clause: `${aliasRef} = $${paramIndex}`, params: [value] }
      case 'neq':
        return { clause: `${aliasRef} != $${paramIndex}`, params: [value] }
      case 'gt':
        return { clause: `${aliasRef} > $${paramIndex}`, params: [value] }
      case 'gte':
        return { clause: `${aliasRef} >= $${paramIndex}`, params: [value] }
      case 'lt':
        return { clause: `${aliasRef} < $${paramIndex}`, params: [value] }
      case 'lte':
        return { clause: `${aliasRef} <= $${paramIndex}`, params: [value] }
      default:
        console.warn(`Unsupported HAVING operator: ${operator}`)
        return null
    }
  }

  /**
   * Execute aggregate query
   * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
   */
  async executeAggregateQuery(
    context: ProjectIsolationContext,
    tableName: string,
    aggregateOps: AggregateOperation[],
    groupBy: string[],
    whereFilters: WhereFilter[],
    havingFilters: HavingFilter[],
    orderBy?: string,
    limit?: number,
    offset?: number
  ): Promise<AggregateQueryResult> {
    const startTime = Date.now()

    try {
      // Validate table name
      if (!this.isValidTableName(tableName)) {
        throw new Error(`Invalid table name: ${tableName}`)
      }

      // Validate that we have at least one aggregate operation
      if (aggregateOps.length === 0) {
        throw new Error('At least one aggregate function is required')
      }

      // Build the query
      const { query, params } = this.buildAggregateQuery(
        tableName,
        aggregateOps,
        groupBy,
        whereFilters,
        havingFilters,
        orderBy,
        limit,
        offset
      )

      // Execute the query
      const client = getProjectDatabaseClient()
      const result = await client.queryProjectDatabase(
        context.projectRef,
        context.userId,
        query,
        params,
        { skipPermissionCheck: true }
      )

      const executionTime = Date.now() - startTime

      // Build count query for pagination if needed
      let totalCount: number | undefined
      if (limit || offset) {
        const countQuery = this.buildCountQuery(tableName, groupBy, whereFilters, havingFilters)
        const countResult = await client.queryProjectDatabase(
          context.projectRef,
          context.userId,
          countQuery.query,
          countQuery.params,
          { skipPermissionCheck: true }
        )
        totalCount = parseInt(countResult.rows[0]?.count || '0', 10)
      }

      return {
        success: true,
        data: result.rows,
        rowCount: result.rowCount || 0,
        totalCount,
        executionTime,
        query: {
          sql: query,
          params,
          aggregateOps,
          groupBy,
          whereFilters,
          havingFilters
        }
      }
    } catch (error) {
      const executionTime = Date.now() - startTime
      console.error('Aggregate query execution failed:', error)

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTime,
        query: {
          aggregateOps,
          groupBy,
          whereFilters,
          havingFilters
        }
      }
    }
  }

  /**
   * Build count query for pagination
   * Requirements: 5.5
   */
  private buildCountQuery(
    tableName: string,
    groupBy: string[],
    whereFilters: WhereFilter[],
    havingFilters: HavingFilter[]
  ): { query: string; params: any[] } {
    const params: any[] = []
    let paramIndex = 1

    if (groupBy.length === 0) {
      // Simple count without grouping
      let query = `SELECT COUNT(*) as count FROM ${this.escapeIdentifier(tableName)}`
      
      if (whereFilters.length > 0) {
        const whereClause = this.buildWhereClause(whereFilters, paramIndex)
        query += ` WHERE ${whereClause.clause}`
        params.push(...whereClause.params)
      }

      return { query, params }
    } else {
      // Count with grouping - count the number of groups
      let subquery = `SELECT ${groupBy.map(col => this.escapeIdentifier(col)).join(', ')} FROM ${this.escapeIdentifier(tableName)}`
      
      if (whereFilters.length > 0) {
        const whereClause = this.buildWhereClause(whereFilters, paramIndex)
        subquery += ` WHERE ${whereClause.clause}`
        params.push(...whereClause.params)
        paramIndex += whereClause.params.length
      }

      subquery += ` GROUP BY ${groupBy.map(col => this.escapeIdentifier(col)).join(', ')}`

      if (havingFilters.length > 0) {
        // For count query, we need to include the aggregate functions in the subquery
        // to apply HAVING clause
        const aggregateExprs = havingFilters.map(filter => {
          // Try to infer the aggregate function from the alias
          const alias = filter.aggregateAlias
          if (alias.startsWith('count_')) {
            return `COUNT(*) AS ${this.escapeIdentifier(alias)}`
          } else if (alias.startsWith('sum_')) {
            const column = alias.substring(4)
            return `SUM(${this.escapeIdentifier(column)}) AS ${this.escapeIdentifier(alias)}`
          } else if (alias.startsWith('avg_')) {
            const column = alias.substring(4)
            return `AVG(${this.escapeIdentifier(column)}) AS ${this.escapeIdentifier(alias)}`
          } else if (alias.startsWith('min_')) {
            const column = alias.substring(4)
            return `MIN(${this.escapeIdentifier(column)}) AS ${this.escapeIdentifier(alias)}`
          } else if (alias.startsWith('max_')) {
            const column = alias.substring(4)
            return `MAX(${this.escapeIdentifier(column)}) AS ${this.escapeIdentifier(alias)}`
          }
          return `COUNT(*) AS ${this.escapeIdentifier(alias)}`
        })

        const selectClause = [...groupBy.map(col => this.escapeIdentifier(col)), ...aggregateExprs].join(', ')
        subquery = `SELECT ${selectClause} FROM ${this.escapeIdentifier(tableName)}`
        
        if (whereFilters.length > 0) {
          const whereClause = this.buildWhereClause(whereFilters, 1)
          subquery += ` WHERE ${whereClause.clause}`
          paramIndex = 1 + whereClause.params.length
        }

        subquery += ` GROUP BY ${groupBy.map(col => this.escapeIdentifier(col)).join(', ')}`

        const havingClause = this.buildHavingClause(havingFilters, paramIndex)
        subquery += ` HAVING ${havingClause.clause}`
        params.push(...havingClause.params)
      }

      const query = `SELECT COUNT(*) as count FROM (${subquery}) as grouped_results`
      return { query, params }
    }
  }

  /**
   * Parse having value based on operator
   */
  private parseHavingValue(operator: HavingOperator, value: any): any {
    switch (operator) {
      case 'eq':
      case 'neq':
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        // Try to parse as number for numeric comparisons
        if (typeof value === 'string') {
          const numValue = parseFloat(value)
          return isNaN(numValue) ? value : numValue
        }
        return value
      default:
        return value
    }
  }

  /**
   * Parse where value based on operator
   */
  private parseWhereValue(operator: WhereOperator, value: any): any {
    switch (operator) {
      case 'in':
        if (typeof value === 'string') {
          return value.split(',').map(v => v.trim())
        }
        return Array.isArray(value) ? value : [value]
      case 'is':
        if (value === 'null') return null
        if (value === 'true') return true
        if (value === 'false') return false
        return value
      default:
        return value
    }
  }

  /**
   * Validate aggregate function
   */
  private isValidAggregateFunction(func: string): func is AggregateFunction {
    return ['count', 'sum', 'avg', 'min', 'max'].includes(func)
  }

  /**
   * Validate having operator
   */
  private isValidHavingOperator(operator: string): operator is HavingOperator {
    return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(operator)
  }

  /**
   * Validate where operator
   */
  private isValidWhereOperator(operator: string): operator is WhereOperator {
    return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is'].includes(operator)
  }

  /**
   * Validate column name
   */
  private isValidColumnName(name: string): boolean {
    if (!name || typeof name !== 'string') return false
    // Allow alphanumeric, underscore, and dollar sign (common in PostgreSQL)
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
  }

  /**
   * Validate table name
   */
  private isValidTableName(name: string): boolean {
    if (!name || typeof name !== 'string') return false
    // Allow alphanumeric, underscore, and dollar sign (common in PostgreSQL)
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
  }

  /**
   * Escape SQL identifier
   */
  private escapeIdentifier(identifier: string): string {
    // Use double quotes to escape PostgreSQL identifiers
    return `"${identifier.replace(/"/g, '""')}"`
  }

  /**
   * Sanitize ORDER BY clause
   */
  private sanitizeOrderBy(orderBy: string): string | null {
    try {
      // Parse and validate ORDER BY clause
      const parts = orderBy.split(',').map(part => part.trim())
      const sanitizedParts: string[] = []

      for (const part of parts) {
        const match = part.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(ASC|DESC)?$/i)
        if (match) {
          const column = match[1]
          const direction = match[2] ? match[2].toUpperCase() : 'ASC'
          sanitizedParts.push(`${this.escapeIdentifier(column)} ${direction}`)
        }
      }

      return sanitizedParts.length > 0 ? sanitizedParts.join(', ') : null
    } catch (error) {
      console.error('Error sanitizing ORDER BY clause:', error)
      return null
    }
  }

  /**
   * Get supported aggregate functions
   */
  getSupportedFunctions(): AggregateFunctionInfo[] {
    return [
      {
        function: 'count',
        description: 'Count the number of rows',
        example: 'count(*), count(id)',
        returnType: 'integer'
      },
      {
        function: 'sum',
        description: 'Calculate the sum of numeric values',
        example: 'sum(price), sum(quantity)',
        returnType: 'numeric'
      },
      {
        function: 'avg',
        description: 'Calculate the average of numeric values',
        example: 'avg(rating), avg(score)',
        returnType: 'numeric'
      },
      {
        function: 'min',
        description: 'Find the minimum value',
        example: 'min(created_at), min(price)',
        returnType: 'same as column'
      },
      {
        function: 'max',
        description: 'Find the maximum value',
        example: 'max(updated_at), max(price)',
        returnType: 'same as column'
      }
    ]
  }
}

/**
 * Aggregate operation interface
 */
export interface AggregateOperation {
  function: AggregateFunction
  column: string
  alias: string
}

/**
 * Aggregate functions
 */
export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max'

/**
 * WHERE filter interface
 */
export interface WhereFilter {
  column: string
  operator: WhereOperator
  value: any
}

/**
 * WHERE operators
 */
export type WhereOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is'

/**
 * HAVING filter interface
 */
export interface HavingFilter {
  aggregateAlias: string
  operator: HavingOperator
  value: any
}

/**
 * HAVING operators
 */
export type HavingOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'

/**
 * Aggregate query result interface
 */
export interface AggregateQueryResult {
  success: boolean
  data?: any[]
  rowCount?: number
  totalCount?: number
  executionTime: number
  error?: string
  query: {
    sql?: string
    params?: any[]
    aggregateOps: AggregateOperation[]
    groupBy: string[]
    whereFilters: WhereFilter[]
    havingFilters: HavingFilter[]
  }
}

/**
 * Aggregate function information
 */
export interface AggregateFunctionInfo {
  function: AggregateFunction
  description: string
  example: string
  returnType: string
}

/**
 * Factory function to get the aggregate query service
 */
export function getAggregateQueryService(): AggregateQueryService {
  return AggregateQueryService.getInstance()
}