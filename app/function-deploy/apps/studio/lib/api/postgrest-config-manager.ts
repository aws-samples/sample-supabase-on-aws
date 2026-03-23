import { ProjectIsolationContext } from './secure-api-wrapper'
import { DataApiConfigResponse } from './data-api-config-data-access'
import { getProjectDatabaseClient, ProjectMetadata } from './project-database-client'

/**
 * PostgREST Configuration Manager
 * Handles dynamic PostgREST configuration based on project context
 */
export class PostgRESTConfigManager {
  private static instance: PostgRESTConfigManager
  private projectConfigs: Map<string, PostgRESTProjectConfig> = new Map()

  private constructor() {}

  static getInstance(): PostgRESTConfigManager {
    if (!PostgRESTConfigManager.instance) {
      PostgRESTConfigManager.instance = new PostgRESTConfigManager()
    }
    return PostgRESTConfigManager.instance
  }

  /**
   * Get or create PostgREST configuration for a project
   */
  async getProjectConfig(
    context: ProjectIsolationContext,
    dataApiConfig: DataApiConfigResponse
  ): Promise<PostgRESTProjectConfig> {
    const projectRef = context.projectRef
    
    // Check if we have a cached configuration
    if (this.projectConfigs.has(projectRef)) {
      const cachedConfig = this.projectConfigs.get(projectRef)!
      
      // Update the configuration if it has changed
      if (this.hasConfigChanged(cachedConfig, dataApiConfig)) {
        const updatedConfig = await this.createProjectConfig(context, dataApiConfig)
        this.projectConfigs.set(projectRef, updatedConfig)
        return updatedConfig
      }
      
      return cachedConfig
    }
    
    // Create new configuration
    const newConfig = await this.createProjectConfig(context, dataApiConfig)
    this.projectConfigs.set(projectRef, newConfig)
    return newConfig
  }

  /**
   * Create PostgREST configuration for a project
   */
  private async createProjectConfig(
    context: ProjectIsolationContext,
    dataApiConfig: DataApiConfigResponse
  ): Promise<PostgRESTProjectConfig> {
    const projectRef = context.projectRef
    
    // Get project database connection details
    const projectConnection = await this.getProjectConnection(projectRef)
    
    // Build PostgREST configuration
    const config: PostgRESTProjectConfig = {
      projectRef,
      databaseUrl: this.buildDatabaseUrl(projectConnection),
      schemas: dataApiConfig.exposedSchemas,
      extraSearchPath: dataApiConfig.extraSearchPath,
      maxRows: dataApiConfig.maxRows,
      poolSize: dataApiConfig.poolSize,
      jwtSecret: process.env.JWT_SECRET || '',
      anonRole: 'anon',
      enableDataApi: dataApiConfig.enableDataApi,
      lastUpdated: new Date(dataApiConfig.lastUpdated)
    }
    
    return config
  }

  /**
   * Get project database connection details from studio_projects table
   */
  private async getProjectConnection(projectRef: string): Promise<ProjectDatabaseConnection> {
    try {
      // Use the project database client to get project metadata
      const projectDbClient = getProjectDatabaseClient()
      const projectData = await projectDbClient.getProjectByRef(projectRef)
      
      if (!projectData) {
        throw new Error(`Project not found: ${projectRef}`)
      }
      
      return {
        host: process.env.POSTGRES_HOST || 'db',
        port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
        database: projectData.database_name,
        username: projectData.database_user,
        password: projectData.database_password_hash
      }
    } catch (error) {
      console.error('Failed to get project connection details:', error)
      throw new Error(`Failed to get project connection for ${projectRef}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Build PostgreSQL connection URL
   */
  private buildDatabaseUrl(connection: ProjectDatabaseConnection): string {
    return `postgresql://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`
  }

  /**
   * Check if the Data API configuration has changed
   */
  private hasConfigChanged(
    cachedConfig: PostgRESTProjectConfig,
    newDataApiConfig: DataApiConfigResponse
  ): boolean {
    const newLastUpdated = new Date(newDataApiConfig.lastUpdated)
    return newLastUpdated > cachedConfig.lastUpdated ||
           cachedConfig.enableDataApi !== newDataApiConfig.enableDataApi ||
           JSON.stringify(cachedConfig.schemas) !== JSON.stringify(newDataApiConfig.exposedSchemas) ||
           JSON.stringify(cachedConfig.extraSearchPath) !== JSON.stringify(newDataApiConfig.extraSearchPath) ||
           cachedConfig.maxRows !== newDataApiConfig.maxRows ||
           cachedConfig.poolSize !== newDataApiConfig.poolSize
  }

  /**
   * Clear cached configuration for a project
   */
  clearProjectConfig(projectRef: string): void {
    this.projectConfigs.delete(projectRef)
  }

  /**
   * Get all cached project configurations
   */
  getAllProjectConfigs(): Map<string, PostgRESTProjectConfig> {
    return new Map(this.projectConfigs)
  }
}

/**
 * PostgREST configuration for a specific project
 */
export interface PostgRESTProjectConfig {
  projectRef: string
  databaseUrl: string
  schemas: string[]
  extraSearchPath: string[]
  maxRows: number
  poolSize: number | null
  jwtSecret: string
  anonRole: string
  enableDataApi: boolean
  lastUpdated: Date
}

/**
 * Project database connection details
 */
interface ProjectDatabaseConnection {
  host: string
  port: number
  database: string
  username: string
  password: string
}

/**
 * Factory function to get the PostgREST configuration manager
 */
export function getPostgRESTConfigManager(): PostgRESTConfigManager {
  return PostgRESTConfigManager.getInstance()
}