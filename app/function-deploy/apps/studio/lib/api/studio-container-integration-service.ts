import { NextApiRequest } from 'next'
import { ProjectIsolationContext } from './secure-api-wrapper'
import { getEnhancedPostgRESTConfigManager, EnhancedPostgRESTProjectConfig } from './enhanced-postgrest-config-manager'
import { getSupabaseRestContainerClient, ContainerConfigurationResponse } from './supabase-rest-container-client'
import { getContainerHealthMonitor } from './container-health-monitor'
import { getContainerLoggingService } from './container-logging-service'

/**
 * Studio Container Integration Service
 * Coordinates communication between Studio and the enhanced supabase-rest container
 * Requirements: All requirements integration
 */
export class StudioContainerIntegrationService {
  private static instance: StudioContainerIntegrationService
  private configManager = getEnhancedPostgRESTConfigManager()
  private containerClient = getSupabaseRestContainerClient()
  private healthMonitor = getContainerHealthMonitor()
  private loggingService = getContainerLoggingService()

  private constructor() {}

  static getInstance(): StudioContainerIntegrationService {
    if (!StudioContainerIntegrationService.instance) {
      StudioContainerIntegrationService.instance = new StudioContainerIntegrationService()
    }
    return StudioContainerIntegrationService.instance
  }

  /**
   * Initialize container configuration for a project
   * Requirements: 1.1, 2.1, 13.1
   */
  async initializeProjectContainer(
    context: ProjectIsolationContext,
    req: NextApiRequest
  ): Promise<ContainerInitializationResult> {
    const { projectRef } = context

    try {
      console.log(`[Studio Integration] Initializing container for project ${projectRef}`)

      // Get current project configuration
      const config = await this.configManager.getEnhancedProjectConfig(context, req)

      // Update container with current configuration
      const containerResponse = await this.containerClient.updateContainerConfiguration(
        projectRef,
        config
      )

      if (!containerResponse.success) {
        throw new Error(`Container initialization failed: ${containerResponse.message}`)
      }

      // Start health monitoring
      await this.healthMonitor.startMonitoring(projectRef)

      // Initialize logging
      await this.loggingService.initializeProjectLogging(projectRef, {
        logLevel: config.logLevel,
        enableRequestLogging: config.enableRequestLogging,
        enableErrorLogging: config.enableErrorLogging
      })

      console.log(`[Studio Integration] ✓ Container initialized successfully for project ${projectRef}`)

      return {
        success: true,
        projectRef,
        message: 'Container initialized successfully',
        timestamp: new Date().toISOString(),
        containerStatus: 'healthy',
        featuresEnabled: this.getEnabledFeatures(config)
      }

    } catch (error) {
      console.error(`[Studio Integration] Container initialization failed for project ${projectRef}:`, error)

      return {
        success: false,
        projectRef,
        message: error instanceof Error ? error.message : 'Container initialization failed',
        timestamp: new Date().toISOString(),
        containerStatus: 'unhealthy',
        featuresEnabled: [],
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Update container configuration when Studio settings change
   * Requirements: 1.1, 2.1
   */
  async updateContainerConfiguration(
    context: ProjectIsolationContext,
    req: NextApiRequest,
    configUpdates: Partial<EnhancedPostgRESTProjectConfig>
  ): Promise<ContainerUpdateResult> {
    const { projectRef } = context

    try {
      console.log(`[Studio Integration] Updating container configuration for project ${projectRef}`)

      // Get current configuration
      const currentConfig = await this.configManager.getEnhancedProjectConfig(context, req)

      // Merge updates with current configuration
      const updatedConfig = {
        ...currentConfig,
        ...configUpdates
      }

      // Validate the updated configuration
      const validation = await this.validateConfiguration(updatedConfig)
      if (!validation.valid) {
        throw new Error(`Configuration validation failed: ${validation.errors.join(', ')}`)
      }

      // Update Studio configuration
      await this.configManager.updateEnhancedProjectConfig(context, req, updatedConfig)

      // Update container configuration
      const containerResponse = await this.containerClient.updateContainerConfiguration(
        projectRef,
        updatedConfig
      )

      // Update logging configuration if changed
      if (
        configUpdates.logLevel !== undefined ||
        configUpdates.enableRequestLogging !== undefined ||
        configUpdates.enableErrorLogging !== undefined
      ) {
        await this.loggingService.updateLoggingConfiguration(projectRef, {
          logLevel: updatedConfig.logLevel,
          enableRequestLogging: updatedConfig.enableRequestLogging,
          enableErrorLogging: updatedConfig.enableErrorLogging
        })
      }

      // Log the configuration change
      await this.loggingService.logConfigurationChange(projectRef, {
        previousConfig: currentConfig,
        newConfig: updatedConfig,
        updatedBy: context.userId,
        timestamp: new Date().toISOString()
      })

      console.log(`[Studio Integration] ✓ Container configuration updated for project ${projectRef}`)

      return {
        success: containerResponse.success,
        projectRef,
        message: containerResponse.message,
        timestamp: new Date().toISOString(),
        configurationApplied: updatedConfig,
        featuresChanged: this.getChangedFeatures(currentConfig, updatedConfig),
        containerResponse
      }

    } catch (error) {
      console.error(`[Studio Integration] Configuration update failed for project ${projectRef}:`, error)

      return {
        success: false,
        projectRef,
        message: error instanceof Error ? error.message : 'Configuration update failed',
        timestamp: new Date().toISOString(),
        configurationApplied: null,
        featuresChanged: [],
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Get comprehensive container status
   * Requirements: 13.1
   */
  async getContainerStatus(projectRef: string): Promise<ContainerStatusResult> {
    try {
      console.log(`[Studio Integration] Getting container status for project ${projectRef}`)

      // Get health status
      const healthStatus = await this.containerClient.getContainerHealth(projectRef)

      // Get performance metrics
      const metrics = await this.containerClient.getContainerMetrics(projectRef)

      // Get monitoring status
      const monitoringStatus = await this.healthMonitor.getMonitoringStatus(projectRef)

      return {
        success: true,
        projectRef,
        timestamp: new Date().toISOString(),
        health: healthStatus,
        metrics,
        monitoring: monitoringStatus,
        overallStatus: this.determineOverallStatus(healthStatus, metrics, monitoringStatus)
      }

    } catch (error) {
      console.error(`[Studio Integration] Failed to get container status for project ${projectRef}:`, error)

      return {
        success: false,
        projectRef,
        timestamp: new Date().toISOString(),
        health: null,
        metrics: null,
        monitoring: null,
        overallStatus: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Validate configuration before applying
   * Requirements: 1.1, 2.1
   */
  private async validateConfiguration(config: EnhancedPostgRESTProjectConfig): Promise<ValidationResult> {
    const errors: string[] = []
    const warnings: string[] = []

    // Validate query timeout
    if (config.queryTimeout < 1000 || config.queryTimeout > 300000) {
      errors.push('Query timeout must be between 1000ms and 300000ms')
    }

    // Validate connection pool size
    if (config.connectionPoolSize && (config.connectionPoolSize < 1 || config.connectionPoolSize > 1000)) {
      errors.push('Connection pool size must be between 1 and 1000')
    }

    // Validate feature combinations
    if (config.enableNestedResources && !config.enableAdvancedJSON) {
      warnings.push('Nested resources work better with advanced JSON operations enabled')
    }

    if (config.enableBulkOperations && !config.enableTransactions) {
      warnings.push('Bulk operations are safer with transactions enabled')
    }

    if (config.enableCaching && !config.enablePerformanceMonitoring) {
      warnings.push('Performance monitoring is recommended when caching is enabled')
    }

    // Validate database connection details
    if (!config.connectionDetails.host || !config.connectionDetails.database) {
      errors.push('Database connection details are incomplete')
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    }
  }

  /**
   * Get list of enabled features from configuration
   */
  private getEnabledFeatures(config: EnhancedPostgRESTProjectConfig): string[] {
    const features: string[] = []

    if (config.enableRPCFunctions) features.push('RPC Functions')
    if (config.enableDatabaseViews) features.push('Database Views')
    if (config.enableAdvancedJSON) features.push('Advanced JSON')
    if (config.enableFullTextSearch) features.push('Full-Text Search')
    if (config.enableAggregateQueries) features.push('Aggregate Queries')
    if (config.enableBulkOperations) features.push('Bulk Operations')
    if (config.enableNestedResources) features.push('Nested Resources')
    if (config.enableTransactions) features.push('Transactions')
    if (config.enableArrayOperations) features.push('Array Operations')
    if (config.enableContentNegotiation) features.push('Content Negotiation')

    return features
  }

  /**
   * Get list of features that changed between configurations
   */
  private getChangedFeatures(
    oldConfig: EnhancedPostgRESTProjectConfig,
    newConfig: EnhancedPostgRESTProjectConfig
  ): FeatureChange[] {
    const changes: FeatureChange[] = []

    const featureMap = {
      enableRPCFunctions: 'RPC Functions',
      enableDatabaseViews: 'Database Views',
      enableAdvancedJSON: 'Advanced JSON',
      enableFullTextSearch: 'Full-Text Search',
      enableAggregateQueries: 'Aggregate Queries',
      enableBulkOperations: 'Bulk Operations',
      enableNestedResources: 'Nested Resources',
      enableTransactions: 'Transactions',
      enableArrayOperations: 'Array Operations',
      enableContentNegotiation: 'Content Negotiation'
    }

    for (const [key, label] of Object.entries(featureMap)) {
      const oldValue = (oldConfig as any)[key]
      const newValue = (newConfig as any)[key]

      if (oldValue !== newValue) {
        changes.push({
          feature: label,
          previousState: oldValue,
          newState: newValue,
          action: newValue ? 'enabled' : 'disabled'
        })
      }
    }

    return changes
  }

  /**
   * Determine overall container status from health and metrics
   */
  private determineOverallStatus(
    health: any,
    metrics: any,
    monitoring: any
  ): 'healthy' | 'degraded' | 'unhealthy' | 'error' {
    if (!health || !health.healthy) return 'unhealthy'
    if (!metrics) return 'error'

    // Check for performance issues
    if (metrics.metrics.errorRate > 5) return 'degraded'
    if (metrics.metrics.averageResponseTime > 1000) return 'degraded'
    if (metrics.metrics.cpuUsage > 90) return 'degraded'
    if (metrics.metrics.memoryUsage > 0.9) return 'degraded'

    return 'healthy'
  }
}

// Type definitions
export interface ContainerInitializationResult {
  success: boolean
  projectRef: string
  message: string
  timestamp: string
  containerStatus: 'healthy' | 'unhealthy'
  featuresEnabled: string[]
  error?: string
}

export interface ContainerUpdateResult {
  success: boolean
  projectRef: string
  message: string
  timestamp: string
  configurationApplied: EnhancedPostgRESTProjectConfig | null
  featuresChanged: FeatureChange[]
  containerResponse?: ContainerConfigurationResponse
  error?: string
}

export interface ContainerStatusResult {
  success: boolean
  projectRef: string
  timestamp: string
  health: any
  metrics: any
  monitoring: any
  overallStatus: 'healthy' | 'degraded' | 'unhealthy' | 'error'
  error?: string
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface FeatureChange {
  feature: string
  previousState: boolean
  newState: boolean
  action: 'enabled' | 'disabled'
}

/**
 * Factory function to get the integration service
 */
export function getStudioContainerIntegrationService(): StudioContainerIntegrationService {
  return StudioContainerIntegrationService.getInstance()
}