import { NextApiRequest } from 'next'
import { ProjectIsolationContext } from './secure-api-wrapper'
import { getProjectDatabaseClient } from './project-database-client'

/**
 * Advanced Filtering Service
 * Implements advanced filtering operators for PostgREST compatibility
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */
export class AdvancedFilteringService {
  private static instance: AdvancedFilteringService

  private constructor() {}

  static getInstance(): AdvancedFilteringService {
    if (!AdvancedFilteringService.instance) {
      AdvancedFilteringService.instance = new AdvancedFilteringService()
    }
    return AdvancedFilteringService.instance
  }

  /**
   * Parse advanced filter operators from query parameters
   * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
   */
  parseAdvancedFilters(query: any): AdvancedFilter[] {
    const filters: AdvancedFilter[] = []
    
    // Basic PostgREST operators that should NOT be treated as advanced filtering
    const basicOperators = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike']

    for (const [key, value] of Object.entries(query)) {
      // Skip non-filter parameters (including Next.js route parameters)
      if (['select', 'order', 'limit', 'offset', 'count', 'schema', 'path', 'ref'].includes(key)) {
        continue
      }

      // Parse filter operators
      const parts = key.split('.')
      if (parts.length >= 2) {
        const column = parts[0]
        const operator = parts[1] as AdvancedFilterOperator
        
        // Skip basic PostgREST operators
        if (basicOperators.includes(operator)) {
          continue
        }
        
        // Check if this is an advanced filter operator
        if (this.isAdvancedFilterOperator(operator)) {
          let filterValue: any = value
          let negate = false

          // Handle negation
          if (parts.length >= 3 && parts[2] === 'not') {
            negate = true
          } else if (operator === 'not') {
            // Handle 'not' as a prefix operator
            if (parts.length >= 3) {
              const actualOperator = parts[2] as AdvancedFilterOperator
              if (this.isAdvancedFilterOperator(actualOperator)) {
                filters.push({
                  column,
                  operator: actualOperator,
                  value: filterValue,
                  negate: true,
                  logicalOperator: 'and'
                })
                continue
              }
            }
          }

          // Handle array values for 'in' operator
          if (operator === 'in' && typeof value === 'string') {
            filterValue = value.split(',').map(v => v.trim())
          }
          
          // Handle boolean and null values for 'is' operator
          if (operator === 'is') {
            if (value === 'null') filterValue = null
            else if (value === 'true') filterValue = true
            else if (value === 'false') filterValue = false
            else if (value === 'not.null') {
              filterValue = null
              negate = true
            }
          }

          // Handle range operators with proper type conversion
          if (['gte', 'lte', 'gt', 'lt'].includes(operator)) {
            filterValue = this.convertValueForRangeOperator(value)
          }

          filters.push({
            column,
            operator,
            value: filterValue,
            negate,
            logicalOperator: 'and' // Default to AND, can be overridden by logical operator parsing
          })
        }
      } else {
        // Handle simple equality filters or value-based operators (?column=operator.value)
        if (typeof value === 'string' && value.includes('.')) {
          const valueParts = value.split('.')
          const operator = valueParts[0] as AdvancedFilterOperator
          
          // Skip basic PostgREST operators
          if (basicOperators.includes(operator)) {
            continue
          }
          
          if (this.isAdvancedFilterOperator(operator)) {
            const actualValue = valueParts.slice(1).join('.')
            let filterValue: any = actualValue
            
            // Handle array values for 'in' operator
            if (operator === 'in') {
              filterValue = actualValue.split(',').map(v => v.trim())
            }
            
            // Handle boolean and null values for 'is' operator
            if (operator === 'is') {
              if (actualValue === 'null') filterValue = null
              else if (actualValue === 'true') filterValue = true
              else if (actualValue === 'false') filterValue = false
            }
            
            // Handle boolean values for 'eq' operator
            if (operator === 'eq') {
              if (actualValue === 'true') filterValue = true
              else if (actualValue === 'false') filterValue = false
            }
            
            // Handle range operators with proper type conversion
            if (['gte', 'lte', 'gt', 'lt'].includes(operator)) {
              filterValue = this.convertValueForRangeOperator(actualValue)
            }
            
            filters.push({
              column: key,
              operator,
              value: filterValue,
              negate: false,
              logicalOperator: 'and'
            })
            continue
          }
        }
        
        // Skip simple equality filters - let base engine handle them
        continue
      }
    }

    return filters
  }

  /**
   * Check if operator is an advanced filter operator
   * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
   */
  private isAdvancedFilterOperator(operator: string): boolean {
    // Only treat truly advanced operators as advanced filtering
    // Basic PostgREST operators (eq, neq, gt, gte, lt, lte, like, ilike) should be handled by base engine
    const advancedOperators = [
      'in', 'is', 'not'
    ]
    return advancedOperators.includes(operator)
  }

  /**
   * Convert value for range operators with proper type handling
   * Requirements: 7.4
   */
  private convertValueForRangeOperator(value: any): any {
    if (typeof value !== 'string') {
      return value
    }

    // Try to parse as number
    const numValue = Number(value)
    if (!isNaN(numValue)) {
      return numValue
    }

    // Try to parse as date
    const dateValue = new Date(value)
    if (!isNaN(dateValue.getTime())) {
      return dateValue.toISOString()
    }

    // Return as string if no conversion possible
    return value
  }

  /**
   * Parse logical operator combinations (and/or)
   * Requirements: 7.5
   */
  parseLogicalOperators(query: any): LogicalOperatorGroup[] {
    const groups: LogicalOperatorGroup[] = []
    
    // Look for 'and' and 'or' parameters
    const andParam = query.and
    const orParam = query.or

    if (andParam) {
      const andFilters = this.parseLogicalGroup(andParam, 'and')
      if (andFilters.length > 0) {
        groups.push({
          operator: 'and',
          filters: andFilters
        })
      }
    }

    if (orParam) {
      const orFilters = this.parseLogicalGroup(orParam, 'or')
      if (orFilters.length > 0) {
        groups.push({
          operator: 'or',
          filters: orFilters
        })
      }
    }

    return groups
  }

  /**
   * Parse a logical group of filters
   * Requirements: 7.5
   */
  private parseLogicalGroup(param: any, operator: 'and' | 'or'): AdvancedFilter[] {
    const filters: AdvancedFilter[] = []

    if (typeof param === 'string') {
      // Parse comma-separated filters: "name.eq.John,age.gt.18"
      const filterStrings = param.split(',')
      for (const filterStr of filterStrings) {
        const parts = filterStr.trim().split('.')
        if (parts.length >= 3) {
          const column = parts[0]
          const op = parts[1] as AdvancedFilterOperator
          const value = parts.slice(2).join('.') // Handle values with dots

          if (this.isAdvancedFilterOperator(op)) {
            filters.push({
              column,
              operator: op,
              value: this.convertFilterValue(op, value),
              negate: false,
              logicalOperator: operator
            })
          }
        }
      }
    } else if (Array.isArray(param)) {
      // Parse array of filter objects
      for (const filterObj of param) {
        if (typeof filterObj === 'object') {
          for (const [key, value] of Object.entries(filterObj)) {
            const parts = key.split('.')
            if (parts.length >= 2) {
              const column = parts[0]
              const op = parts[1] as AdvancedFilterOperator
              
              if (this.isAdvancedFilterOperator(op)) {
                filters.push({
                  column,
                  operator: op,
                  value: this.convertFilterValue(op, value),
                  negate: false,
                  logicalOperator: operator
                })
              }
            }
          }
        }
      }
    }

    return filters
  }

  /**
   * Convert filter value based on operator type
   * Requirements: 7.1, 7.2, 7.3, 7.4
   */
  private convertFilterValue(operator: AdvancedFilterOperator, value: any): any {
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
      
      case 'gte':
      case 'lte':
      case 'gt':
      case 'lt':
        return this.convertValueForRangeOperator(value)
      
      default:
        return value
    }
  }

  /**
   * Validate advanced filters
   * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
   */
  validateAdvancedFilters(filters: AdvancedFilter[]): FilterValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    for (const filter of filters) {
      // Validate column name
      if (!this.isValidColumnName(filter.column)) {
        errors.push(`Invalid column name: ${filter.column}`)
        continue
      }

      // Validate operator-specific constraints
      switch (filter.operator) {
        case 'in':
          if (!Array.isArray(filter.value) || filter.value.length === 0) {
            errors.push(`'in' operator requires a non-empty array of values for column: ${filter.column}`)
          }
          break
        
        case 'is':
          if (filter.value !== null && typeof filter.value !== 'boolean') {
            errors.push(`'is' operator only supports null, true, or false values for column: ${filter.column}`)
          }
          break
        
        case 'gte':
        case 'lte':
        case 'gt':
        case 'lt':
          if (filter.value === null || filter.value === undefined) {
            errors.push(`Range operator '${filter.operator}' requires a non-null value for column: ${filter.column}`)
          }
          break
        
        case 'like':
        case 'ilike':
          if (typeof filter.value !== 'string') {
            warnings.push(`'${filter.operator}' operator works best with string values for column: ${filter.column}`)
          }
          break
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    }
  }

  /**
   * Build SQL WHERE clause from advanced filters
   * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
   */
  buildAdvancedWhereClause(filters: AdvancedFilter[], logicalGroups: LogicalOperatorGroup[] = []): SQLClauseResult {
    const conditions: string[] = []
    const params: any[] = []
    let paramIndex = 1

    // Process individual filters
    for (const filter of filters) {
      const condition = this.buildFilterCondition(filter, paramIndex)
      if (condition.clause) {
        conditions.push(condition.clause)
        params.push(...condition.params)
        paramIndex += condition.params.length
      }
    }

    // Process logical groups
    for (const group of logicalGroups) {
      const groupConditions: string[] = []
      
      for (const filter of group.filters) {
        const condition = this.buildFilterCondition(filter, paramIndex)
        if (condition.clause) {
          groupConditions.push(condition.clause)
          params.push(...condition.params)
          paramIndex += condition.params.length
        }
      }

      if (groupConditions.length > 0) {
        const groupClause = `(${groupConditions.join(` ${group.operator.toUpperCase()} `)})`
        conditions.push(groupClause)
      }
    }

    return {
      clause: conditions.length > 0 ? conditions.join(' AND ') : '',
      params
    }
  }

  /**
   * Build SQL condition for a single filter
   * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
   */
  private buildFilterCondition(filter: AdvancedFilter, startParamIndex: number): SQLClauseResult {
    const column = `"${filter.column}"`
    let clause = ''
    const params: any[] = []
    let paramIndex = startParamIndex

    switch (filter.operator) {
      case 'eq':
        clause = `${column} = $${paramIndex}`
        params.push(filter.value)
        break
      
      case 'neq':
        clause = `${column} != $${paramIndex}`
        params.push(filter.value)
        break
      
      case 'gt':
        clause = `${column} > $${paramIndex}`
        params.push(filter.value)
        break
      
      case 'gte':
        clause = `${column} >= $${paramIndex}`
        params.push(filter.value)
        break
      
      case 'lt':
        clause = `${column} < $${paramIndex}`
        params.push(filter.value)
        break
      
      case 'lte':
        clause = `${column} <= $${paramIndex}`
        params.push(filter.value)
        break
      
      case 'like':
        clause = `${column} LIKE $${paramIndex}`
        params.push(filter.value)
        break
      
      case 'ilike':
        clause = `${column} ILIKE $${paramIndex}`
        params.push(filter.value)
        break
      
      case 'in':
        if (Array.isArray(filter.value) && filter.value.length > 0) {
          const placeholders = filter.value.map(() => `$${paramIndex++}`).join(',')
          clause = `${column} IN (${placeholders})`
          params.push(...filter.value)
          paramIndex-- // Adjust because we incremented in the loop
        }
        break
      
      case 'is':
        if (filter.value === null) {
          clause = `${column} IS NULL`
        } else if (filter.value === true) {
          clause = `${column} IS TRUE`
        } else if (filter.value === false) {
          clause = `${column} IS FALSE`
        }
        break
      
      default:
        // Fallback for unknown operators
        clause = `${column} = $${paramIndex}`
        params.push(filter.value)
        break
    }

    // Apply negation if specified
    if (filter.negate && clause) {
      clause = `NOT (${clause})`
    }

    return { clause, params }
  }

  /**
   * Execute advanced filtering query
   * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
   */
  async executeAdvancedFilterQuery(
    context: ProjectIsolationContext,
    tableName: string,
    filters: AdvancedFilter[],
    logicalGroups: LogicalOperatorGroup[],
    selectColumns?: string[],
    orderBy?: string,
    limit?: number,
    offset?: number,
    schema: string = 'public'
  ): Promise<AdvancedFilterQueryResult> {
    try {
      // Validate filters
      const validation = this.validateAdvancedFilters(filters)
      if (!validation.isValid) {
        return {
          success: false,
          error: `Filter validation failed: ${validation.errors.join(', ')}`,
          data: [],
          rowCount: 0
        }
      }

      // Build SELECT clause
      const selectClause = selectColumns && selectColumns.length > 0 
        ? selectColumns.map(col => `"${col}"`).join(', ')
        : '*'

      // Build WHERE clause
      const whereResult = this.buildAdvancedWhereClause(filters, logicalGroups)

      // Build complete query
      let query = `SELECT ${selectClause} FROM "${schema}"."${tableName}"`
      const queryParams = [...whereResult.params]
      let paramIndex = whereResult.params.length + 1

      if (whereResult.clause) {
        query += ` WHERE ${whereResult.clause}`
      }

      if (orderBy) {
        query += ` ORDER BY ${this.buildOrderClause(orderBy)}`
      }

      if (limit) {
        query += ` LIMIT $${paramIndex}`
        queryParams.push(limit)
        paramIndex++
      }

      if (offset) {
        query += ` OFFSET $${paramIndex}`
        queryParams.push(offset)
      }

      // Execute query
      const projectDbClient = getProjectDatabaseClient()
      const result = await projectDbClient.queryProjectDatabase(
        context.projectRef,
        context.userId,
        query,
        queryParams,
        { skipPermissionCheck: false }
      )

      return {
        success: true,
        data: result.rows,
        rowCount: result.rows.length,
        executionTime: result.executionTime,
        warnings: validation.warnings
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        data: [],
        rowCount: 0
      }
    }
  }

  /**
   * Build ORDER BY clause from order parameter
   */
  private buildOrderClause(orderParam: string): string {
    const orderClauses = orderParam.split(',').map(clause => {
      const parts = clause.trim().split('.')
      const column = parts[0]
      const direction = parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
      return `"${column}" ${direction}`
    })

    return orderClauses.join(', ')
  }

  /**
   * Validate column name (helper method)
   */
  private isValidColumnName(name: string): boolean {
    if (!name || typeof name !== 'string') return false
    // Allow alphanumeric, underscore, and dollar sign (common in PostgreSQL)
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
  }
}

/**
 * Advanced filter operator types
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */
export type AdvancedFilterOperator = 
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'ilike' | 'in' | 'is' | 'not'

/**
 * Advanced filter interface
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */
export interface AdvancedFilter {
  column: string
  operator: AdvancedFilterOperator
  value: any
  negate: boolean
  logicalOperator: 'and' | 'or'
}

/**
 * Logical operator group interface
 * Requirements: 7.5
 */
export interface LogicalOperatorGroup {
  operator: 'and' | 'or'
  filters: AdvancedFilter[]
}

/**
 * Filter validation result interface
 */
export interface FilterValidationResult {
  isValid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * SQL clause result interface
 */
export interface SQLClauseResult {
  clause: string
  params: any[]
}

/**
 * Advanced filter query result interface
 */
export interface AdvancedFilterQueryResult {
  success: boolean
  data: any[]
  rowCount: number
  executionTime?: number
  error?: string
  warnings?: string[]
}

/**
 * Factory function to get the advanced filtering service
 */
export function getAdvancedFilteringService(): AdvancedFilteringService {
  return AdvancedFilteringService.getInstance()
}