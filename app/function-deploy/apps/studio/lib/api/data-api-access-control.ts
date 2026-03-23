import { NextApiRequest, NextApiResponse } from 'next'
import { ProjectIsolationContext } from './secure-api-wrapper'
import { createDataApiConfigDataAccess, DataApiConfigResponse } from './data-api-config-data-access'

/**
 * Data API access control error types
 */
export class DataApiAccessError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 403
  ) {
    super(message)
    this.name = 'DataApiAccessError'
  }
}

/**
 * Data API access control result
 */
export interface DataApiAccessResult {
  allowed: boolean
  reason?: string
  config?: DataApiConfigResponse
}

/**
 * Data API access request context
 */
export interface DataApiAccessContext {
  projectRef: string
  requestedSchema?: string
  requestedSchemas?: string[]
  operation: 'read' | 'write' | 'delete'
  endpoint?: string
}

/**
 * Data API Access Control Service
 * 
 * Provides centralized access control logic for Data API requests
 * based on project configuration and schema exposure settings.
 */
export class DataApiAccessControl {
  constructor(private context: ProjectIsolationContext) {}

  /**
   * Check if Data API access is allowed for the given request context
   */
  async checkAccess(accessContext: DataApiAccessContext): Promise<DataApiAccessResult> {
    try {
      // Get current Data API configuration
      const dataApiConfigDA = createDataApiConfigDataAccess(this.context)
      const config = await dataApiConfigDA.getConfiguration()

      // Check if Data API is enabled
      if (!config.enableDataApi) {
        return {
          allowed: false,
          reason: 'Data API is disabled for this project',
          config
        }
      }

      // Check schema-based access control
      const schemaAccessResult = this.checkSchemaAccess(config, accessContext)
      if (!schemaAccessResult.allowed) {
        return schemaAccessResult
      }

      // All checks passed
      return {
        allowed: true,
        config
      }
    } catch (error) {
      console.error('Error checking Data API access:', error)
      return {
        allowed: false,
        reason: 'Failed to validate Data API access permissions'
      }
    }
  }

  /**
   * Check schema-based access control
   */
  private checkSchemaAccess(
    config: DataApiConfigResponse, 
    accessContext: DataApiAccessContext
  ): DataApiAccessResult {
    const { exposedSchemas } = config
    const { requestedSchema, requestedSchemas } = accessContext

    // If no schemas are exposed, deny all access
    if (!exposedSchemas || exposedSchemas.length === 0) {
      return {
        allowed: false,
        reason: 'No schemas are exposed through the Data API',
        config
      }
    }

    // Check single schema access
    if (requestedSchema) {
      if (!exposedSchemas.includes(requestedSchema)) {
        return {
          allowed: false,
          reason: `Schema '${requestedSchema}' is not exposed through the Data API`,
          config
        }
      }
    }

    // Check multiple schemas access
    if (requestedSchemas && requestedSchemas.length > 0) {
      const unauthorizedSchemas = requestedSchemas.filter(
        schema => !exposedSchemas.includes(schema)
      )
      
      if (unauthorizedSchemas.length > 0) {
        return {
          allowed: false,
          reason: `Schemas not exposed through Data API: ${unauthorizedSchemas.join(', ')}`,
          config
        }
      }
    }

    return {
      allowed: true,
      config
    }
  }

  /**
   * Validate that a schema name is allowed to be exposed
   * Excludes system schemas that should not be exposed
   */
  static isSchemaAllowedForExposure(schemaName: string): boolean {
    const systemSchemas = [
      'information_schema',
      'pg_catalog',
      'pg_toast',
      'pg_temp_1',
      'pg_toast_temp_1',
      'auth',
      'pgbouncer',
      'hooks',
      'extensions',
      'realtime',
      'supabase_functions',
      'storage',
      'graphql',
      'graphql_public',
      'pgsodium',
      'pgsodium_masks',
      'vault'
    ]

    // Exclude system schemas
    if (systemSchemas.includes(schemaName.toLowerCase())) {
      return false
    }

    // Exclude schemas starting with pg_
    if (schemaName.toLowerCase().startsWith('pg_')) {
      return false
    }

    // Exclude temporary schemas
    if (schemaName.toLowerCase().includes('temp')) {
      return false
    }

    return true
  }

  /**
   * Get list of schemas that are allowed to be exposed
   */
  static filterAllowedSchemas(schemas: string[]): string[] {
    return schemas.filter(schema => DataApiAccessControl.isSchemaAllowedForExposure(schema))
  }
}

/**
 * Middleware function to enforce Data API access control
 * 
 * This middleware should be applied to Data API endpoints to ensure
 * that requests are only allowed when the Data API is enabled and
 * the requested schemas are properly exposed.
 */
export function withDataApiAccessControl(
  handler: (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => Promise<any>,
  options: {
    extractSchemaFromRequest?: (req: NextApiRequest) => string | string[] | undefined
    operation?: 'read' | 'write' | 'delete'
  } = {}
) {
  return async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
    const accessControl = new DataApiAccessControl(context)
    
    // Extract schema information from request
    const extractedSchema = options.extractSchemaFromRequest?.(req)
    let requestedSchema: string | undefined
    let requestedSchemas: string[] | undefined

    if (typeof extractedSchema === 'string') {
      requestedSchema = extractedSchema
    } else if (Array.isArray(extractedSchema)) {
      requestedSchemas = extractedSchema
    }

    // Determine operation type from HTTP method if not specified
    const operation = options.operation || getOperationFromMethod(req.method)

    // Create access context
    const accessContext: DataApiAccessContext = {
      projectRef: context.projectRef,
      requestedSchema,
      requestedSchemas,
      operation,
      endpoint: req.url
    }

    // Check access
    const accessResult = await accessControl.checkAccess(accessContext)

    if (!accessResult.allowed) {
      // Log access denial for security audit
      console.warn('Data API access denied', {
        userId: context.userId,
        projectId: context.projectId,
        projectRef: context.projectRef,
        endpoint: req.url,
        method: req.method,
        reason: accessResult.reason,
        requestedSchema,
        requestedSchemas,
        timestamp: new Date().toISOString()
      })

      // Return 403 Forbidden with detailed error message
      res.status(403).json({
        data: null,
        error: {
          message: accessResult.reason || 'Data API access denied',
          code: 'DATA_API_ACCESS_DENIED',
          details: {
            enableDataApi: accessResult.config?.enableDataApi,
            exposedSchemas: accessResult.config?.exposedSchemas,
            requestedSchema,
            requestedSchemas
          }
        }
      })
      return
    }

    // Log successful access for security audit
    console.log('Data API access granted', {
      userId: context.userId,
      projectId: context.projectId,
      projectRef: context.projectRef,
      endpoint: req.url,
      method: req.method,
      requestedSchema,
      requestedSchemas,
      operation,
      timestamp: new Date().toISOString()
    })

    // Access granted, proceed with the handler
    return handler(req, res, context)
  }
}

/**
 * Helper function to determine operation type from HTTP method
 */
function getOperationFromMethod(method?: string): 'read' | 'write' | 'delete' {
  switch (method?.toUpperCase()) {
    case 'GET':
    case 'HEAD':
      return 'read'
    case 'POST':
    case 'PUT':
    case 'PATCH':
      return 'write'
    case 'DELETE':
      return 'delete'
    default:
      return 'read'
  }
}

/**
 * Schema extraction helpers for common Data API patterns
 */
export const SchemaExtractors = {
  /**
   * Extract schema from URL path parameter
   * Example: /api/data/schema/public/table -> 'public'
   */
  fromPathParam: (paramName: string = 'schema') => (req: NextApiRequest): string | undefined => {
    return req.query[paramName] as string | undefined
  },

  /**
   * Extract schema from request body
   * Example: { schema: 'public', table: 'users' } -> 'public'
   */
  fromBody: (fieldName: string = 'schema') => (req: NextApiRequest): string | undefined => {
    return req.body?.[fieldName] as string | undefined
  },

  /**
   * Extract multiple schemas from request body array
   * Example: { schemas: ['public', 'auth'] } -> ['public', 'auth']
   */
  fromBodyArray: (fieldName: string = 'schemas') => (req: NextApiRequest): string[] | undefined => {
    const schemas = req.body?.[fieldName]
    return Array.isArray(schemas) ? schemas : undefined
  },

  /**
   * Extract schema from query parameter
   * Example: ?schema=public -> 'public'
   */
  fromQuery: (paramName: string = 'schema') => (req: NextApiRequest): string | undefined => {
    return req.query[paramName] as string | undefined
  },

  /**
   * Extract multiple schemas from query parameter
   * Example: ?schemas=public,auth -> ['public', 'auth']
   */
  fromQueryArray: (paramName: string = 'schemas') => (req: NextApiRequest): string[] | undefined => {
    const schemas = req.query[paramName] as string | undefined
    return schemas ? schemas.split(',').map(s => s.trim()) : undefined
  },

  /**
   * Custom schema extractor
   */
  custom: (extractor: (req: NextApiRequest) => string | string[] | undefined) => extractor
}

/**
 * Factory function to create Data API access control instance
 */
export function createDataApiAccessControl(context: ProjectIsolationContext): DataApiAccessControl {
  return new DataApiAccessControl(context)
}

/**
 * Utility function to check if Data API is enabled for a project
 */
export async function isDataApiEnabled(context: ProjectIsolationContext): Promise<boolean> {
  try {
    const accessControl = new DataApiAccessControl(context)
    const result = await accessControl.checkAccess({
      projectRef: context.projectRef,
      operation: 'read'
    })
    return result.allowed
  } catch (error) {
    console.error('Error checking if Data API is enabled:', error)
    return false
  }
}

/**
 * Utility function to get exposed schemas for a project
 */
export async function getExposedSchemas(context: ProjectIsolationContext): Promise<string[]> {
  try {
    const dataApiConfigDA = createDataApiConfigDataAccess(context)
    const config = await dataApiConfigDA.getConfiguration()
    return config.exposedSchemas || []
  } catch (error) {
    console.error('Error getting exposed schemas:', error)
    return []
  }
}