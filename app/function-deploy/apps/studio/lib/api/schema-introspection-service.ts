import { NextApiRequest, NextApiResponse } from 'next'
import { ProjectIsolationContext } from './secure-api-wrapper'
import { DatabaseViewService } from './database-view-service'
import { RPCFunctionService } from './rpc-function-service'
import { getProjectDatabaseClient } from './project-database-client'

/**
 * Schema Introspection Service
 * Provides comprehensive database schema introspection and OpenAPI specification generation
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5
 */
export class SchemaIntrospectionService {
  private viewService: DatabaseViewService
  private rpcService: RPCFunctionService
  private schemaCache: Map<string, SchemaIntrospectionResult> = new Map()
  private cacheExpiry: Map<string, number> = new Map()
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  constructor(viewService: DatabaseViewService, rpcService: RPCFunctionService) {
    this.viewService = viewService
    this.rpcService = rpcService
  }

  /**
   * Generate comprehensive OpenAPI specification for a project schema
   * Requirements: 14.1, 14.2
   */
  async generateOpenAPISpec(projectContext: ProjectIsolationContext, schema: string = 'public'): Promise<OpenAPISpecification> {
    const cacheKey = `${projectContext.projectRef}-${schema}`
    
    // Check cache first
    const cached = this.getCachedResult(cacheKey)
    if (cached) {
      return cached.openApiSpec
    }

    try {
      // Discover all schema components
      const [tables, views, functions, permissions] = await Promise.all([
        this.discoverTables(projectContext, schema),
        this.viewService.discoverViews(projectContext, schema),
        this.rpcService.discoverFunctions(projectContext, schema),
        this.discoverPermissions(projectContext, schema)
      ])

      // Build comprehensive OpenAPI specification
      const openApiSpec: OpenAPISpecification = {
        openapi: '3.0.0',
        info: {
          title: `${projectContext.projectRef} REST API`,
          version: '1.0.0',
          description: 'Auto-generated OpenAPI specification for enhanced PostgREST API',
          contact: {
            name: 'Supabase Support',
            url: 'https://supabase.com/support'
          }
        },
        servers: [
          {
            url: `/projects/${projectContext.projectRef}/api/rest/v1`,
            description: 'Enhanced PostgREST API server'
          }
        ],
        paths: {},
        components: {
          schemas: {},
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT'
            },
            apiKeyAuth: {
              type: 'apiKey',
              in: 'header',
              name: 'apikey'
            }
          }
        },
        security: [
          { bearerAuth: [] },
          { apiKeyAuth: [] }
        ]
      }

      // Add table paths and schemas
      for (const table of tables) {
        this.addTableToOpenAPI(openApiSpec, table, permissions)
      }

      // Add view paths and schemas
      for (const view of views) {
        this.addViewToOpenAPI(openApiSpec, view, permissions)
      }

      // Add RPC function paths
      for (const func of functions) {
        this.addFunctionToOpenAPI(openApiSpec, func)
      }

      // Cache the result
      const result: SchemaIntrospectionResult = {
        openApiSpec,
        tables,
        views,
        functions,
        permissions,
        lastUpdated: new Date(),
        schemaVersion: await this.getSchemaVersion(projectContext, schema)
      }

      this.setCachedResult(cacheKey, result)

      return openApiSpec
    } catch (error) {
      console.error('Failed to generate OpenAPI specification:', error)
      throw new Error(`OpenAPI generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Discover all tables in the schema
   * Requirements: 14.1, 14.3
   */
  async discoverTables(projectContext: ProjectIsolationContext, schema: string): Promise<TableDefinition[]> {
    try {
      const projectDbClient = getProjectDatabaseClient()
      const query = `
        SELECT 
          t.table_name,
          t.table_schema,
          t.table_type,
          obj_description(c.oid) as table_comment,
          COALESCE(
            json_agg(
              json_build_object(
                'column_name', col.column_name,
                'data_type', col.data_type,
                'is_nullable', col.is_nullable = 'YES',
                'column_default', col.column_default,
                'is_identity', col.is_identity = 'YES',
                'is_generated', col.is_generated = 'ALWAYS',
                'character_maximum_length', col.character_maximum_length,
                'numeric_precision', col.numeric_precision,
                'numeric_scale', col.numeric_scale,
                'column_comment', col_desc.description
              ) ORDER BY col.ordinal_position
            ) FILTER (WHERE col.column_name IS NOT NULL),
            '[]'::json
          ) as columns,
          COALESCE(
            json_agg(
              DISTINCT jsonb_build_object(
                'constraint_name', tc.constraint_name,
                'constraint_type', tc.constraint_type,
                'column_name', kcu.column_name
              )
            ) FILTER (WHERE tc.constraint_name IS NOT NULL),
            '[]'::json
          ) as constraints
        FROM information_schema.tables t
        LEFT JOIN pg_class c ON c.relname = t.table_name
        LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
        LEFT JOIN information_schema.columns col ON col.table_name = t.table_name 
          AND col.table_schema = t.table_schema
        LEFT JOIN pg_description col_desc ON col_desc.objoid = c.oid 
          AND col_desc.objsubid = col.ordinal_position
        LEFT JOIN information_schema.table_constraints tc ON tc.table_name = t.table_name 
          AND tc.table_schema = t.table_schema
        LEFT JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
        WHERE t.table_schema = $1 
          AND t.table_type = 'BASE TABLE'
        GROUP BY t.table_name, t.table_schema, t.table_type, c.oid
        ORDER BY t.table_name
      `

      const result = await projectDbClient.queryProjectDatabase(
        projectContext.projectRef,
        projectContext.userId,
        query,
        [schema],
        { timeout: 30000 }
      )
      
      return result.rows.map(row => ({
        name: row.table_name,
        schema: row.table_schema,
        type: row.table_type,
        description: row.table_comment,
        columns: row.columns.map((col: any) => ({
          name: col.column_name,
          type: col.data_type,
          isNullable: col.is_nullable,
          defaultValue: col.column_default,
          isIdentity: col.is_identity,
          isGenerated: col.is_generated,
          maxLength: col.character_maximum_length,
          precision: col.numeric_precision,
          scale: col.numeric_scale,
          description: col.column_comment
        })),
        constraints: row.constraints.map((constraint: any) => ({
          name: constraint.constraint_name,
          type: constraint.constraint_type,
          columnName: constraint.column_name
        })),
        primaryKeys: row.constraints
          .filter((c: any) => c.constraint_type === 'PRIMARY KEY')
          .map((c: any) => c.column_name),
        foreignKeys: row.constraints
          .filter((c: any) => c.constraint_type === 'FOREIGN KEY')
          .map((c: any) => ({
            columnName: c.column_name,
            constraintName: c.constraint_name
          }))
      }))
    } catch (error) {
      console.error('Failed to discover tables:', error)
      throw new Error(`Table discovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Discover permissions for schema objects
   * Requirements: 14.4
   */
  async discoverPermissions(projectContext: ProjectIsolationContext, schema: string): Promise<PermissionMap> {
    try {
      const projectDbClient = getProjectDatabaseClient()
      const query = `
        SELECT 
          schemaname,
          tablename,
          usename,
          has_table_privilege(usename, schemaname||'.'||tablename, 'SELECT') as can_select,
          has_table_privilege(usename, schemaname||'.'||tablename, 'INSERT') as can_insert,
          has_table_privilege(usename, schemaname||'.'||tablename, 'UPDATE') as can_update,
          has_table_privilege(usename, schemaname||'.'||tablename, 'DELETE') as can_delete
        FROM pg_tables 
        CROSS JOIN pg_user
        WHERE schemaname = $1
        UNION ALL
        SELECT 
          schemaname,
          viewname as tablename,
          usename,
          has_table_privilege(usename, schemaname||'.'||viewname, 'SELECT') as can_select,
          has_table_privilege(usename, schemaname||'.'||viewname, 'INSERT') as can_insert,
          has_table_privilege(usename, schemaname||'.'||viewname, 'UPDATE') as can_update,
          has_table_privilege(usename, schemaname||'.'||viewname, 'DELETE') as can_delete
        FROM pg_views 
        CROSS JOIN pg_user
        WHERE schemaname = $1
      `

      const result = await projectDbClient.queryProjectDatabase(
        projectContext.projectRef,
        projectContext.userId,
        query,
        [schema],
        { timeout: 30000 }
      )
      
      const permissions: PermissionMap = {}
      
      for (const row of result.rows) {
        const key = `${row.schemaname}.${row.tablename}`
        if (!permissions[key]) {
          permissions[key] = {}
        }
        
        permissions[key][row.usename] = {
          select: row.can_select,
          insert: row.can_insert,
          update: row.can_update,
          delete: row.can_delete
        }
      }

      return permissions
    } catch (error) {
      console.error('Failed to discover permissions:', error)
      return {}
    }
  }

  /**
   * Get current schema version for change detection
   * Requirements: 14.3
   */
  async getSchemaVersion(projectContext: ProjectIsolationContext, schema: string): Promise<string> {
    try {
      const projectDbClient = getProjectDatabaseClient()
      const query = `
        SELECT 
          md5(
            string_agg(
              concat(
                t.table_name, 
                t.table_type,
                coalesce(obj_description(c.oid), ''),
                (
                  SELECT string_agg(
                    concat(col.column_name, col.data_type, col.is_nullable, coalesce(col.column_default, '')),
                    '|' ORDER BY col.ordinal_position
                  )
                  FROM information_schema.columns col 
                  WHERE col.table_name = t.table_name AND col.table_schema = t.table_schema
                )
              ), 
              '||' ORDER BY t.table_name
            )
          ) as schema_hash
        FROM information_schema.tables t
        LEFT JOIN pg_class c ON c.relname = t.table_name
        LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
        WHERE t.table_schema = $1
      `

      const result = await projectDbClient.queryProjectDatabase(
        projectContext.projectRef,
        projectContext.userId,
        query,
        [schema],
        { timeout: 30000 }
      )
      return result.rows[0]?.schema_hash || 'unknown'
    } catch (error) {
      console.error('Failed to get schema version:', error)
      return 'error'
    }
  }

  /**
   * Detect if schema has changed since last introspection
   * Requirements: 14.3
   */
  async hasSchemaChanged(projectContext: ProjectIsolationContext, schema: string): Promise<boolean> {
    const cacheKey = `${projectContext.projectRef}-${schema}`
    const cached = this.getCachedResult(cacheKey)
    
    if (!cached) {
      return true // No cache means we need to introspect
    }

    const currentVersion = await this.getSchemaVersion(projectContext, schema)
    return currentVersion !== cached.schemaVersion
  }

  /**
   * Add table definition to OpenAPI specification
   */
  private addTableToOpenAPI(spec: OpenAPISpecification, table: TableDefinition, permissions: PermissionMap): void {
    const tablePath = `/${table.name}`
    const schemaName = `${table.name}Schema`
    
    // Add schema definition
    spec.components!.schemas![schemaName] = {
      type: 'object',
      description: table.description,
      properties: table.columns.reduce((props, col) => {
        props[col.name] = {
          type: this.mapPostgreSQLTypeToOpenAPI(col.type),
          description: col.description,
          nullable: col.isNullable,
          readOnly: col.isGenerated || col.isIdentity,
          maxLength: col.maxLength,
          ...(col.defaultValue && { default: col.defaultValue })
        }
        return props
      }, {} as Record<string, any>),
      required: table.columns
        .filter(col => !col.isNullable && !col.defaultValue && !col.isGenerated && !col.isIdentity)
        .map(col => col.name)
    }

    // Add path operations
    const pathSpec: any = {}

    // GET operation (always available for tables)
    pathSpec.get = {
      summary: `Query ${table.name} table`,
      description: table.description || `Retrieve data from the ${table.name} table`,
      parameters: this.getStandardQueryParameters(),
      responses: {
        200: {
          description: 'Successful response',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { $ref: `#/components/schemas/${schemaName}` }
              }
            }
          }
        },
        400: { description: 'Bad request' },
        401: { description: 'Unauthorized' },
        403: { description: 'Forbidden' }
      }
    }

    // POST operation (if insert permissions exist)
    const tableKey = `${table.schema}.${table.name}`
    const hasInsertPermission = permissions[tableKey] && 
      Object.values(permissions[tableKey]).some(perms => perms.insert)

    if (hasInsertPermission) {
      pathSpec.post = {
        summary: `Insert into ${table.name} table`,
        description: `Insert new records into the ${table.name} table`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: `#/components/schemas/${schemaName}` },
                  {
                    type: 'array',
                    items: { $ref: `#/components/schemas/${schemaName}` }
                  }
                ]
              }
            }
          }
        },
        responses: {
          201: { description: 'Created successfully' },
          400: { description: 'Bad request' },
          401: { description: 'Unauthorized' },
          403: { description: 'Forbidden' },
          409: { description: 'Conflict' }
        }
      }
    }

    // PATCH operation (if update permissions exist)
    const hasUpdatePermission = permissions[tableKey] && 
      Object.values(permissions[tableKey]).some(perms => perms.update)

    if (hasUpdatePermission) {
      pathSpec.patch = {
        summary: `Update ${table.name} table`,
        description: `Update records in the ${table.name} table`,
        parameters: this.getStandardQueryParameters(),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${schemaName}` }
            }
          }
        },
        responses: {
          200: { description: 'Updated successfully' },
          400: { description: 'Bad request' },
          401: { description: 'Unauthorized' },
          403: { description: 'Forbidden' },
          404: { description: 'Not found' }
        }
      }
    }

    // DELETE operation (if delete permissions exist)
    const hasDeletePermission = permissions[tableKey] && 
      Object.values(permissions[tableKey]).some(perms => perms.delete)

    if (hasDeletePermission) {
      pathSpec.delete = {
        summary: `Delete from ${table.name} table`,
        description: `Delete records from the ${table.name} table`,
        parameters: this.getStandardQueryParameters(),
        responses: {
          200: { description: 'Deleted successfully' },
          401: { description: 'Unauthorized' },
          403: { description: 'Forbidden' },
          404: { description: 'Not found' }
        }
      }
    }

    spec.paths[tablePath] = pathSpec
  }

  /**
   * Add view definition to OpenAPI specification
   */
  private addViewToOpenAPI(spec: OpenAPISpecification, view: any, permissions: PermissionMap): void {
    const viewPath = `/${view.name}`
    const schemaName = `${view.name}ViewSchema`
    
    // Add schema definition
    spec.components!.schemas![schemaName] = {
      type: 'object',
      description: view.description || `View: ${view.name}`,
      properties: view.columns.reduce((props: any, col: any) => {
        props[col.name] = {
          type: this.mapPostgreSQLTypeToOpenAPI(col.type),
          nullable: col.isNullable,
          readOnly: true // Views are generally read-only
        }
        return props
      }, {})
    }

    // Add path operations (views are typically read-only)
    const pathSpec: any = {
      get: {
        summary: `Query ${view.name} view`,
        description: view.description || `Retrieve data from the ${view.name} view`,
        parameters: this.getStandardQueryParameters(),
        responses: {
          200: {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: `#/components/schemas/${schemaName}` }
                }
              }
            }
          },
          400: { description: 'Bad request' },
          401: { description: 'Unauthorized' },
          403: { description: 'Forbidden' }
        }
      }
    }

    spec.paths[viewPath] = pathSpec
  }

  /**
   * Add function definition to OpenAPI specification
   */
  private addFunctionToOpenAPI(spec: OpenAPISpecification, func: any): void {
    const functionPath = `/rpc/${func.name}`
    
    spec.paths[functionPath] = {
      post: {
        summary: `Call ${func.name} function`,
        description: func.description || `Execute the ${func.name} PostgreSQL function`,
        requestBody: {
          required: func.parameters.length > 0,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: func.parameters.reduce((props: any, param: any) => {
                  props[param.name] = {
                    type: this.mapPostgreSQLTypeToOpenAPI(param.type),
                    description: `Parameter: ${param.name}`,
                    ...(param.defaultValue && { default: param.defaultValue })
                  }
                  return props
                }, {}),
                required: func.parameters
                  .filter((param: any) => param.isRequired)
                  .map((param: any) => param.name)
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Function executed successfully',
            content: {
              'application/json': {
                schema: func.isSetReturning 
                  ? { type: 'array', items: { type: 'object' } }
                  : { type: 'object' }
              }
            }
          },
          400: { description: 'Bad request' },
          401: { description: 'Unauthorized' },
          403: { description: 'Forbidden' },
          404: { description: 'Function not found' }
        }
      }
    }
  }

  /**
   * Get standard query parameters for REST endpoints
   */
  private getStandardQueryParameters(): any[] {
    return [
      {
        name: 'select',
        in: 'query',
        description: 'Columns to select (comma-separated)',
        schema: { type: 'string' },
        example: 'id,name,email'
      },
      {
        name: 'order',
        in: 'query',
        description: 'Ordering criteria',
        schema: { type: 'string' },
        example: 'created_at.desc,name.asc'
      },
      {
        name: 'limit',
        in: 'query',
        description: 'Limit number of rows returned',
        schema: { type: 'integer', minimum: 1, maximum: 1000 },
        example: 10
      },
      {
        name: 'offset',
        in: 'query',
        description: 'Skip number of rows',
        schema: { type: 'integer', minimum: 0 },
        example: 0
      },
      {
        name: 'range',
        in: 'header',
        description: 'Range for pagination',
        schema: { type: 'string' },
        example: '0-9'
      }
    ]
  }

  /**
   * Map PostgreSQL data types to OpenAPI types
   */
  private mapPostgreSQLTypeToOpenAPI(pgType: string): string {
    const type = pgType.toLowerCase()
    
    if (type.includes('int') || type.includes('serial')) return 'integer'
    if (type.includes('numeric') || type.includes('decimal') || type.includes('float') || type.includes('double')) return 'number'
    if (type.includes('bool')) return 'boolean'
    if (type.includes('json')) return 'object'
    if (type.includes('array') || type.includes('[]')) return 'array'
    if (type.includes('timestamp') || type.includes('date') || type.includes('time')) return 'string'
    if (type.includes('uuid')) return 'string'
    
    return 'string' // Default to string for text, varchar, char, etc.
  }

  /**
   * Cache management methods
   */
  private getCachedResult(key: string): SchemaIntrospectionResult | null {
    const expiry = this.cacheExpiry.get(key)
    if (!expiry || Date.now() > expiry) {
      this.schemaCache.delete(key)
      this.cacheExpiry.delete(key)
      return null
    }
    return this.schemaCache.get(key) || null
  }

  private setCachedResult(key: string, result: SchemaIntrospectionResult): void {
    this.schemaCache.set(key, result)
    this.cacheExpiry.set(key, Date.now() + this.CACHE_TTL)
  }

  /**
   * Clear cache for a specific project/schema
   */
  clearCache(projectRef: string, schema?: string): void {
    if (schema) {
      const key = `${projectRef}-${schema}`
      this.schemaCache.delete(key)
      this.cacheExpiry.delete(key)
    } else {
      // Clear all cache entries for the project
      for (const key of this.schemaCache.keys()) {
        if (key.startsWith(`${projectRef}-`)) {
          this.schemaCache.delete(key)
          this.cacheExpiry.delete(key)
        }
      }
    }
  }

  /**
   * Get introspection endpoint handler
   * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5
   */
  async handleIntrospectionRequest(
    req: NextApiRequest, 
    res: NextApiResponse, 
    projectContext: ProjectIsolationContext
  ): Promise<void> {
    try {
      const schema = (req.query.schema as string) || 'public'
      const format = (req.query.format as string) || 'openapi'
      const forceRefresh = req.query.refresh === 'true'

      if (forceRefresh) {
        this.clearCache(projectContext.projectRef, schema)
      }

      switch (format) {
        case 'openapi':
          const openApiSpec = await this.generateOpenAPISpec(projectContext, schema)
          res.setHeader('Content-Type', 'application/json')
          res.status(200).json(openApiSpec)
          break

        case 'summary':
          const summary = await this.generateSchemaSummary(projectContext, schema)
          res.setHeader('Content-Type', 'application/json')
          res.status(200).json(summary)
          break

        default:
          res.status(400).json({
            code: 'PGRST102',
            message: 'Invalid format parameter',
            details: 'Supported formats: openapi, summary',
            hint: 'Use ?format=openapi or ?format=summary'
          })
      }
    } catch (error) {
      console.error('Schema introspection request failed:', error)
      res.status(500).json({
        code: 'PGRST000',
        message: 'Schema introspection failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  /**
   * Generate a summary of schema information
   */
  private async generateSchemaSummary(projectContext: ProjectIsolationContext, schema: string): Promise<SchemaSummary> {
    const cacheKey = `${projectContext.projectRef}-${schema}`
    const cached = this.getCachedResult(cacheKey)
    
    if (cached) {
      return {
        schema,
        tableCount: cached.tables.length,
        viewCount: cached.views.length,
        functionCount: cached.functions.length,
        lastUpdated: cached.lastUpdated,
        schemaVersion: cached.schemaVersion,
        tables: cached.tables.map(t => ({ name: t.name, columnCount: t.columns.length })),
        views: cached.views.map(v => ({ name: v.name, columnCount: v.columns.length })),
        functions: cached.functions.map(f => ({ name: f.name, parameterCount: f.parameters.length }))
      }
    }

    // Generate full introspection to populate cache
    await this.generateOpenAPISpec(projectContext, schema)
    
    // Try again with cached data
    const newCached = this.getCachedResult(cacheKey)
    if (newCached) {
      return {
        schema,
        tableCount: newCached.tables.length,
        viewCount: newCached.views.length,
        functionCount: newCached.functions.length,
        lastUpdated: newCached.lastUpdated,
        schemaVersion: newCached.schemaVersion,
        tables: newCached.tables.map(t => ({ name: t.name, columnCount: t.columns.length })),
        views: newCached.views.map(v => ({ name: v.name, columnCount: v.columns.length })),
        functions: newCached.functions.map(f => ({ name: f.name, parameterCount: f.parameters.length }))
      }
    }

    throw new Error('Failed to generate schema summary')
  }
}

// Type definitions
export interface OpenAPISpecification {
  openapi: string
  info: {
    title: string
    version: string
    description?: string
    contact?: {
      name: string
      url: string
    }
  }
  servers: Array<{
    url: string
    description: string
  }>
  paths: Record<string, any>
  components?: {
    schemas?: Record<string, any>
    securitySchemes?: Record<string, any>
  }
  security?: Array<Record<string, any>>
}

export interface TableDefinition {
  name: string
  schema: string
  type: string
  description?: string
  columns: ColumnDefinition[]
  constraints: ConstraintDefinition[]
  primaryKeys: string[]
  foreignKeys: ForeignKeyDefinition[]
}

export interface ColumnDefinition {
  name: string
  type: string
  isNullable: boolean
  defaultValue?: any
  isIdentity: boolean
  isGenerated: boolean
  maxLength?: number
  precision?: number
  scale?: number
  description?: string
}

export interface ConstraintDefinition {
  name: string
  type: string
  columnName: string
}

export interface ForeignKeyDefinition {
  columnName: string
  constraintName: string
}

export interface PermissionMap {
  [tableKey: string]: {
    [username: string]: {
      select: boolean
      insert: boolean
      update: boolean
      delete: boolean
    }
  }
}

export interface SchemaIntrospectionResult {
  openApiSpec: OpenAPISpecification
  tables: TableDefinition[]
  views: any[]
  functions: any[]
  permissions: PermissionMap
  lastUpdated: Date
  schemaVersion: string
}

export interface SchemaSummary {
  schema: string
  tableCount: number
  viewCount: number
  functionCount: number
  lastUpdated: Date
  schemaVersion: string
  tables: Array<{ name: string; columnCount: number }>
  views: Array<{ name: string; columnCount: number }>
  functions: Array<{ name: string; parameterCount: number }>
}