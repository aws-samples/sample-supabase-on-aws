import { NextApiRequest, NextApiResponse } from 'next'
import { ProjectIsolationContext } from './secure-api-wrapper'
import { DataApiConfigResponse } from './data-api-config-data-access'
import { EnhancedProjectPostgRESTEngine } from './enhanced-project-postgrest-engine'

/**
 * Project-specific REST API proxy service
 * Uses our enhanced PostgREST engine to handle requests with project-specific database connections
 * Supports RPC, transactions, aggregates, full-text search, and more
 */
export class ProjectRestProxy {
  constructor(
    private context: ProjectIsolationContext,
    private config: DataApiConfigResponse
  ) {}

  /**
   * Proxy a REST API request using our enhanced PostgREST engine
   * All enhanced features are enabled by default
   */
  async proxyRequest(req: NextApiRequest, res: NextApiResponse, targetPath: string): Promise<void> {
    try {
      // Validate resource path (basic security check)
      // Note: targetPath can be 'rpc/function_name', 'table_name', 'functions', etc.
      if (!this.isValidResourcePath(targetPath)) {
        return res.status(400).json({
          code: 'PGRST103',
          message: 'Invalid resource path',
          hint: 'Resource path must contain only letters, numbers, underscores, and forward slashes'
        })
      }
      
      // For table access, check if the table is in allowed schemas
      // Skip this check for special paths like 'rpc/', 'functions', 'schema'
      if (!this.isSpecialPath(targetPath) && !this.isResourceInAllowedSchemas(targetPath)) {
        return res.status(403).json({
          code: 'PGRST301',
          message: 'Permission denied for schema',
          hint: 'The resource is not in an exposed schema'
        })
      }
      
      // Use enhanced PostgREST engine with all features enabled by default
      const postgrestEngine = new EnhancedProjectPostgRESTEngine(this.context, this.config)
      await postgrestEngine.handleEnhancedRequest(req, res, this.context, this.config, targetPath)
      
    } catch (error) {
      console.error('Project REST proxy error:', error)
      
      res.status(500).json({
        code: 'PGRST000',
        message: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  /**
   * Validate resource path for security
   * Allows table names, RPC paths, and special endpoints
   */
  private isValidResourcePath(resourcePath: string): boolean {
    if (!resourcePath) return true // Empty path is valid (will be handled by engine)
    
    // Allow alphanumeric characters, underscores, dots (for schema.table), and forward slashes (for rpc/)
    const validPattern = /^[a-zA-Z_][a-zA-Z0-9_/]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/
    return validPattern.test(resourcePath)
  }

  /**
   * Check if path is a special endpoint (not a table)
   */
  private isSpecialPath(resourcePath: string): boolean {
    if (!resourcePath) return false
    
    const specialPaths = ['rpc/', 'functions', 'schema']
    return specialPaths.some(path => resourcePath.startsWith(path) || resourcePath === path)
  }

  /**
   * Check if resource is in allowed schemas
   */
  private isResourceInAllowedSchemas(resourcePath: string): boolean {
    const allowedSchemas = this.config.exposedSchemas
    
    // If no schema specified in resource path, assume public schema
    if (!resourcePath.includes('.')) {
      return allowedSchemas.includes('public')
    }
    
    // Extract schema from resource path
    const [schema] = resourcePath.split('.')
    return allowedSchemas.includes(schema)
  }
}

/**
 * Factory function to create a project REST proxy
 */
export function createProjectRestProxy(
  context: ProjectIsolationContext,
  config: DataApiConfigResponse
): ProjectRestProxy {
  return new ProjectRestProxy(context, config)
}