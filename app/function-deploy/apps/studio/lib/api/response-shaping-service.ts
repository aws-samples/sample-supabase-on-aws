import { getProjectDatabaseClient } from './project-database-client'
import { ProjectIsolationContext } from './secure-api-wrapper'

/**
 * Response Shaping Service
 * Handles response formatting, column selection, and content negotiation
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */
export class ResponseShapingService {
  private static instance: ResponseShapingService
  private schemaCache = new Map<string, TableSchema>()
  private cacheExpiry = new Map<string, number>()
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  private constructor() {}

  static getInstance(): ResponseShapingService {
    if (!ResponseShapingService.instance) {
      ResponseShapingService.instance = new ResponseShapingService()
    }
    return ResponseShapingService.instance
  }

  /**
   * Parse select parameter and extract column selection criteria
   * Requirements: 6.1, 6.2
   */
  parseSelectParameter(selectParam: string): SelectCriteria {
    if (!selectParam || typeof selectParam !== 'string') {
      return { selectAll: true, columns: [], excludeColumns: [], computedColumns: [], nestedSelects: [] }
    }

    const criteria: SelectCriteria = {
      selectAll: false,
      columns: [],
      excludeColumns: [],
      computedColumns: [],
      nestedSelects: []
    }

    // Handle wildcard selection with exclusions (e.g., "*,!password,!secret")
    if (selectParam.includes('*')) {
      criteria.selectAll = true
      
      // Extract exclusions (columns prefixed with !)
      const parts = this.parseSelectParts(selectParam)
      for (const part of parts) {
        if (part.startsWith('!')) {
          criteria.excludeColumns.push(part.substring(1))
        }
      }
    } else {
      // Parse individual column selections
      const parts = this.parseSelectParts(selectParam)
      
      for (const part of parts) {
        if (part.includes('(') && part.includes(')')) {
          // Handle nested resource selection (e.g., "posts(title,content)")
          const nestedMatch = part.match(/^(\w+)\(([^)]+)\)$/)
          if (nestedMatch) {
            criteria.nestedSelects.push({
              relation: nestedMatch[1],
              columns: nestedMatch[2].split(',').map(col => col.trim())
            })
          } else {
            // If it doesn't match the nested pattern, treat as regular column
            criteria.columns.push(part)
          }
        } else if (part.includes(':')) {
          // Handle computed columns (e.g., "full_name:first_name||' '||last_name")
          const computedMatch = part.match(/^(\w+):(.+)$/)
          if (computedMatch) {
            criteria.computedColumns.push({
              alias: computedMatch[1],
              expression: computedMatch[2]
            })
          } else {
            criteria.columns.push(part)
          }
        } else {
          criteria.columns.push(part)
        }
      }
    }

    return criteria
  }

  /**
   * Parse select parameter parts, handling nested parentheses correctly
   */
  private parseSelectParts(selectParam: string): string[] {
    const parts: string[] = []
    let current = ''
    let depth = 0
    
    for (let i = 0; i < selectParam.length; i++) {
      const char = selectParam[i]
      
      if (char === '(') {
        depth++
        current += char
      } else if (char === ')') {
        depth--
        current += char
      } else if (char === ',' && depth === 0) {
        // Only split on commas that are not inside parentheses
        if (current.trim()) {
          parts.push(current.trim())
        }
        current = ''
      } else {
        current += char
      }
    }
    
    // Add the last part
    if (current.trim()) {
      parts.push(current.trim())
    }
    
    return parts
  }

  /**
   * Validate column selection against table schema
   * Requirements: 6.5
   */
  async validateColumnSelection(
    context: ProjectIsolationContext,
    tableName: string,
    criteria: SelectCriteria,
    schema: string = 'public'
  ): Promise<ValidationResult> {
    try {
      const tableSchema = await this.getTableSchema(context, tableName, schema)
      
      if (!tableSchema) {
        return {
          isValid: false,
          error: `Table "${tableName}" does not exist in schema "${schema}"`,
          code: 'PGRST116'
        }
      }

      const availableColumns = tableSchema.columns.map(col => col.name)
      const invalidColumns: string[] = []

      // Validate explicitly selected columns
      for (const column of criteria.columns) {
        if (!availableColumns.includes(column)) {
          invalidColumns.push(column)
        }
      }

      // Validate excluded columns
      for (const column of criteria.excludeColumns) {
        if (!availableColumns.includes(column)) {
          invalidColumns.push(column)
        }
      }

      // Validate computed column expressions (basic validation)
      for (const computed of criteria.computedColumns) {
        const referencedColumns = this.extractColumnReferences(computed.expression)
        for (const refCol of referencedColumns) {
          if (!availableColumns.includes(refCol)) {
            invalidColumns.push(refCol)
          }
        }
      }

      if (invalidColumns.length > 0) {
        return {
          isValid: false,
          error: `Invalid column references: ${invalidColumns.join(', ')}`,
          code: 'PGRST103',
          invalidColumns
        }
      }

      return {
        isValid: true,
        tableSchema
      }
    } catch (error) {
      return {
        isValid: false,
        error: error instanceof Error ? error.message : 'Unknown validation error',
        code: 'PGRST000'
      }
    }
  }

  /**
   * Build SQL SELECT clause based on column selection criteria
   * Requirements: 6.1, 6.2, 6.3
   */
  buildSelectClause(
    criteria: SelectCriteria,
    tableSchema: TableSchema,
    tableAlias?: string
  ): string {
    const prefix = tableAlias ? `${tableAlias}.` : ''
    const selectParts: string[] = []

    if (criteria.selectAll) {
      // Select all columns except excluded ones
      const columnsToSelect = tableSchema.columns
        .filter(col => !criteria.excludeColumns.includes(col.name))
        .map(col => `${prefix}"${col.name}"`)
      
      selectParts.push(...columnsToSelect)
    } else {
      // Select only specified columns
      for (const column of criteria.columns) {
        selectParts.push(`${prefix}"${column}"`)
      }
    }

    // Add computed columns
    for (const computed of criteria.computedColumns) {
      const expression = this.buildComputedColumnExpression(computed.expression, prefix)
      selectParts.push(`${expression} AS "${computed.alias}"`)
    }

    return selectParts.length > 0 ? selectParts.join(', ') : '*'
  }

  /**
   * Format response data according to specified format
   * Requirements: 6.1, 6.4
   */
  formatResponse(
    data: any[],
    format: ResponseFormat,
    options: FormatOptions = {}
  ): string | object {
    switch (format) {
      case 'json':
        return this.formatAsJSON(data, options)
      
      case 'csv':
        return this.formatAsCSV(data, options)
      
      case 'single-object':
        return this.formatAsSingleObject(data, options)
      
      case 'geojson':
        return this.formatAsGeoJSON(data, options)
      
      default:
        return data
    }
  }

  /**
   * Negotiate content type based on Accept header
   * Requirements: 6.4
   */
  negotiateContentType(acceptHeader?: string): ResponseFormat {
    if (!acceptHeader) {
      return 'json'
    }

    const accept = acceptHeader.toLowerCase()

    // Check for specific PostgREST content types
    if (accept.includes('application/vnd.pgrst.object+json')) {
      return 'single-object'
    }
    
    if (accept.includes('text/csv')) {
      return 'csv'
    }
    
    if (accept.includes('application/geo+json')) {
      return 'geojson'
    }
    
    if (accept.includes('application/json')) {
      return 'json'
    }

    // Default to JSON
    return 'json'
  }

  /**
   * Generate pagination headers for response
   * Requirements: 6.1
   */
  generatePaginationHeaders(
    data: any[],
    totalCount?: number,
    limit?: number,
    offset?: number
  ): Record<string, string> {
    const headers: Record<string, string> = {}

    if (data.length > 0) {
      const start = offset || 0
      const end = start + data.length - 1

      if (totalCount !== undefined) {
        headers['Content-Range'] = `${start}-${end}/${totalCount}`
      } else {
        headers['Content-Range'] = `${start}-${end}/*`
      }
    }

    return headers
  }

  /**
   * Apply response shaping to query result
   * Requirements: 6.1, 6.2, 6.3, 6.4
   */
  async applyResponseShaping(
    context: ProjectIsolationContext,
    tableName: string,
    data: any[],
    selectParam?: string,
    acceptHeader?: string,
    schema: string = 'public'
  ): Promise<ResponseShapingResult> {
    try {
      // Parse select criteria
      const criteria = this.parseSelectParameter(selectParam || '*')
      
      // Validate column selection
      const validation = await this.validateColumnSelection(context, tableName, criteria, schema)
      if (!validation.isValid) {
        return {
          success: false,
          error: validation.error,
          code: validation.code,
          invalidColumns: validation.invalidColumns
        }
      }

      // Negotiate content type
      const format = this.negotiateContentType(acceptHeader)
      
      // Apply column selection to data (if not already applied in SQL)
      const shapedData = this.applyColumnSelection(data, criteria, validation.tableSchema!)
      
      // Format response
      const formattedData = this.formatResponse(shapedData, format)
      
      return {
        success: true,
        data: formattedData,
        format,
        rowCount: shapedData.length,
        appliedCriteria: criteria
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        code: 'PGRST000'
      }
    }
  }

  /**
   * Get table schema from database
   * Requirements: 6.5
   */
  private async getTableSchema(
    context: ProjectIsolationContext,
    tableName: string,
    schema: string = 'public'
  ): Promise<TableSchema | null> {
    const cacheKey = `${context.projectRef}:${schema}:${tableName}`
    
    // Check cache first
    if (this.isCacheValid(cacheKey)) {
      const cached = this.schemaCache.get(cacheKey)
      if (cached) {
        return cached
      }
    }

    try {
      const projectDbClient = getProjectDatabaseClient()
      
      // Query to get table schema information
      const query = `
        SELECT 
          c.column_name,
          c.data_type,
          c.udt_name,
          c.is_nullable::boolean,
          c.column_default,
          c.ordinal_position,
          c.character_maximum_length,
          c.numeric_precision,
          c.numeric_scale,
          c.is_identity::boolean,
          c.is_generated::boolean,
          c.generation_expression,
          CASE 
            WHEN pk.column_name IS NOT NULL THEN true 
            ELSE false 
          END as is_primary_key,
          CASE 
            WHEN fk.column_name IS NOT NULL THEN true 
            ELSE false 
          END as is_foreign_key,
          fk.foreign_table_name,
          fk.foreign_column_name
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT ku.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2
        ) pk ON c.column_name = pk.column_name
        LEFT JOIN (
          SELECT 
            ku.column_name,
            ccu.table_name as foreign_table_name,
            ccu.column_name as foreign_column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
          JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2
        ) fk ON c.column_name = fk.column_name
        WHERE c.table_schema = $1
          AND c.table_name = $2
        ORDER BY c.ordinal_position
      `

      const result = await projectDbClient.queryProjectDatabase(
        context.projectRef,
        context.userId,
        query,
        [schema, tableName],
        { skipPermissionCheck: true }
      )

      if (result.rows.length === 0) {
        return null
      }

      const tableSchema: TableSchema = {
        name: tableName,
        schema,
        columns: result.rows.map(row => ({
          name: row.column_name,
          type: row.data_type,
          udtName: row.udt_name,
          isNullable: row.is_nullable,
          defaultValue: row.column_default,
          ordinalPosition: row.ordinal_position,
          characterMaximumLength: row.character_maximum_length,
          numericPrecision: row.numeric_precision,
          numericScale: row.numeric_scale,
          isIdentity: row.is_identity,
          isGenerated: row.is_generated,
          generationExpression: row.generation_expression,
          isPrimaryKey: row.is_primary_key,
          isForeignKey: row.is_foreign_key,
          foreignTableName: row.foreign_table_name,
          foreignColumnName: row.foreign_column_name
        }))
      }

      // Cache the schema
      this.schemaCache.set(cacheKey, tableSchema)
      this.cacheExpiry.set(cacheKey, Date.now() + this.CACHE_TTL)

      return tableSchema
    } catch (error) {
      console.error(`Failed to get schema for table ${tableName}:`, error)
      return null
    }
  }

  /**
   * Check if cache is valid for a given key
   */
  private isCacheValid(cacheKey: string): boolean {
    const expiry = this.cacheExpiry.get(cacheKey)
    return expiry !== undefined && Date.now() < expiry
  }

  /**
   * Extract column references from computed column expression
   */
  private extractColumnReferences(expression: string): string[] {
    // Simple regex to extract column names (alphanumeric + underscore)
    // This is a basic implementation - in production, you'd want more sophisticated parsing
    const columnRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g
    const matches = expression.match(columnRegex) || []
    
    // Filter out SQL keywords and functions
    const sqlKeywords = new Set([
      'select', 'from', 'where', 'and', 'or', 'not', 'null', 'true', 'false',
      'case', 'when', 'then', 'else', 'end', 'cast', 'as', 'distinct',
      'count', 'sum', 'avg', 'min', 'max', 'upper', 'lower', 'trim',
      'concat', 'substring', 'length', 'coalesce', 'nullif'
    ])
    
    return matches.filter(match => !sqlKeywords.has(match.toLowerCase()))
  }

  /**
   * Build computed column expression with proper table prefix
   */
  private buildComputedColumnExpression(expression: string, tablePrefix: string): string {
    if (!tablePrefix) {
      return expression
    }

    // Extract column references and add table prefix
    const columnRefs = this.extractColumnReferences(expression)
    let result = expression

    for (const colRef of columnRefs) {
      // Replace column references with prefixed versions
      const regex = new RegExp(`\\b${colRef}\\b`, 'g')
      result = result.replace(regex, `${tablePrefix}"${colRef}"`)
    }

    return result
  }

  /**
   * Apply column selection to data array
   */
  private applyColumnSelection(
    data: any[],
    criteria: SelectCriteria,
    tableSchema: TableSchema
  ): any[] {
    if (data.length === 0) {
      return data
    }

    return data.map(row => {
      const shapedRow: any = {}

      if (criteria.selectAll) {
        // Include all columns except excluded ones
        for (const column of tableSchema.columns) {
          if (!criteria.excludeColumns.includes(column.name) && row.hasOwnProperty(column.name)) {
            shapedRow[column.name] = row[column.name]
          }
        }
      } else {
        // Include only selected columns
        for (const column of criteria.columns) {
          if (row.hasOwnProperty(column)) {
            shapedRow[column] = row[column]
          }
        }
      }

      // Add computed columns (if they exist in the row)
      for (const computed of criteria.computedColumns) {
        if (row.hasOwnProperty(computed.alias)) {
          shapedRow[computed.alias] = row[computed.alias]
        }
      }

      return shapedRow
    })
  }

  /**
   * Format data as JSON
   */
  private formatAsJSON(data: any[], options: FormatOptions): any[] {
    return data
  }

  /**
   * Format data as CSV
   */
  private formatAsCSV(data: any[], options: FormatOptions): string {
    if (data.length === 0) {
      return ''
    }

    const delimiter = options.delimiter || ','
    const nullValue = options.nullValue || ''
    const includeHeaders = options.includeHeaders !== false

    // Get column names from first row
    const columns = Object.keys(data[0])
    const lines: string[] = []

    // Add headers if requested
    if (includeHeaders) {
      lines.push(columns.join(delimiter))
    }

    // Add data rows
    for (const row of data) {
      const values = columns.map(col => {
        const value = row[col]
        if (value === null || value === undefined) {
          return nullValue
        }
        
        // Escape values that contain delimiter, quotes, or newlines
        const stringValue = String(value)
        if (stringValue.includes(delimiter) || stringValue.includes('"') || stringValue.includes('\n')) {
          return `"${stringValue.replace(/"/g, '""')}"`
        }
        
        return stringValue
      })
      
      lines.push(values.join(delimiter))
    }

    return lines.join('\n')
  }

  /**
   * Format data as single object (first row only)
   */
  private formatAsSingleObject(data: any[], options: FormatOptions): any {
    return data.length > 0 ? data[0] : null
  }

  /**
   * Format data as GeoJSON
   */
  private formatAsGeoJSON(data: any[], options: FormatOptions): any {
    // Basic GeoJSON formatting - assumes geometry column exists
    const features = data.map(row => {
      const { geometry, ...properties } = row
      
      return {
        type: 'Feature',
        geometry: geometry || null,
        properties
      }
    })

    return {
      type: 'FeatureCollection',
      features
    }
  }

  /**
   * Clear schema cache for a project
   */
  clearCache(projectRef: string, schema?: string, tableName?: string): void {
    if (tableName && schema) {
      const cacheKey = `${projectRef}:${schema}:${tableName}`
      this.schemaCache.delete(cacheKey)
      this.cacheExpiry.delete(cacheKey)
    } else if (schema) {
      // Clear all cache entries for the schema
      for (const key of this.schemaCache.keys()) {
        if (key.startsWith(`${projectRef}:${schema}:`)) {
          this.schemaCache.delete(key)
          this.cacheExpiry.delete(key)
        }
      }
    } else {
      // Clear all cache entries for the project
      for (const key of this.schemaCache.keys()) {
        if (key.startsWith(`${projectRef}:`)) {
          this.schemaCache.delete(key)
          this.cacheExpiry.delete(key)
        }
      }
    }
  }
}

/**
 * Select criteria parsed from select parameter
 * Requirements: 6.1, 6.2
 */
export interface SelectCriteria {
  selectAll: boolean
  columns: string[]
  excludeColumns: string[]
  computedColumns: ComputedColumn[]
  nestedSelects: NestedSelect[]
}

/**
 * Computed column definition
 * Requirements: 6.3
 */
export interface ComputedColumn {
  alias: string
  expression: string
}

/**
 * Nested resource selection
 * Requirements: 6.4
 */
export interface NestedSelect {
  relation: string
  columns: string[]
}

/**
 * Response format types
 * Requirements: 6.4
 */
export type ResponseFormat = 'json' | 'csv' | 'single-object' | 'geojson'

/**
 * Format options for response formatting
 * Requirements: 6.4
 */
export interface FormatOptions {
  selectedColumns?: string[]
  includeHeaders?: boolean
  delimiter?: string
  nullValue?: string
}

/**
 * Table schema definition
 * Requirements: 6.5
 */
export interface TableSchema {
  name: string
  schema: string
  columns: ColumnDefinition[]
}

/**
 * Column definition
 * Requirements: 6.5
 */
export interface ColumnDefinition {
  name: string
  type: string
  udtName: string
  isNullable: boolean
  defaultValue?: any
  ordinalPosition: number
  characterMaximumLength?: number
  numericPrecision?: number
  numericScale?: number
  isIdentity: boolean
  isGenerated: boolean
  generationExpression?: string
  isPrimaryKey: boolean
  isForeignKey: boolean
  foreignTableName?: string
  foreignColumnName?: string
}

/**
 * Validation result for column selection
 * Requirements: 6.5
 */
export interface ValidationResult {
  isValid: boolean
  error?: string
  code?: string
  invalidColumns?: string[]
  tableSchema?: TableSchema
}

/**
 * Response shaping result
 * Requirements: 6.1, 6.4
 */
export interface ResponseShapingResult {
  success: boolean
  data?: any
  format?: ResponseFormat
  rowCount?: number
  appliedCriteria?: SelectCriteria
  error?: string
  code?: string
  invalidColumns?: string[]
}

/**
 * Factory function to get the response shaping service
 */
export function getResponseShapingService(): ResponseShapingService {
  return ResponseShapingService.getInstance()
}