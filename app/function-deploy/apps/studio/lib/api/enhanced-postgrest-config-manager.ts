import { ProjectIsolationContext } from './secure-api-wrapper'
import { DataApiConfigResponse } from './data-api-config-data-access'
import { getProjectDatabaseClient } from './project-database-client'
import { getPostgRESTConfigManager, PostgRESTProjectConfig } from './postgrest-config-manager'

/**
 * Enhanced PostgREST Configuration Manager
 * Manages enhanced PostgREST configuration with advanced features
 * Uses composition instead of inheritance to work with the singleton PostgRESTConfigManager
 * Requirements: 1.1, 2.1, 13.1
 */
export class EnhancedPostgRESTConfigManager {
  private static enhancedInstance: EnhancedPostgRESTConfigManager
  private containerConfigs: Map<string, EnhancedContainerConfig> = new Map()
  private healthCheckIntervals: Map<string, NodeJS.Timeout> = new Map()
  private baseConfigManager = getPostgRESTConfigManager()

  private constructor() {}

  static getInstance(): EnhancedPostgRESTConfigManager {
    if (!EnhancedPostgRESTConfigManager.enhancedInstance) {
      EnhancedPostgRESTConfigManager.enhancedInstance = new EnhancedPostgRESTConfigManager()
    }
    return EnhancedPostgRESTConfigManager.enhancedInstance
  }

  /**
   * Get enhanced PostgREST configuration for a project
   * Requirements: 1.1, 2.1
   */
  async getEnhancedProjectConfig(
    context: ProjectIsolationContext,
    dataApiConfig: DataApiConfigResponse
  ): Promise<EnhancedPostgRESTProjectConfig> {
    const baseConfig = await this.baseConfigManager.getProjectConfig(context, dataApiConfig)
    const projectRef = context.projectRef
    
    // Check if we have enhanced configuration cached
    if (this.containerConfigs.has(projectRef)) {
      const cachedConfig = this.containerConfigs.get(projectRef)!
      
      // Update if configuration has changed
      if (this.hasEnhancedConfigChanged(cachedConfig, dataApiConfig)) {
        const updatedConfig = await this.createEnhancedProjectConfig(context, baseConfig, dataApiConfig)
        this.containerConfigs.set(projectRef, updatedConfig)
        return updatedConfig
      }
      
      return cachedConfig
    }
    
    // Create new enhanced configuration
    const enhancedConfig = await this.createEnhancedProjectConfig(context, baseConfig, dataApiConfig)
    this.containerConfigs.set(projectRef, enhancedConfig)
    
    // Start health monitoring for this project
    this.startHealthMonitoring(projectRef)
    
    return enhancedConfig
  }

  /**
   * Create enhanced PostgREST configuration
   * Requirements: 1.1, 2.1, 13.1
   */
  private async createEnhancedProjectConfig(
    context: ProjectIsolationContext,
    baseConfig: PostgRESTProjectConfig,
    dataApiConfig: DataApiConfigResponse
  ): Promise<EnhancedPostgRESTProjectConfig> {
    const projectRef = context.projectRef
    
    // Get project-specific database connection details
    const connectionDetails = await this.getProjectConnectionDetails(projectRef)
    
    // Build enhanced configuration
    // All features are enabled by default, can be disabled via environment variables
    const enhancedConfig: EnhancedPostgRESTProjectConfig = {
      ...baseConfig,
      // Enhanced features configuration (default: true, disable with DISABLE_* env vars)
      enableRPCFunctions: process.env.DISABLE_RPC_FUNCTIONS !== 'true',
      enableDatabaseViews: process.env.DISABLE_DATABASE_VIEWS !== 'true',
      enableAdvancedJSON: process.env.DISABLE_ADVANCED_JSON !== 'true',
      enableFullTextSearch: process.env.DISABLE_FULL_TEXT_SEARCH !== 'true',
      enableAdvancedFiltering: process.env.DISABLE_ADVANCED_FILTERING !== 'true',
      enableAggregateQueries: process.env.DISABLE_AGGREGATE_QUERIES !== 'true',
      enableBulkOperations: process.env.DISABLE_BULK_OPERATIONS !== 'true',
      enableNestedResources: process.env.DISABLE_NESTED_RESOURCES !== 'true',
      enableTransactions: process.env.DISABLE_TRANSACTIONS !== 'true',
      enableArrayOperations: process.env.DISABLE_ARRAY_OPERATIONS !== 'true',
      enableContentNegotiation: process.env.DISABLE_CONTENT_NEGOTIATION !== 'true',
      enableResponseShaping: process.env.DISABLE_RESPONSE_SHAPING !== 'true',
      
      // Performance and monitoring configuration
      queryTimeout: 30000, // 30 seconds
      connectionPoolSize: dataApiConfig.poolSize || 10,
      enableQueryLogging: true,
      enablePerformanceMonitoring: true,
      enableCaching: false, // Disabled by default for consistency
      
      // Container communication configuration
      containerHealthEndpoint: `/health/${projectRef}`,
      containerConfigEndpoint: `/config/${projectRef}`,
      containerMetricsEndpoint: `/metrics/${projectRef}`,
      
      // Database connection details
      connectionDetails,
      
      // Health monitoring configuration
      healthCheckInterval: 30000, // 30 seconds
      healthCheckTimeout: 5000, // 5 seconds
      lastHealthCheck: null,
      healthStatus: 'unknown',
      
      // Logging configuration
      logLevel: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
      enableRequestLogging: true,
      enableErrorLogging: true,
      
      lastUpdated: new Date()
    }
    
    return enhancedConfig
  }

  /**
   * Get project-specific database connection details
   * Requirements: 1.1, 2.1
   */
  private async getProjectConnectionDetails(projectRef: string): Promise<ProjectConnectionDetails> {
    try {
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
        password: projectData.database_password_hash,
        ssl: process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: true, ca: require('fs').readFileSync(process.env.RDS_CA_CERT_PATH || '/etc/ssl/certs/rds-global-bundle.pem', 'utf-8') }
          : false,
        maxConnections: 20,
        idleTimeoutMs: 30000,
        connectionTimeoutMs: 5000,
        schema: 'public'
      }
    } catch (error) {
      console.error(`Failed to get connection details for project ${projectRef}:`, error)
      throw new Error(`Failed to get project connection details: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Check if enhanced configuration has changed
   * Requirements: 13.1
   */
  private hasEnhancedConfigChanged(
    cachedConfig: EnhancedContainerConfig,
    newDataApiConfig: DataApiConfigResponse
  ): boolean {
    const newLastUpdated = new Date(newDataApiConfig.lastUpdated)
    return newLastUpdated > cachedConfig.lastUpdated ||
           cachedConfig.enableDataApi !== newDataApiConfig.enableDataApi ||
           JSON.stringify(cachedConfig.schemas) !== JSON.stringify(newDataApiConfig.exposedSchemas) ||
           cachedConfig.maxRows !== newDataApiConfig.maxRows ||
           cachedConfig.poolSize !== newDataApiConfig.poolSize
  }

  /**
   * Start health monitoring for a project
   * Requirements: 13.1
   */
  private startHealthMonitoring(projectRef: string): void {
    // Clear existing interval if any
    const existingInterval = this.healthCheckIntervals.get(projectRef)
    if (existingInterval) {
      clearInterval(existingInterval)
    }
    
    // Start new health check interval
    const interval = setInterval(async () => {
      await this.performHealthCheck(projectRef)
    }, 30000) // Check every 30 seconds
    
    this.healthCheckIntervals.set(projectRef, interval)
    
    // Perform initial health check
    this.performHealthCheck(projectRef).catch(error => {
      console.error(`Initial health check failed for project ${projectRef}:`, error)
    })
  }

  /**
   * Perform health check for a project
   * Requirements: 13.1
   */
  private async performHealthCheck(projectRef: string): Promise<void> {
    try {
      const config = this.containerConfigs.get(projectRef)
      if (!config) {
        return
      }
      
      const startTime = Date.now()
      
      // Test database connection
      const projectDbClient = getProjectDatabaseClient()
      await projectDbClient.queryProjectDatabase(
        projectRef,
        'system', // System user for health checks
        'SELECT 1 as health_check',
        [],
        { skipPermissionCheck: true }
      )
      
      const responseTime = Date.now() - startTime
      
      // Update health status
      config.lastHealthCheck = new Date()
      config.healthStatus = 'healthy'
      config.lastResponseTime = responseTime
      
      console.debug(`Health check passed for project ${projectRef} (${responseTime}ms)`)
    } catch (error) {
      const config = this.containerConfigs.get(projectRef)
      if (config) {
        config.lastHealthCheck = new Date()
        config.healthStatus = 'unhealthy'
        config.lastError = error instanceof Error ? error.message : 'Unknown error'
      }
      
      console.error(`Health check failed for project ${projectRef}:`, error)
    }
  }

  /**
   * Get health status for a project
   * Requirements: 13.1
   */
  getProjectHealthStatus(projectRef: string): ProjectHealthStatus | null {
    const config = this.containerConfigs.get(projectRef)
    if (!config) {
      return null
    }
    
    return {
      projectRef,
      status: config.healthStatus,
      lastCheck: config.lastHealthCheck,
      responseTime: config.lastResponseTime,
      error: config.lastError
    }
  }

  /**
   * Update project configuration
   * Requirements: 1.1, 2.1
   */
  async updateProjectConfig(
    projectRef: string,
    updates: Partial<EnhancedPostgRESTProjectConfig>
  ): Promise<void> {
    const config = this.containerConfigs.get(projectRef)
    if (!config) {
      throw new Error(`Project configuration not found: ${projectRef}`)
    }
    
    // Apply updates
    Object.assign(config, updates, { lastUpdated: new Date() })
    
    console.log(`Updated configuration for project ${projectRef}`)
  }

  /**
   * Stop health monitoring for a project
   * Requirements: 13.1
   */
  stopHealthMonitoring(projectRef: string): void {
    const interval = this.healthCheckIntervals.get(projectRef)
    if (interval) {
      clearInterval(interval)
      this.healthCheckIntervals.delete(projectRef)
    }
    
    console.log(`Stopped health monitoring for project ${projectRef}`)
  }

  /**
   * Clear enhanced configuration for a project
   */
  clearEnhancedProjectConfig(projectRef: string): void {
    this.stopHealthMonitoring(projectRef)
    this.containerConfigs.delete(projectRef)
    this.baseConfigManager.clearProjectConfig(projectRef) // Clear base configuration
  }

  /**
   * Get all enhanced project configurations
   */
  getAllEnhancedProjectConfigs(): Map<string, EnhancedContainerConfig> {
    return new Map(this.containerConfigs)
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // Stop all health monitoring intervals
    for (const [projectRef] of this.healthCheckIntervals) {
      this.stopHealthMonitoring(projectRef)
    }
    
    // Clear all configurations
    this.containerConfigs.clear()
  }
}

/**
 * Enhanced PostgREST configuration interface
 * Requirements: 1.1, 2.1, 13.1
 */
export interface EnhancedPostgRESTProjectConfig extends PostgRESTProjectConfig {
  // Enhanced features
  enableRPCFunctions: boolean
  enableDatabaseViews: boolean
  enableAdvancedJSON: boolean
  enableFullTextSearch: boolean
  enableAdvancedFiltering: boolean
  enableAggregateQueries: boolean
  enableBulkOperations: boolean
  enableNestedResources: boolean
  enableTransactions: boolean
  enableArrayOperations: boolean
  enableContentNegotiation: boolean
  enableResponseShaping: boolean
  
  // Performance configuration
  queryTimeout: number
  connectionPoolSize: number
  enableQueryLogging: boolean
  enablePerformanceMonitoring: boolean
  enableCaching: boolean
  
  // Container communication
  containerHealthEndpoint: string
  containerConfigEndpoint: string
  containerMetricsEndpoint: string
  
  // Database connection details
  connectionDetails: ProjectConnectionDetails
  
  // Health monitoring
  healthCheckInterval: number
  healthCheckTimeout: number
  lastHealthCheck: Date | null
  healthStatus: 'healthy' | 'unhealthy' | 'unknown'
  lastResponseTime?: number
  lastError?: string
  
  // Logging configuration
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  enableRequestLogging: boolean
  enableErrorLogging: boolean
}

/**
 * Type alias for enhanced container configuration
 */
export type EnhancedContainerConfig = EnhancedPostgRESTProjectConfig

/**
 * Project database connection details
 * Requirements: 1.1, 2.1
 */
export interface ProjectConnectionDetails {
  host: string
  port: number
  database: string
  username: string
  password: string
  ssl: boolean
  maxConnections: number
  idleTimeoutMs: number
  connectionTimeoutMs: number
  schema: string
}

/**
 * Project health status
 * Requirements: 13.1
 */
export interface ProjectHealthStatus {
  projectRef: string
  status: 'healthy' | 'unhealthy' | 'unknown'
  lastCheck: Date | null
  responseTime?: number
  error?: string
}

/**
 * Factory function to get the enhanced PostgREST configuration manager
 */
export function getEnhancedPostgRESTConfigManager(): EnhancedPostgRESTConfigManager {
  return EnhancedPostgRESTConfigManager.getInstance()
}