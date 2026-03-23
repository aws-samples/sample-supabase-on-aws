import { getProjectDatabaseClient } from './project-database-client'
import { ProjectIsolationContext } from './secure-api-wrapper'

/**
 * Database View Service
 * Handles PostgreSQL view discovery, introspection, and query handling
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */
export class DatabaseViewService {
  private static instance: DatabaseViewService
  private viewCache = new Map<string, DatabaseView[]>()
  private cacheExpiry = new Map<string, number>()
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  private constructor() {}

  static getInstance(): DatabaseViewService {
    if (!DatabaseViewService.instance) {
      DatabaseViewService.instance = new DatabaseViewService()
    }
    return DatabaseViewService.instance
  }

  /**
   * Discover database views in the specified schema
   * Requirements: 2.1
   */
  async discoverViews(
    context: ProjectIsolationContext,
    schema: string = 'public'
  ): Promise<DatabaseView[]> {
    const cacheKey = `${context.projectRef}:${schema}`
    
    // Check cache first
    if (this.isCacheValid(cacheKey)) {
      const cached = this.viewCache.get(cacheKey)
      if (cached) {
        return cached
      }
    }

    try {
      const projectDbClient = getProjectDatabaseClient()
      
      // Query to discover views with their columns and metadata
      const query = `
        SELECT 
          v.table_name as view_name,
          v.table_schema as schema_name,
          v.view_definition,
          v.is_updatable,
          v.is_insertable_into,
          v.is_trigger_updatable,
          v.is_trigger_deletable,
          v.is_trigger_insertable_into,
          obj_description(c.oid, 'pg_class') as description,
          COALESCE(
            json_agg(
              json_build_object(
                'column_name', col.column_name,
                'data_type', col.data_type,
                'is_nullable', col.is_nullable,
                'column_default', col.column_default,
                'ordinal_position', col.ordinal_position,
                'character_maximum_length', col.character_maximum_length,
                'numeric_precision', col.numeric_precision,
                'numeric_scale', col.numeric_scale,
                'udt_name', col.udt_name,
                'is_identity', col.is_identity,
                'is_generated', col.is_generated,
                'generation_expression', col.generation_expression
              )
              ORDER BY col.ordinal_position
            ) FILTER (WHERE col.column_name IS NOT NULL),
            '[]'::json
          ) as columns
        FROM information_schema.views v
        LEFT JOIN pg_class c ON (
          c.relname = v.table_name 
          AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = v.table_schema)
        )
        LEFT JOIN information_schema.columns col ON (
          col.table_name = v.table_name 
          AND col.table_schema = v.table_schema
        )
        WHERE v.table_schema = $1
          AND has_table_privilege(v.table_schema || '.' || v.table_name, 'SELECT')
        GROUP BY 
          v.table_name, v.table_schema, v.view_definition, v.is_updatable,
          v.is_insertable_into, v.is_trigger_updatable, v.is_trigger_deletable,
          v.is_trigger_insertable_into, c.oid
        ORDER BY v.table_name
      `

      const result = await projectDbClient.queryProjectDatabase(
        context.projectRef,
        context.userId,
        query,
        [schema],
        { skipPermissionCheck: true }
      )

      const views: DatabaseView[] = result.rows.map(row => {
        const columns: ViewColumn[] = Array.isArray(row.columns) 
          ? row.columns.map((col: any) => ({
              name: col.column_name,
              type: col.data_type,
              udtName: col.udt_name,
              isNullable: col.is_nullable === 'YES',
              defaultValue: col.column_default,
              ordinalPosition: col.ordinal_position,
              characterMaximumLength: col.character_maximum_length,
              numericPrecision: col.numeric_precision,
              numericScale: col.numeric_scale,
              isIdentity: col.is_identity === 'YES',
              isGenerated: col.is_generated === 'ALWAYS',
              generationExpression: col.generation_expression
            }))
          : []

        return {
          name: row.view_name,
          schema: row.schema_name,
          definition: row.view_definition,
          isUpdatable: row.is_updatable === 'YES',
          isInsertable: row.is_insertable_into === 'YES',
          isTriggerUpdatable: row.is_trigger_updatable === 'YES',
          isTriggerDeletable: row.is_trigger_deletable === 'YES',
          isTriggerInsertable: row.is_trigger_insertable_into === 'YES',
          description: row.description || undefined,
          columns,
          permissions: {
            select: true, // Already filtered by has_table_privilege
            insert: row.is_insertable_into === 'YES' || row.is_trigger_insertable_into === 'YES',
            update: row.is_updatable === 'YES' || row.is_trigger_updatable === 'YES',
            delete: row.is_trigger_deletable === 'YES'
          }
        }
      })

      // Cache the results
      this.viewCache.set(cacheKey, views)
      this.cacheExpiry.set(cacheKey, Date.now() + this.CACHE_TTL)

      return views
    } catch (error) {
      console.error(`Failed to discover views in schema ${schema}:`, error)
      throw new Error(`View discovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Get a specific view by name
   * Requirements: 2.1
   */
  async getView(
    context: ProjectIsolationContext,
    viewName: string,
    schema: string = 'public'
  ): Promise<DatabaseView | null> {
    try {
      const views = await this.discoverViews(context, schema)
      return views.find(v => v.name === viewName) || null
    } catch (error) {
      console.error(`Failed to get view ${viewName}:`, error)
      return null
    }
  }

  /**
   * Check if a resource is a view
   * Requirements: 2.1
   */
  async isView(
    context: ProjectIsolationContext,
    resourceName: string,
    schema: string = 'public'
  ): Promise<boolean> {
    try {
      const view = await this.getView(context, resourceName, schema)
      return view !== null
    } catch (error) {
      console.error(`Failed to check if ${resourceName} is a view:`, error)
      return false
    }
  }

  /**
   * Validate view access permissions
   * Requirements: 2.3
   */
  async validateViewAccess(
    context: ProjectIsolationContext,
    viewName: string,
    operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE',
    schema: string = 'public'
  ): Promise<ViewAccessValidation> {
    try {
      const view = await this.getView(context, viewName, schema)
      
      if (!view) {
        return {
          isValid: false,
          error: `View "${viewName}" does not exist in schema "${schema}"`,
          code: 'PGRST116'
        }
      }

      // Check operation-specific permissions
      switch (operation) {
        case 'SELECT':
          if (!view.permissions.select) {
            return {
              isValid: false,
              error: `Permission denied for view "${viewName}": SELECT not allowed`,
              code: 'PGRST301'
            }
          }
          break
        
        case 'INSERT':
          if (!view.permissions.insert) {
            return {
              isValid: false,
              error: `Permission denied for view "${viewName}": INSERT not allowed`,
              code: 'PGRST301'
            }
          }
          break
        
        case 'UPDATE':
          if (!view.permissions.update) {
            return {
              isValid: false,
              error: `Permission denied for view "${viewName}": UPDATE not allowed`,
              code: 'PGRST301'
            }
          }
          break
        
        case 'DELETE':
          if (!view.permissions.delete) {
            return {
              isValid: false,
              error: `Permission denied for view "${viewName}": DELETE not allowed`,
              code: 'PGRST301'
            }
          }
          break
      }

      return {
        isValid: true,
        view
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
   * Get computed columns for a view
   * Requirements: 2.4
   */
  async getComputedColumns(
    context: ProjectIsolationContext,
    viewName: string,
    schema: string = 'public'
  ): Promise<ViewColumn[]> {
    try {
      const view = await this.getView(context, viewName, schema)
      
      if (!view) {
        return []
      }

      // Return columns that are computed (generated or derived from expressions)
      return view.columns.filter(col => 
        col.isGenerated || 
        col.generationExpression ||
        this.isComputedColumn(col, view.definition)
      )
    } catch (error) {
      console.error(`Failed to get computed columns for view ${viewName}:`, error)
      return []
    }
  }

  /**
   * Handle view query with filtering and pagination
   * Requirements: 2.2, 2.5
   */
  async handleViewQuery(
    context: ProjectIsolationContext,
    viewName: string,
    queryParams: ViewQueryParams,
    schema: string = 'public'
  ): Promise<ViewQueryResult> {
    try {
      // Validate view access
      const validation = await this.validateViewAccess(context, viewName, 'SELECT', schema)
      if (!validation.isValid) {
        throw new Error(validation.error)
      }

      const view = validation.view!
      const projectDbClient = getProjectDatabaseClient()

      // Build the query
      const queryBuilder = new ViewQueryBuilder(view, queryParams)
      const { query, params } = queryBuilder.build()

      // Execute the query
      const startTime = Date.now()
      const result = await projectDbClient.queryProjectDatabase(
        context.projectRef,
        context.userId,
        query,
        params,
        { skipPermissionCheck: true }
      )
      const executionTime = Date.now() - startTime

      // Get total count if requested
      let totalCount: number | undefined
      if (queryParams.count) {
        const countQuery = queryBuilder.buildCountQuery()
        const countResult = await projectDbClient.queryProjectDatabase(
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
        view,
        executionTime,
        rowCount: result.rows.length,
        totalCount
      }
    } catch (error) {
      console.error(`View query failed for ${viewName}:`, error)
      
      return {
        success: false,
        data: [],
        view: null,
        executionTime: 0,
        rowCount: 0,
        error: error instanceof Error ? error.message : 'Unknown query error'
      }
    }
  }

  /**
   * Clear view cache for a project
   * Requirements: 2.1
   */
  clearCache(projectRef: string, schema?: string): void {
    if (schema) {
      const cacheKey = `${projectRef}:${schema}`
      this.viewCache.delete(cacheKey)
      this.cacheExpiry.delete(cacheKey)
    } else {
      // Clear all cache entries for the project
      for (const key of this.viewCache.keys()) {
        if (key.startsWith(`${projectRef}:`)) {
          this.viewCache.delete(key)
          this.cacheExpiry.delete(key)
        }
      }
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
   * Check if a column is computed based on view definition
   */
  private isComputedColumn(column: ViewColumn, viewDefinition: string): boolean {
    // This is a simplified check - in a real implementation, you would
    // parse the view definition to identify computed expressions
    const definition = viewDefinition.toLowerCase()
    const columnName = column.name.toLowerCase()
    
    // Look for common computed column patterns
    return definition.includes(`${columnName} as `) ||
           definition.includes(`as ${columnName}`) ||
           definition.includes(`${columnName} =`) ||
           definition.includes(`case when`) ||
           definition.includes(`coalesce(`) ||
           definition.includes(`concat(`) ||
           definition.includes(`extract(`) ||
           definition.includes(`date_part(`)
  }
}

/**
 * View Query Builder
 * Builds SQL queries for view operations with filtering and pagination
 * Requirements: 2.2, 2.5
 */
class ViewQueryBuilder {
  constructor(
    private view: DatabaseView,
    private params: ViewQueryParams
  ) {}

  build(): { query: string; params: any[] } {
    const parts: string[] = []
    const queryParams: any[] = []
    let paramIndex = 1

    // SELECT clause
    if (this.params.select && this.params.select.length > 0) {
      const selectedColumns = this.params.select
        .filter(col => this.view.columns.some(c => c.name === col))
        .map(col => `"${col}"`)
        .join(', ')
      parts.push(`SELECT ${selectedColumns || '*'}`)
    } else {
      parts.push('SELECT *')
    }

    // FROM clause
    parts.push(`FROM "${this.view.schema}"."${this.view.name}"`)

    // WHERE clause
    if (this.params.filters && this.params.filters.length > 0) {
      const whereConditions: string[] = []
      
      for (const filter of this.params.filters) {
        const column = this.view.columns.find(c => c.name === filter.column)
        if (!column) continue

        const condition = this.buildFilterCondition(filter, paramIndex)
        if (condition) {
          whereConditions.push(condition.sql)
          queryParams.push(...condition.params)
          paramIndex += condition.params.length
        }
      }

      if (whereConditions.length > 0) {
        parts.push(`WHERE ${whereConditions.join(' AND ')}`)
      }
    }

    // ORDER BY clause
    if (this.params.order && this.params.order.length > 0) {
      const orderClauses = this.params.order
        .filter(ord => this.view.columns.some(c => c.name === ord.column))
        .map(ord => `"${ord.column}" ${ord.direction || 'ASC'}`)
      
      if (orderClauses.length > 0) {
        parts.push(`ORDER BY ${orderClauses.join(', ')}`)
      }
    }

    // LIMIT and OFFSET
    if (this.params.limit) {
      parts.push(`LIMIT $${paramIndex}`)
      queryParams.push(this.params.limit)
      paramIndex++
    }

    if (this.params.offset) {
      parts.push(`OFFSET $${paramIndex}`)
      queryParams.push(this.params.offset)
      paramIndex++
    }

    return {
      query: parts.join(' '),
      params: queryParams
    }
  }

  buildCountQuery(): { query: string; params: any[] } {
    const parts: string[] = []
    const queryParams: any[] = []
    let paramIndex = 1

    parts.push('SELECT COUNT(*)')
    parts.push(`FROM "${this.view.schema}"."${this.view.name}"`)

    // WHERE clause (same as main query)
    if (this.params.filters && this.params.filters.length > 0) {
      const whereConditions: string[] = []
      
      for (const filter of this.params.filters) {
        const column = this.view.columns.find(c => c.name === filter.column)
        if (!column) continue

        const condition = this.buildFilterCondition(filter, paramIndex)
        if (condition) {
          whereConditions.push(condition.sql)
          queryParams.push(...condition.params)
          paramIndex += condition.params.length
        }
      }

      if (whereConditions.length > 0) {
        parts.push(`WHERE ${whereConditions.join(' AND ')}`)
      }
    }

    return {
      query: parts.join(' '),
      params: queryParams
    }
  }

  private buildFilterCondition(
    filter: ViewFilter,
    startParamIndex: number
  ): { sql: string; params: any[] } | null {
    const column = `"${filter.column}"`
    const params: any[] = []
    let paramIndex = startParamIndex

    switch (filter.operator) {
      case 'eq':
        return { sql: `${column} = $${paramIndex}`, params: [filter.value] }
      
      case 'neq':
        return { sql: `${column} != $${paramIndex}`, params: [filter.value] }
      
      case 'gt':
        return { sql: `${column} > $${paramIndex}`, params: [filter.value] }
      
      case 'gte':
        return { sql: `${column} >= $${paramIndex}`, params: [filter.value] }
      
      case 'lt':
        return { sql: `${column} < $${paramIndex}`, params: [filter.value] }
      
      case 'lte':
        return { sql: `${column} <= $${paramIndex}`, params: [filter.value] }
      
      case 'like':
        return { sql: `${column} LIKE $${paramIndex}`, params: [filter.value] }
      
      case 'ilike':
        return { sql: `${column} ILIKE $${paramIndex}`, params: [filter.value] }
      
      case 'in':
        if (Array.isArray(filter.value)) {
          const placeholders = filter.value.map((_, i) => `$${paramIndex + i}`).join(', ')
          return { sql: `${column} IN (${placeholders})`, params: filter.value }
        }
        return null
      
      case 'is':
        if (filter.value === null) {
          return { sql: `${column} IS NULL`, params: [] }
        } else if (filter.value === true) {
          return { sql: `${column} IS TRUE`, params: [] }
        } else if (filter.value === false) {
          return { sql: `${column} IS FALSE`, params: [] }
        }
        return { sql: `${column} IS $${paramIndex}`, params: [filter.value] }
      
      default:
        return null
    }
  }
}

/**
 * Database view definition
 * Requirements: 2.1, 2.4
 */
export interface DatabaseView {
  name: string
  schema: string
  definition: string
  isUpdatable: boolean
  isInsertable: boolean
  isTriggerUpdatable: boolean
  isTriggerDeletable: boolean
  isTriggerInsertable: boolean
  description?: string
  columns: ViewColumn[]
  permissions: ViewPermissions
}

/**
 * View column definition
 * Requirements: 2.4
 */
export interface ViewColumn {
  name: string
  type: string
  udtName: string
  isNullable: boolean
  defaultValue?: string
  ordinalPosition: number
  characterMaximumLength?: number
  numericPrecision?: number
  numericScale?: number
  isIdentity: boolean
  isGenerated: boolean
  generationExpression?: string
}

/**
 * View permissions
 * Requirements: 2.3
 */
export interface ViewPermissions {
  select: boolean
  insert: boolean
  update: boolean
  delete: boolean
}

/**
 * View access validation result
 * Requirements: 2.3
 */
export interface ViewAccessValidation {
  isValid: boolean
  error?: string
  code?: string
  view?: DatabaseView
}

/**
 * View query parameters
 * Requirements: 2.2, 2.5
 */
export interface ViewQueryParams {
  select?: string[]
  filters?: ViewFilter[]
  order?: ViewOrder[]
  limit?: number
  offset?: number
  count?: boolean
}

/**
 * View filter definition
 * Requirements: 2.2
 */
export interface ViewFilter {
  column: string
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is'
  value: any
}

/**
 * View order definition
 * Requirements: 2.2
 */
export interface ViewOrder {
  column: string
  direction?: 'ASC' | 'DESC'
}

/**
 * View query result
 * Requirements: 2.1, 2.2, 2.5
 */
export interface ViewQueryResult {
  success: boolean
  data: any[]
  view: DatabaseView | null
  executionTime: number
  rowCount: number
  totalCount?: number
  error?: string
}

/**
 * Factory function to get the database view service
 */
export function getDatabaseViewService(): DatabaseViewService {
  return DatabaseViewService.getInstance()
}