import { ProjectIsolationContext } from './secure-api-wrapper'
import { getProjectDatabaseClient } from './project-database-client'

/**
 * JSON Query Service
 * Handles advanced JSON operations for PostgREST
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 */
export class JSONQueryService {
  private static instance: JSONQueryService

  private constructor() {}

  static getInstance(): JSONQueryService {
    if (!JSONQueryService.instance) {
      JSONQueryService.instance = new JSONQueryService()
    }
    return JSONQueryService.instance
  }

  /**
   * Parse JSON operators from query parameters
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
   */
  parseJSONOperators(query: Record<string, any>): JSONFilter[] {
    const jsonFilters: JSONFilter[] = []

    for (const [key, value] of Object.entries(query)) {
      // Skip non-filter parameters (including Next.js route parameters)
      if (['select', 'order', 'limit', 'offset', 'count', 'schema', 'path', 'ref'].includes(key)) {
        continue
      }

      // Parse JSON operators - look for patterns like:
      // data.user.profile.-> or data.->
      const parts = key.split('.')
      if (parts.length >= 2) {
        // Find the JSON operator in the parts
        for (let i = 1; i < parts.length; i++) {
          const operator = parts[i]
          if (this.isJSONOperator(operator)) {
            const column = parts[0]
            const pathParts = parts.slice(1, i) // Parts between column and operator
            const jsonFilter = this.parseJSONFilter(column, operator, value, pathParts)
            if (jsonFilter) {
              jsonFilters.push(jsonFilter)
            }
            break // Found the operator, no need to continue
          }
        }
      }
    }

    return jsonFilters
  }

  /**
   * Check if an operator is a JSON operator
   * Requirements: 3.1, 3.2, 3.3, 3.4
   */
  private isJSONOperator(operator: string): boolean {
    const jsonOperators = [
      '->', '->>', '@>', '<@', '?', '?&', '?|',
      'json_extract', 'json_extract_text', 'json_contains',
      'json_contained', 'json_exists', 'json_exists_all', 'json_exists_any'
    ]
    return jsonOperators.includes(operator)
  }

  /**
   * Parse a single JSON filter
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
   */
  private parseJSONFilter(
    column: string,
    operator: string,
    value: any,
    pathParts: string[]
  ): JSONFilter | null {
    try {
      // Validate column name
      if (!this.isValidColumnName(column)) {
        throw new Error(`Invalid column name: ${column}`)
      }

      // Parse JSON path if provided
      let jsonPath: string | null = null
      if (pathParts.length > 0) {
        jsonPath = pathParts.join('.')
      }

      // Validate and parse the value
      const parsedValue = this.parseJSONValue(operator, value)

      return {
        column,
        operator: operator as JSONOperator,
        value: parsedValue,
        jsonPath,
        rawValue: value
      }
    } catch (error) {
      console.error(`Error parsing JSON filter for ${column}.${operator}:`, error)
      return null
    }
  }

  /**
   * Parse JSON value based on operator
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
   */
  private parseJSONValue(operator: string, value: any): any {
    switch (operator) {
      case '->':
      case '->>':
        // For extraction operators, value should be a key or index
        if (typeof value === 'string') {
          // Try to parse as number for array indexing
          const numValue = parseInt(value, 10)
          return isNaN(numValue) ? value : numValue
        }
        return value

      case '@>':
      case '<@':
        // For containment operators, value should be JSON
        if (typeof value === 'string') {
          try {
            return JSON.parse(value)
          } catch {
            // If not valid JSON, treat as string
            return value
          }
        }
        return value

      case '?':
      case '?&':
      case '?|':
        // For existence operators, value should be key(s)
        if (typeof value === 'string') {
          // Handle multiple keys for ?& and ?|
          if (operator === '?&' || operator === '?|') {
            return value.split(',').map(k => k.trim())
          }
          return value
        }
        return value

      default:
        return value
    }
  }

  /**
   * Build SQL WHERE clause for JSON filters
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
   */
  buildJSONWhereClause(filters: JSONFilter[]): { clause: string; params: any[] } {
    if (filters.length === 0) {
      return { clause: '', params: [] }
    }

    const conditions: string[] = []
    const params: any[] = []
    let paramIndex = 1

    for (const filter of filters) {
      try {
        const condition = this.buildSingleJSONCondition(filter, paramIndex)
        if (condition) {
          conditions.push(condition.clause)
          params.push(...condition.params)
          paramIndex += condition.params.length
        }
      } catch (error) {
        console.error(`Error building JSON condition for ${filter.column}.${filter.operator}:`, error)
        // Skip invalid filters rather than failing the entire query
        continue
      }
    }

    if (conditions.length === 0) {
      return { clause: '', params: [] }
    }

    return {
      clause: conditions.join(' AND '),
      params
    }
  }

  /**
   * Build SQL condition for a single JSON filter
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
   */
  private buildSingleJSONCondition(
    filter: JSONFilter,
    paramIndex: number
  ): { clause: string; params: any[] } | null {
    const { column, operator, value, jsonPath } = filter

    // Build the column reference with JSON path if provided
    let columnRef = this.escapeIdentifier(column)
    if (jsonPath) {
      // Handle nested JSON path
      const pathParts = jsonPath.split('.')
      for (const part of pathParts) {
        if (/^\d+$/.test(part)) {
          // Array index
          columnRef += ` -> ${part}`
        } else {
          // Object key
          columnRef += ` -> '${part.replace(/'/g, "''")}'`
        }
      }
    }

    switch (operator) {
      case '->':
        // JSON extraction (returns JSON)
        return {
          clause: `${columnRef} -> $${paramIndex} IS NOT NULL`,
          params: [value]
        }

      case '->>':
        // JSON extraction as text
        return {
          clause: `${columnRef} ->> $${paramIndex} IS NOT NULL`,
          params: [value]
        }

      case '@>':
        // JSON contains
        return {
          clause: `${columnRef} @> $${paramIndex}::jsonb`,
          params: [typeof value === 'string' ? value : JSON.stringify(value)]
        }

      case '<@':
        // JSON is contained by
        return {
          clause: `${columnRef} <@ $${paramIndex}::jsonb`,
          params: [typeof value === 'string' ? value : JSON.stringify(value)]
        }

      case '?':
        // JSON key exists
        return {
          clause: `${columnRef} ? $${paramIndex}`,
          params: [value]
        }

      case '?&':
        // JSON keys exist (all)
        if (Array.isArray(value)) {
          return {
            clause: `${columnRef} ?& $${paramIndex}`,
            params: [value]
          }
        }
        return {
          clause: `${columnRef} ? $${paramIndex}`,
          params: [value]
        }

      case '?|':
        // JSON keys exist (any)
        if (Array.isArray(value)) {
          return {
            clause: `${columnRef} ?| $${paramIndex}`,
            params: [value]
          }
        }
        return {
          clause: `${columnRef} ? $${paramIndex}`,
          params: [value]
        }

      default:
        console.warn(`Unsupported JSON operator: ${operator}`)
        return null
    }
  }

  /**
   * Execute JSON query
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
   */
  async executeJSONQuery(
    context: ProjectIsolationContext,
    tableName: string,
    jsonFilters: JSONFilter[],
    selectColumns?: string[],
    orderBy?: string,
    limit?: number,
    offset?: number
  ): Promise<JSONQueryResult> {
    const startTime = Date.now()

    try {
      // Validate table name
      if (!this.isValidTableName(tableName)) {
        throw new Error(`Invalid table name: ${tableName}`)
      }

      // Build the query
      const selectClause = selectColumns && selectColumns.length > 0 
        ? selectColumns.map(col => this.escapeIdentifier(col)).join(', ')
        : '*'

      let query = `SELECT ${selectClause} FROM ${this.escapeIdentifier(tableName)}`

      // Add JSON WHERE clause
      const whereClause = this.buildJSONWhereClause(jsonFilters)
      const params = whereClause.params

      if (whereClause.clause) {
        query += ` WHERE ${whereClause.clause}`
      }

      // Add ORDER BY clause
      if (orderBy) {
        const sanitizedOrderBy = this.sanitizeOrderBy(orderBy)
        if (sanitizedOrderBy) {
          query += ` ORDER BY ${sanitizedOrderBy}`
        }
      }

      // Add LIMIT and OFFSET
      if (limit && limit > 0) {
        query += ` LIMIT ${Math.min(limit, 1000)}` // Cap at 1000 for safety
      }

      if (offset && offset > 0) {
        query += ` OFFSET ${offset}`
      }

      // Execute the query
      const client = getProjectDatabaseClient()
      const result = await client.queryProjectDatabase(
        context.projectRef,
        context.userId,
        query,
        params,
        { skipPermissionCheck: false }
      )

      const executionTime = Date.now() - startTime

      return {
        success: true,
        data: result.rows,
        rowCount: result.rowCount || 0,
        executionTime,
        query: {
          sql: query,
          params,
          jsonFilters
        }
      }
    } catch (error) {
      const executionTime = Date.now() - startTime
      console.error('JSON query execution failed:', error)

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTime,
        query: {
          jsonFilters
        }
      }
    }
  }

  /**
   * Validate JSON path expression
   * Requirements: 3.5
   */
  validateJSONPath(path: string): { isValid: boolean; error?: string } {
    try {
      // Basic validation for JSON path
      if (!path || typeof path !== 'string') {
        return { isValid: false, error: 'JSON path must be a non-empty string' }
      }

      // Check for dangerous characters
      if (path.includes(';') || path.includes('--') || path.includes('/*')) {
        return { isValid: false, error: 'JSON path contains invalid characters' }
      }

      // Validate path structure
      const parts = path.split('.')
      for (const part of parts) {
        if (part.length === 0) {
          return { isValid: false, error: 'JSON path cannot have empty segments' }
        }

        // Check if it's a valid identifier or array index
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(part) && !/^\d+$/.test(part)) {
          return { isValid: false, error: `Invalid JSON path segment: ${part}` }
        }
      }

      return { isValid: true }
    } catch (error) {
      return { 
        isValid: false, 
        error: error instanceof Error ? error.message : 'JSON path validation failed' 
      }
    }
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
        const match = part.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)\s*(ASC|DESC)?$/i)
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
   * Get supported JSON operators
   */
  getSupportedOperators(): JSONOperatorInfo[] {
    return [
      {
        operator: '->',
        description: 'Extract JSON object field by key (returns JSON)',
        example: 'data.->key',
        returnType: 'json'
      },
      {
        operator: '->>',
        description: 'Extract JSON object field by key (returns text)',
        example: 'data.->>key',
        returnType: 'text'
      },
      {
        operator: '@>',
        description: 'Check if left JSON value contains right JSON value',
        example: 'data.@>{"key":"value"}',
        returnType: 'boolean'
      },
      {
        operator: '<@',
        description: 'Check if left JSON value is contained in right JSON value',
        example: 'data.<@{"key":"value","other":"data"}',
        returnType: 'boolean'
      },
      {
        operator: '?',
        description: 'Check if JSON object has a specific key',
        example: 'data.?key',
        returnType: 'boolean'
      },
      {
        operator: '?&',
        description: 'Check if JSON object has all specified keys',
        example: 'data.?&key1,key2',
        returnType: 'boolean'
      },
      {
        operator: '?|',
        description: 'Check if JSON object has any of the specified keys',
        example: 'data.?|key1,key2',
        returnType: 'boolean'
      }
    ]
  }
}

/**
 * JSON filter interface
 */
export interface JSONFilter {
  column: string
  operator: JSONOperator
  value: any
  jsonPath?: string | null
  rawValue?: any
}

/**
 * JSON operators
 */
export type JSONOperator = '->' | '->>' | '@>' | '<@' | '?' | '?&' | '?|'

/**
 * JSON query result interface
 */
export interface JSONQueryResult {
  success: boolean
  data?: any[]
  rowCount?: number
  executionTime: number
  error?: string
  query: {
    sql?: string
    params?: any[]
    jsonFilters: JSONFilter[]
  }
}

/**
 * JSON operator information
 */
export interface JSONOperatorInfo {
  operator: JSONOperator
  description: string
  example: string
  returnType: 'json' | 'text' | 'boolean'
}

/**
 * Factory function to get the JSON query service
 */
export function getJSONQueryService(): JSONQueryService {
  return JSONQueryService.getInstance()
}