import { ProjectIsolationContext } from './secure-api-wrapper'
import { MaxRowsEnforcementService } from './max-rows-enforcement-service'
import { PoolSizeConfigurationService } from './pool-size-configuration-service'

export interface DataApiConfiguration {
  id: string
  projectRef: string
  enableDataApi: boolean
  exposedSchemas: string[]
  extraSearchPath: string[]
  maxRows: number
  poolSize: number | null
  createdAt: Date
  updatedAt: Date
  version: number
}

export interface DataApiConfigRequest {
  enableDataApi?: boolean
  exposedSchemas?: string[]
  extraSearchPath?: string[]
  maxRows?: number
  poolSize?: number | null
}

export interface DataApiConfigResponse {
  projectUrl: string
  enableDataApi: boolean
  exposedSchemas: string[]
  extraSearchPath: string[]
  maxRows: number
  poolSize: number | null
  lastUpdated: string
}

/**
 * Data access layer for Data API configuration management
 * Automatically applies project filtering and validation
 */
export class DataApiConfigDataAccess {
  private configCache: Map<string, DataApiConfigResponse> = new Map()

  constructor(private context: ProjectIsolationContext) {}

  /**
   * Get current Data API configuration for the project
   */
  async getConfiguration(): Promise<DataApiConfigResponse> {
    const projectRef = this.context.projectRef
    
    // Check if we have a cached configuration for this project
    if (this.configCache.has(projectRef)) {
      return this.configCache.get(projectRef)!
    }
    
    // Load from persistent storage (database)
    const persistedConfig = await this.loadPersistedConfiguration(projectRef)
    if (persistedConfig) {
      this.configCache.set(projectRef, persistedConfig)
      return persistedConfig
    }
    
    // Fall back to environment variables and defaults for initial configuration
    const projectUrl = this.buildProjectUrl()
    
    const defaultConfig: DataApiConfigResponse = {
      projectUrl,
      enableDataApi: process.env.POSTGREST_ENABLED !== 'false',
      exposedSchemas: this.parseSchemas(process.env.PGRST_DB_SCHEMAS || 'public'),
      extraSearchPath: this.parseSchemas(process.env.PGRST_DB_EXTRA_SEARCH_PATH || ''),
      maxRows: parseInt(process.env.PGRST_DB_MAX_ROWS || '1000', 10),
      poolSize: process.env.PGRST_DB_POOL ? parseInt(process.env.PGRST_DB_POOL, 10) : null,
      lastUpdated: new Date().toISOString()
    }
    
    // Cache the default configuration
    this.configCache.set(projectRef, defaultConfig)
    
    return defaultConfig
  }

  /**
   * Update Data API configuration for the project
   */
  async updateConfiguration(config: DataApiConfigRequest): Promise<DataApiConfigResponse> {
    // Store current configuration for potential rollback
    const currentConfig = await this.getConfiguration()
    
    // Validate the configuration
    this.validateConfiguration(config)
    
    // Create the updated configuration
    const updatedConfig: DataApiConfigResponse = {
      ...currentConfig,
      ...config,
      lastUpdated: new Date().toISOString()
    }

    try {
      // Apply configuration changes immediately without service restart
      await this.applyConfigurationImmediately(updatedConfig)
      
      // Validate that the configuration was applied successfully
      await this.validateConfigurationHealth(updatedConfig)
      
      // Persist the configuration to storage
      await this.persistConfiguration(updatedConfig)
      
      // Update the cache
      this.configCache.set(this.context.projectRef, updatedConfig)
      
      return updatedConfig
    } catch (error) {
      // If anything fails, rollback to previous configuration
      console.warn('Configuration update failed, rolling back:', error)
      await this.rollbackConfiguration(currentConfig)
      throw error
    }
  }

  /**
   * Rollback to a previous configuration
   */
  async rollbackConfiguration(previousConfig: DataApiConfigResponse): Promise<void> {
    try {
      await this.applyConfigurationImmediately(previousConfig)
      await this.persistConfiguration(previousConfig)
      
      // Update the cache with the rolled back configuration
      this.configCache.set(this.context.projectRef, previousConfig)
      
      console.log('Successfully rolled back to previous configuration')
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError)
      throw new Error(`Configuration rollback failed: ${rollbackError instanceof Error ? rollbackError.message : 'Unknown error'}`)
    }
  }

  /**
   * Validate configuration parameters
   */
  private validateConfiguration(config: DataApiConfigRequest): void {
    if (config.maxRows !== undefined) {
      MaxRowsEnforcementService.validateMaxRowsConfig(config.maxRows)
    }

    if (config.poolSize !== undefined) {
      const validation = PoolSizeConfigurationService.validatePoolSize(config.poolSize)
      if (!validation.isValid) {
        throw new Error(`Pool size validation failed: ${validation.errors.join(', ')}`)
      }
    }

    if (config.exposedSchemas !== undefined) {
      if (config.exposedSchemas.length === 0 && config.enableDataApi !== false) {
        throw new Error('At least one schema must be exposed when Data API is enabled')
      }
      
      // Validate schema names
      for (const schema of config.exposedSchemas) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
          throw new Error(`Invalid schema name: ${schema}`)
        }
      }

      // Import access control for schema validation
      const { DataApiAccessControl } = require('./data-api-access-control')
      
      // Validate that schemas are allowed to be exposed
      const disallowedSchemas = config.exposedSchemas.filter(
        schema => !DataApiAccessControl.isSchemaAllowedForExposure(schema)
      )
      
      if (disallowedSchemas.length > 0) {
        throw new Error(`The following schemas cannot be exposed (system schemas are restricted): ${disallowedSchemas.join(', ')}`)
      }
    }

    if (config.extraSearchPath !== undefined) {
      // Validate search path schema names
      for (const schema of config.extraSearchPath) {
        if (schema && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
          throw new Error(`Invalid schema name in search path: ${schema}`)
        }
      }
      
      // Additional validation: check for duplicate schemas in search path
      const duplicates = config.extraSearchPath.filter((schema, index) => 
        config.extraSearchPath.indexOf(schema) !== index
      )
      
      if (duplicates.length > 0) {
        throw new Error(`Duplicate schemas in search path: ${duplicates.join(', ')}`)
      }
      
      // Validate search path length (PostgreSQL has practical limits)
      if (config.extraSearchPath.length > 20) {
        throw new Error('Search path cannot contain more than 20 schemas')
      }
    }
  }

  /**
   * Apply configuration changes to the Data API service
   */
  private async applyConfiguration(config: DataApiConfigResponse): Promise<void> {
    // In a real implementation, this would:
    // 1. Update PostgREST configuration
    // 2. Restart or reload PostgREST service
    // 3. Validate that the service is healthy
    
    // For now, we'll simulate a successful application
    console.log('Applying Data API configuration:', config)
  }

  /**
   * Apply configuration changes immediately without service restart
   */
  private async applyConfigurationImmediately(config: DataApiConfigResponse): Promise<void> {
    // In a real implementation, this would:
    // 1. Update PostgREST configuration files
    // 2. Send SIGHUP signal to PostgREST to reload configuration
    // 3. Update connection pool settings dynamically
    // 4. Apply schema exposure changes without restart
    
    console.log('Applying Data API configuration immediately:', config)
    
    // Apply search path configuration with proper resolution order
    await this.applySearchPathConfiguration(config.extraSearchPath)
    
    // Apply pool size configuration
    if (config.poolSize !== undefined) {
      await PoolSizeConfigurationService.applyPoolSizeConfiguration(
        config.poolSize, 
        this.context.projectRef
      )
    }
    
    // Apply max rows configuration
    if (config.maxRows !== undefined) {
      await this.applyMaxRowsConfiguration(config.maxRows)
    }
    
    // Simulate configuration application with potential failure
    if (Math.random() < 0.1) { // 10% chance of failure for testing
      throw new Error('Simulated configuration application failure')
    }
    
    // Simulate the time it takes to apply configuration
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  /**
   * Apply max rows configuration
   */
  private async applyMaxRowsConfiguration(maxRows: number): Promise<void> {
    console.log('Applying max rows configuration:', maxRows)
    
    // Validate max rows before applying
    MaxRowsEnforcementService.validateMaxRowsConfig(maxRows)
    
    // In a real implementation, this would:
    // 1. Update PostgREST's max-rows configuration
    // 2. Reload PostgREST configuration to apply the new limit
    // 3. Ensure all API endpoints respect the new limit
    
    // Simulate configuration application
    await new Promise(resolve => setTimeout(resolve, 50))
    
    console.log(`Max rows configuration applied: ${maxRows} rows per query`)
  }

  /**
   * Apply search path configuration with proper resolution order
   */
  private async applySearchPathConfiguration(extraSearchPath: string[]): Promise<void> {
    // Format search path for PostgreSQL
    const formattedSearchPath = this.formatSearchPathForPostgreSQL(extraSearchPath)
    
    console.log('Applying search path configuration:', {
      extraSearchPath,
      formattedSearchPath,
      resolutionOrder: this.getSearchPathResolutionOrder(extraSearchPath)
    })
    
    // In a real implementation, this would:
    // 1. Update PostgREST's db-extra-search-path configuration
    // 2. Reload PostgREST configuration to apply the new search path
    // 3. Validate that the search path is working correctly
    
    // The search path resolution order will be:
    // 1. Schemas in extraSearchPath (in the order specified)
    // 2. Default PostgreSQL search path (usually "$user", public)
  }

  /**
   * Format search path array for PostgreSQL configuration
   */
  private formatSearchPathForPostgreSQL(searchPath: string[]): string {
    if (searchPath.length === 0) {
      return ''
    }
    
    // Quote schema names that need quoting and join with commas
    return searchPath
      .map(schema => {
        // Quote schema names that contain special characters or are reserved words
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) && !this.isPostgreSQLReservedWord(schema)) {
          return schema
        } else {
          return `"${schema.replace(/"/g, '""')}"` // Escape quotes by doubling them
        }
      })
      .join(', ')
  }

  /**
   * Get the complete search path resolution order
   */
  private getSearchPathResolutionOrder(extraSearchPath: string[]): string[] {
    // The complete resolution order includes:
    // 1. Extra search path schemas (in specified order)
    // 2. Default PostgreSQL search path
    const defaultSearchPath = ['$user', 'public']
    
    return [...extraSearchPath, ...defaultSearchPath]
  }

  /**
   * Check if a schema name is a PostgreSQL reserved word
   */
  private isPostgreSQLReservedWord(word: string): boolean {
    const reservedWords = [
      'user', 'public', 'information_schema', 'pg_catalog',
      'select', 'from', 'where', 'insert', 'update', 'delete',
      'create', 'drop', 'alter', 'table', 'index', 'view'
    ]
    
    return reservedWords.includes(word.toLowerCase())
  }

  /**
   * Validate that the configuration was applied successfully and the API is healthy
   */
  private async validateConfigurationHealth(config: DataApiConfigResponse): Promise<void> {
    // In a real implementation, this would:
    // 1. Test that PostgREST is responding to requests
    // 2. Validate that exposed schemas are accessible
    // 3. Test that connection pool is functioning with new settings
    // 4. Verify that search path is working correctly
    
    console.log('Validating Data API health after configuration update')
    
    // Simulate health check with potential failure
    if (Math.random() < 0.05) { // 5% chance of health check failure
      throw new Error('Data API health check failed after configuration update')
    }
    
    // Simulate health check time
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  /**
   * Load persisted configuration from database
   */
  private async loadPersistedConfiguration(projectRef: string): Promise<DataApiConfigResponse | null> {
    try {
      // Use persistent storage directory instead of temporary directory
      const fs = require('fs').promises
      const path = require('path')
      
      // Use persistent .supabase directory (same as Edge Function Secrets)
      const configDir = path.join(process.cwd(), '.supabase', 'data-api-configs')
      const configFile = path.join(configDir, `${projectRef}.json`)
      
      try {
        const configData = await fs.readFile(configFile, 'utf8')
        const config = JSON.parse(configData)
        
        // Ensure the project URL is current
        config.projectUrl = this.buildProjectUrl()
        
        console.log('Loaded persisted configuration from:', configFile)
        return config
      } catch (error) {
        // File doesn't exist or is invalid, return null
        console.log('No persisted configuration found at:', configFile)
        return null
      }
    } catch (error) {
      console.warn('Failed to load persisted configuration:', error)
      return null
    }
  }

  /**
   * Persist configuration to storage
   */
  private async persistConfiguration(config: DataApiConfigResponse): Promise<void> {
    try {
      // Use persistent storage directory instead of temporary directory
      const fs = require('fs').promises
      const path = require('path')
      
      // Use persistent .supabase directory (same as Edge Function Secrets)
      const configDir = path.join(process.cwd(), '.supabase', 'data-api-configs')
      const configFile = path.join(configDir, `${this.context.projectRef}.json`)
      
      // Ensure directory exists
      try {
        await fs.mkdir(configDir, { recursive: true })
      } catch (error) {
        // Directory might already exist
      }
      
      // Write configuration to file
      await fs.writeFile(configFile, JSON.stringify(config, null, 2), 'utf8')
      
      console.log('Configuration persisted to:', configFile)
    } catch (error) {
      console.error('Failed to persist configuration:', error)
      throw new Error(`Failed to persist configuration: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Build the project URL for the Data API
   */
  private buildProjectUrl(): string {
    const protocol = process.env.PROJECT_ENDPOINT_PROTOCOL || 'http'
    const endpoint = process.env.PROJECT_ENDPOINT || 'localhost:8000'
    const projectRef = this.context.projectRef
    return `${protocol}://${endpoint}/rest/v1/projects/${projectRef}`
  }

  /**
   * Parse comma-separated schema list
   */
  private parseSchemas(schemaString: string): string[] {
    if (!schemaString) return []
    return schemaString
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
  }
}

/**
 * Factory function to create Data API configuration data access instance
 * @param context - Project isolation context
 * @returns Data API configuration data access instance
 */
export function createDataApiConfigDataAccess(context: ProjectIsolationContext): DataApiConfigDataAccess {
  return new DataApiConfigDataAccess(context)
}