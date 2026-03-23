import { ProjectIsolationContext } from './secure-api-wrapper'
import { 
  DataApiAccessControl, 
  DataApiAccessContext, 
  DataApiAccessResult,
  createDataApiAccessControl 
} from './data-api-access-control'
import { createDataApiConfigDataAccess } from './data-api-config-data-access'

/**
 * High-level service for Data API access management
 * 
 * Provides convenient methods for common access control operations
 * and integrates with the broader application architecture.
 */
export class DataApiAccessService {
  private accessControl: DataApiAccessControl

  constructor(private context: ProjectIsolationContext) {
    this.accessControl = createDataApiAccessControl(context)
  }

  /**
   * Check if a user can access a specific schema through the Data API
   */
  async canAccessSchema(schemaName: string, operation: 'read' | 'write' | 'delete' = 'read'): Promise<boolean> {
    const result = await this.accessControl.checkAccess({
      projectRef: this.context.projectRef,
      requestedSchema: schemaName,
      operation
    })
    return result.allowed
  }

  /**
   * Check if a user can access multiple schemas through the Data API
   */
  async canAccessSchemas(schemaNames: string[], operation: 'read' | 'write' | 'delete' = 'read'): Promise<boolean> {
    const result = await this.accessControl.checkAccess({
      projectRef: this.context.projectRef,
      requestedSchemas: schemaNames,
      operation
    })
    return result.allowed
  }

  /**
   * Get detailed access information for a schema
   */
  async getSchemaAccessInfo(schemaName: string, operation: 'read' | 'write' | 'delete' = 'read'): Promise<DataApiAccessResult> {
    return this.accessControl.checkAccess({
      projectRef: this.context.projectRef,
      requestedSchema: schemaName,
      operation
    })
  }

  /**
   * Get detailed access information for multiple schemas
   */
  async getSchemasAccessInfo(schemaNames: string[], operation: 'read' | 'write' | 'delete' = 'read'): Promise<DataApiAccessResult> {
    return this.accessControl.checkAccess({
      projectRef: this.context.projectRef,
      requestedSchemas: schemaNames,
      operation
    })
  }

  /**
   * Check if the Data API is enabled for the project
   */
  async isDataApiEnabled(): Promise<boolean> {
    const result = await this.accessControl.checkAccess({
      projectRef: this.context.projectRef,
      operation: 'read'
    })
    return result.allowed && result.config?.enableDataApi === true
  }

  /**
   * Get the list of schemas exposed through the Data API
   */
  async getExposedSchemas(): Promise<string[]> {
    try {
      const dataApiConfigDA = createDataApiConfigDataAccess(this.context)
      const config = await dataApiConfigDA.getConfiguration()
      return config.exposedSchemas || []
    } catch (error) {
      console.error('Error getting exposed schemas:', error)
      return []
    }
  }

  /**
   * Get the list of all schemas that are allowed to be exposed
   * (excludes system schemas)
   */
  async getAllowedSchemas(): Promise<string[]> {
    // In a real implementation, this would query the database
    // to get all available schemas and filter them
    const mockSchemas = [
      'public',
      'auth', // This will be filtered out as it's a system schema
      'custom_app',
      'reporting',
      'analytics',
      'pg_catalog', // This will be filtered out as it's a system schema
      'information_schema' // This will be filtered out as it's a system schema
    ]

    return DataApiAccessControl.filterAllowedSchemas(mockSchemas)
  }

  /**
   * Validate that a schema can be exposed through the Data API
   */
  validateSchemaForExposure(schemaName: string): { valid: boolean; reason?: string } {
    if (!DataApiAccessControl.isSchemaAllowedForExposure(schemaName)) {
      return {
        valid: false,
        reason: `Schema '${schemaName}' is a system schema and cannot be exposed through the Data API`
      }
    }

    // Additional validation can be added here
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schemaName)) {
      return {
        valid: false,
        reason: `Schema name '${schemaName}' contains invalid characters`
      }
    }

    return { valid: true }
  }

  /**
   * Validate multiple schemas for exposure
   */
  validateSchemasForExposure(schemaNames: string[]): { valid: boolean; invalidSchemas: string[]; reasons: string[] } {
    const invalidSchemas: string[] = []
    const reasons: string[] = []

    for (const schema of schemaNames) {
      const validation = this.validateSchemaForExposure(schema)
      if (!validation.valid) {
        invalidSchemas.push(schema)
        reasons.push(validation.reason || 'Unknown validation error')
      }
    }

    return {
      valid: invalidSchemas.length === 0,
      invalidSchemas,
      reasons
    }
  }

  /**
   * Get access control summary for the project
   */
  async getAccessControlSummary(): Promise<{
    dataApiEnabled: boolean
    exposedSchemas: string[]
    allowedSchemas: string[]
    totalExposedSchemas: number
    totalAllowedSchemas: number
    lastUpdated?: string
  }> {
    try {
      const dataApiConfigDA = createDataApiConfigDataAccess(this.context)
      const config = await dataApiConfigDA.getConfiguration()
      const allowedSchemas = await this.getAllowedSchemas()

      return {
        dataApiEnabled: config.enableDataApi,
        exposedSchemas: config.exposedSchemas || [],
        allowedSchemas,
        totalExposedSchemas: config.exposedSchemas?.length || 0,
        totalAllowedSchemas: allowedSchemas.length,
        lastUpdated: config.lastUpdated
      }
    } catch (error) {
      console.error('Error getting access control summary:', error)
      return {
        dataApiEnabled: false,
        exposedSchemas: [],
        allowedSchemas: [],
        totalExposedSchemas: 0,
        totalAllowedSchemas: 0
      }
    }
  }
}

/**
 * Factory function to create Data API access service
 */
export function createDataApiAccessService(context: ProjectIsolationContext): DataApiAccessService {
  return new DataApiAccessService(context)
}

/**
 * Utility functions for common access control operations
 */
export const DataApiAccessUtils = {
  /**
   * Check if a schema name is valid for exposure
   */
  isValidSchemaName: (schemaName: string): boolean => {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schemaName)
  },

  /**
   * Check if a schema is a system schema
   */
  isSystemSchema: (schemaName: string): boolean => {
    return !DataApiAccessControl.isSchemaAllowedForExposure(schemaName)
  },

  /**
   * Filter out system schemas from a list
   */
  filterSystemSchemas: (schemas: string[]): string[] => {
    return DataApiAccessControl.filterAllowedSchemas(schemas)
  },

  /**
   * Get system schema names that are not allowed
   */
  getSystemSchemas: (): string[] => {
    return [
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
  }
}