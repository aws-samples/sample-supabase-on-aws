import { ProjectIsolationContext } from './secure-api-wrapper'
import { getProjectDatabaseClient } from './project-database-client'

/**
 * Array Operation Service
 * Handles PostgreSQL array operations for the enhanced PostgREST implementation
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
 */
export class ArrayOperationService {
  private static instance: ArrayOperationService

  private constructor() {}

  static getInstance(): ArrayOperationService {
    if (!ArrayOperationService.instance) {
      ArrayOperationService.instance = new ArrayOperationService()
    }
    return ArrayOperationService.instance
  }

  /**
   * Parse array operators from query parameters
   * Requirements: 11.1, 11.2, 11.3
   */
  parseArrayOperators(query: any): ArrayFilter[] {
    const arrayFilters: ArrayFilter[] = []

    for (const [key, value] of Object.entries(query)) {
      // Skip non-filter parameters (including Next.js route parameters)
      if (['select', 'order', 'limit', 'offset', 'count', 'schema', 'path', 'ref'].includes(key)) {
        continue
      }

      // Parse array operators
      const parts = key.split('.')
      if (parts.length >= 2) {
        const column = parts[0]
        const operator = parts[1] as ArrayOperator

        if (['cs', 'cd', 'ov'].includes(operator)) {
          let filterValue: any = value

          // Handle array values - convert string to array if needed
          if (typeof value === 'string') {
            try {
              // Try to parse as JSON array first
              filterValue = JSON.parse(value)
            } catch {
              // If not JSON, split by comma
              filterValue = value.split(',').map(v => v.trim())
            }
          }

          // Ensure we have an array
          if (!Array.isArray(filterValue)) {
            filterValue = [filterValue]
          }

          arrayFilters.push({
            column,
            operator,
            value: filterValue
          })
        }

        // Handle array indexing (e.g., column.0, column.1)
        if (/^\d+$/.test(operator)) {
          const index = parseInt(operator, 10)
          arrayFilters.push({
            column,
            operator: 'index',
            value: value,
            index
          })
        }

        // Handle array length filtering (e.g., column.length)
        if (operator === 'length') {
          arrayFilters.push({
            column,
            operator: 'length',
            value: value
          })
        }
      }
    }

    return arrayFilters
  }

  /**
   * Validate array filter
   * Requirements: 11.4, 11.5
   */
  validateArrayFilter(filter: ArrayFilter): ValidationResult {
    try {
      // Validate column name
      if (!filter.column || typeof filter.column !== 'string') {
        return {
          isValid: false,
          error: 'Invalid column name for array filter',
          code: 'PGRST103'
        }
      }

      // Validate operator
      if (!['cs', 'cd', 'ov', 'index', 'length'].includes(filter.operator)) {
        return {
          isValid: false,
          error: `Invalid array operator: ${filter.operator}`,
          code: 'PGRST103'
        }
      }

      // Validate value based on operator
      switch (filter.operator) {
        case 'cs':
        case 'cd':
        case 'ov':
          if (!Array.isArray(filter.value)) {
            return {
              isValid: false,
              error: `Array operator ${filter.operator} requires an array value`,
              code: 'PGRST103'
            }
          }
          break

        case 'index':
          if (typeof filter.index !== 'number' || filter.index < 0) {
            return {
              isValid: false,
              error: 'Array index must be a non-negative number',
              code: 'PGRST103'
            }
          }
          break

        case 'length':
          const lengthValue = parseInt(filter.value as string, 10)
          if (isNaN(lengthValue) || lengthValue < 0) {
            return {
              isValid: false,
              error: 'Array length filter must be a non-negative number',
              code: 'PGRST103'
            }
          }
          break
      }

      return { isValid: true }
    } catch (error) {
      return {
        isValid: false,
        error: error instanceof Error ? error.message : 'Unknown validation error',
        code: 'PGRST000'
      }
    }
  }

  /**
   * Build SQL WHERE clause for array operations
   * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
   */
  buildArrayWhereClause(filters: ArrayFilter[]): { clause: string; params: any[] } {
    const conditions: string[] = []
    const params: any[] = []
    let paramIndex = 1

    for (const filter of filters) {
      const columnRef = `"${filter.column}"`

      switch (filter.operator) {
        case 'cs': // contains
          conditions.push(`${columnRef} @> $${paramIndex}`)
          params.push(JSON.stringify(filter.value))
          paramIndex++
          break

        case 'cd': // contained by
          conditions.push(`${columnRef} <@ $${paramIndex}`)
          params.push(JSON.stringify(filter.value))
          paramIndex++
          break

        case 'ov': // overlap
          conditions.push(`${columnRef} && $${paramIndex}`)
          params.push(JSON.stringify(filter.value))
          paramIndex++
          break

        case 'index': // array indexing
          conditions.push(`${columnRef}[$${paramIndex}] = $${paramIndex + 1}`)
          params.push(filter.index! + 1) // PostgreSQL arrays are 1-indexed
          params.push(filter.value)
          paramIndex += 2
          break

        case 'length': // array length
          const lengthValue = parseInt(filter.value as string, 10)
          conditions.push(`array_length(${columnRef}, 1) = $${paramIndex}`)
          params.push(lengthValue)
          paramIndex++
          break
      }
    }

    return {
      clause: conditions.length > 0 ? conditions.join(' AND ') : '',
      params
    }
  }

  /**
   * Execute array operation query
   * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
   */
  async executeArrayQuery(
    context: ProjectIsolationContext,
    tableName: string,
    arrayFilters: ArrayFilter[],
    selectColumns?: string[],
    orderBy?: string,
    limit?: number,
    offset?: number,
    schema: string = 'public'
  ): Promise<ArrayQueryResult> {
    const startTime = Date.now()

    try {
      // Validate all array filters
      for (const filter of arrayFilters) {
        const validation = this.validateArrayFilter(filter)
        if (!validation.isValid) {
          return {
            success: false,
            error: validation.error,
            code: validation.code,
            executionTime: Date.now() - startTime
          }
        }
      }

      // Build SQL query
      const selectClause = selectColumns && selectColumns.length > 0 
        ? selectColumns.map(col => `"${col}"`).join(', ')
        : '*'

      const arrayWhereResult = this.buildArrayWhereClause(arrayFilters)
      
      let query = `SELECT ${selectClause} FROM "${schema}"."${tableName}"`
      const queryParams = [...arrayWhereResult.params]
      let paramIndex = arrayWhereResult.params.length + 1

      if (arrayWhereResult.clause) {
        query += ` WHERE ${arrayWhereResult.clause}`
      }

      // Add ORDER BY clause
      if (orderBy) {
        const orderClause = this.buildOrderClause(orderBy)
        if (orderClause) {
          query += ` ORDER BY ${orderClause}`
        }
      }

      // Add LIMIT and OFFSET
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
        executionTime: Date.now() - startTime,
        query: query,
        arrayFilters: arrayFilters.length
      }
    } catch (error) {
      console.error('Array query execution failed:', error)
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        code: 'PGRST000',
        executionTime: Date.now() - startTime
      }
    }
  }

  /**
   * Build ORDER BY clause from order parameter
   */
  private buildOrderClause(orderParam: string): string {
    if (!orderParam || typeof orderParam !== 'string') {
      return ''
    }

    const orderClauses = orderParam.split(',').map(clause => {
      const parts = clause.trim().split('.')
      const column = parts[0]
      const direction = parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
      return `"${column}" ${direction}`
    })

    return orderClauses.join(', ')
  }

  /**
   * Get array operation limits and constraints
   * Requirements: 11.5
   */
  getArrayOperationLimits(): ArrayOperationLimits {
    return {
      maxArraySize: 1000, // Maximum array size for operations
      maxIndexValue: 999, // Maximum array index value
      supportedTypes: [
        'integer[]',
        'text[]',
        'varchar[]',
        'boolean[]',
        'numeric[]',
        'timestamp[]',
        'date[]',
        'uuid[]',
        'json[]',
        'jsonb[]'
      ]
    }
  }

  /**
   * Validate array column type
   * Requirements: 11.4, 11.5
   */
  async validateArrayColumn(
    context: ProjectIsolationContext,
    tableName: string,
    columnName: string,
    schema: string = 'public'
  ): Promise<ArrayColumnValidation> {
    try {
      const projectDbClient = getProjectDatabaseClient()
      
      // Query column information
      const query = `
        SELECT 
          column_name,
          data_type,
          udt_name,
          is_nullable
        FROM information_schema.columns 
        WHERE table_schema = $1 
          AND table_name = $2 
          AND column_name = $3
      `
      
      const result = await projectDbClient.queryProjectDatabase(
        context.projectRef,
        context.userId,
        query,
        [schema, tableName, columnName],
        { skipPermissionCheck: false }
      )

      if (result.rows.length === 0) {
        return {
          isValid: false,
          error: `Column "${columnName}" does not exist in table "${tableName}"`,
          code: 'PGRST103'
        }
      }

      const column = result.rows[0]
      const isArrayType = column.data_type === 'ARRAY' || column.udt_name.endsWith('[]')

      if (!isArrayType) {
        return {
          isValid: false,
          error: `Column "${columnName}" is not an array type`,
          code: 'PGRST103'
        }
      }

      const limits = this.getArrayOperationLimits()
      const isSupported = limits.supportedTypes.some(type => 
        column.udt_name === type || column.udt_name.startsWith(type.replace('[]', ''))
      )

      return {
        isValid: true,
        columnInfo: {
          name: column.column_name,
          dataType: column.data_type,
          udtName: column.udt_name,
          isNullable: column.is_nullable === 'YES',
          isArrayType: true,
          isSupported
        }
      }
    } catch (error) {
      return {
        isValid: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        code: 'PGRST000'
      }
    }
  }
}

/**
 * Array filter interface
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
 */
export interface ArrayFilter {
  column: string
  operator: ArrayOperator
  value: any
  index?: number // For array indexing operations
}

/**
 * Array operators
 * Requirements: 11.1, 11.2, 11.3
 */
export type ArrayOperator = 'cs' | 'cd' | 'ov' | 'index' | 'length'

/**
 * Array query result interface
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
 */
export interface ArrayQueryResult {
  success: boolean
  data?: any[]
  rowCount?: number
  executionTime: number
  query?: string
  arrayFilters?: number
  error?: string
  code?: string
}

/**
 * Validation result interface
 */
export interface ValidationResult {
  isValid: boolean
  error?: string
  code?: string
}

/**
 * Array operation limits interface
 * Requirements: 11.5
 */
export interface ArrayOperationLimits {
  maxArraySize: number
  maxIndexValue: number
  supportedTypes: string[]
}

/**
 * Array column validation interface
 * Requirements: 11.4, 11.5
 */
export interface ArrayColumnValidation {
  isValid: boolean
  error?: string
  code?: string
  columnInfo?: {
    name: string
    dataType: string
    udtName: string
    isNullable: boolean
    isArrayType: boolean
    isSupported: boolean
  }
}

/**
 * Factory function to get the array operation service
 */
export function getArrayOperationService(): ArrayOperationService {
  return ArrayOperationService.getInstance()
}