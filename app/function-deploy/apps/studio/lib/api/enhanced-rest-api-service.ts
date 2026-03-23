import { NextApiRequest, NextApiResponse } from 'next'
import { ProjectIsolationContext } from './secure-api-wrapper'
import { DataApiConfigResponse } from './data-api-config-data-access'
import { getEnhancedPostgRESTConfigManager } from './enhanced-postgrest-config-manager'
import { getSupabaseRestContainerClient } from './supabase-rest-container-client'
import { getContainerHealthMonitor } from './container-health-monitor'
import { getContainerLoggingService } from './container-logging-service'
import { createEnhancedProjectPostgRESTEngine } from './enhanced-project-postgrest-engine'
import { getEnhancedErrorHandler, extractRequestId } from './enhanced-error-handler'

/**
 * Enhanced REST API Service
 * Main service that orchestrates all enhanced REST API functionality
 * Requirements: 1.1, 2.1, 13.1
 */
export class EnhancedRestApiService {
  private static instance: EnhancedRestApiService
  private configManager = getEnhancedPostgRESTConfigManager()
  private containerClient = getSupabaseRestContainerClient()
  private healthMonitor = getContainerHealthMonitor()
  private loggingService = getContainerLoggingService()
  private isInitialized = false

  private constructor() {}

  static getInstance(): EnhancedRestApiService {
    if (!EnhancedRestApiService.instance) {
      EnhancedRestApiService.instance = new EnhancedRestApiService()
    }
    return EnhancedRestApiService.instance
  }

  /**
   * Initialize the enhanced REST API service
   * Requirements: 1.1, 2.1, 13.1
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    try {
      console.log('Initializing Enhanced REST API Service...')

      // Start health monitoring
      this.healthMonitor.startMonitoring()

      // Log initialization
      this.loggingService.info('system', 'Enhanced REST API Service initialized', {
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0'
      }, 'enhanced-rest-api-service')

      this.isInitialized = true
      console.log('Enhanced REST API Service initialized successfully')
    } catch (error) {
      console.error('Failed to initialize Enhanced REST API Service:', error)
      this.loggingService.error('system', 'Failed to initialize Enhanced REST API Service', {
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 'enhanced-rest-api-service')
      throw error
    }
  }

  /**
   * Handle enhanced REST API request
   * Requirements: 1.1, 2.1, 12.1, 12.2, 12.3, 12.4, 12.5
   */
  async handleRequest(
    req: NextApiRequest,
    res: NextApiResponse,
    context: ProjectIsolationContext,
    config: DataApiConfigResponse,
    resourcePath: string
  ): Promise<void> {
    const startTime = Date.now()
    const { projectRef } = context
    const requestId = extractRequestId(req)
    const errorHandler = getEnhancedErrorHandler()

    try {
      // Ensure service is initialized
      await this.initialize()

      // Log request
      this.loggingService.logRequest(
        projectRef,
        req.method || 'GET',
        resourcePath,
        0, // Will be updated later
        0, // Will be updated later
        req.headers['user-agent'],
        context.userId
      )

      // Create enhanced PostgREST engine
      const engine = createEnhancedProjectPostgRESTEngine(context, config)

      // Handle the request with enhanced error handling
      await engine.handleEnhancedRequest(req, res, context, config, resourcePath)

      // Calculate response time
      const responseTime = Date.now() - startTime

      // Log successful request
      this.loggingService.logRequest(
        projectRef,
        req.method || 'GET',
        resourcePath,
        res.statusCode,
        responseTime,
        req.headers['user-agent'],
        context.userId
      )

      // Log performance metrics
      this.loggingService.logPerformance(projectRef, 'api-request', {
        executionTime: responseTime
      })

    } catch (error) {
      const responseTime = Date.now() - startTime

      // Log error
      this.loggingService.error(projectRef, 'Request failed', {
        method: req.method,
        path: resourcePath,
        responseTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      }, 'enhanced-rest-api-service')

      // Update request log with error status
      this.loggingService.logRequest(
        projectRef,
        req.method || 'GET',
        resourcePath,
        res.statusCode || 500,
        responseTime,
        req.headers['user-agent'],
        context.userId
      )

      // Use enhanced error handler for consistent error responses
      if (!res.headersSent) {
        errorHandler.handleGenericError(error, res, requestId, 'Enhanced REST API')
      }
    }
  }

  /**
   * Get service health status
   * Requirements: 13.1
   */
  async getServiceHealth(): Promise<ServiceHealthStatus> {
    try {
      const healthSummary = this.healthMonitor.getHealthSummary()
      const logSummary = this.loggingService.getLogSummary()
      const monitoringStatus = this.healthMonitor.getMonitoringStatus()

      return {
        healthy: healthSummary.unhealthyProjects === 0,
        timestamp: new Date(),
        service: {
          initialized: this.isInitialized,
          monitoring: monitoringStatus.isRunning,
          lastHealthCheck: monitoringStatus.lastCheck
        },
        projects: {
          total: healthSummary.totalProjects,
          healthy: healthSummary.healthyProjects,
          unhealthy: healthSummary.unhealthyProjects
        },
        logs: {
          totalLogs: logSummary.totalLogs,
          errorCount: logSummary.logsByLevel.error,
          warningCount: logSummary.logsByLevel.warn
        },
        alerts: this.healthMonitor.getHealthAlerts().length
      }
    } catch (error) {
      return {
        healthy: false,
        timestamp: new Date(),
        service: {
          initialized: this.isInitialized,
          monitoring: false,
          lastHealthCheck: null
        },
        projects: {
          total: 0,
          healthy: 0,
          unhealthy: 0
        },
        logs: {
          totalLogs: 0,
          errorCount: 0,
          warningCount: 0
        },
        alerts: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Get project status
   * Requirements: 13.1
   */
  async getProjectStatus(projectRef: string): Promise<ProjectStatus> {
    try {
      // Get health status
      const healthStatus = this.healthMonitor.getCurrentHealthStatus(projectRef)
      
      // Get log statistics
      const logStats = this.loggingService.getLogStatistics(projectRef, new Date(Date.now() - 24 * 60 * 60 * 1000)) // Last 24 hours
      
      // Get configuration
      const configs = this.configManager.getAllEnhancedProjectConfigs()
      const config = configs.get(projectRef)

      return {
        projectRef,
        healthy: healthStatus?.overallHealth.healthy || false,
        lastCheck: healthStatus?.timestamp || null,
        configuration: config ? {
          enabledFeatures: {
            rpcFunctions: config.enableRPCFunctions,
            databaseViews: config.enableDatabaseViews,
            advancedJSON: config.enableAdvancedJSON,
            fullTextSearch: config.enableFullTextSearch,
            advancedFiltering: config.enableAdvancedFiltering,
            aggregateQueries: config.enableAggregateQueries,
            bulkOperations: config.enableBulkOperations,
            nestedResources: config.enableNestedResources,
            transactions: config.enableTransactions,
            arrayOperations: config.enableArrayOperations,
            contentNegotiation: config.enableContentNegotiation
          },
          performance: {
            queryTimeout: config.queryTimeout,
            connectionPoolSize: config.connectionPoolSize,
            enableQueryLogging: config.enableQueryLogging,
            enablePerformanceMonitoring: config.enablePerformanceMonitoring,
            enableCaching: config.enableCaching
          }
        } : null,
        logs: {
          totalLogs: logStats.totalLogs,
          errorCount: logStats.logsByLevel.error,
          warningCount: logStats.logsByLevel.warn,
          lastLogTime: logStats.timeRange.newest
        },
        issues: healthStatus?.overallHealth.issues || []
      }
    } catch (error) {
      return {
        projectRef,
        healthy: false,
        lastCheck: null,
        configuration: null,
        logs: {
          totalLogs: 0,
          errorCount: 0,
          warningCount: 0,
          lastLogTime: null
        },
        issues: [error instanceof Error ? error.message : 'Unknown error']
      }
    }
  }

  /**
   * Update project configuration
   * Requirements: 1.1, 2.1
   */
  async updateProjectConfiguration(
    projectRef: string,
    updates: Partial<{
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
      queryTimeout: number
      connectionPoolSize: number
      enableQueryLogging: boolean
      enablePerformanceMonitoring: boolean
      enableCaching: boolean
    }>
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Update configuration
      await this.configManager.updateProjectConfig(projectRef, updates)

      // Get updated configuration
      const configs = this.configManager.getAllEnhancedProjectConfigs()
      const updatedConfig = configs.get(projectRef)

      if (updatedConfig) {
        // Update container configuration
        const containerResponse = await this.containerClient.updateContainerConfiguration(
          projectRef,
          updatedConfig
        )

        if (!containerResponse.success) {
          throw new Error(`Container configuration update failed: ${containerResponse.message}`)
        }
      }

      // Log configuration update
      this.loggingService.info(projectRef, 'Configuration updated', {
        updates,
        timestamp: new Date().toISOString()
      }, 'enhanced-rest-api-service')

      return {
        success: true,
        message: 'Configuration updated successfully'
      }
    } catch (error) {
      this.loggingService.error(projectRef, 'Configuration update failed', {
        updates,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 'enhanced-rest-api-service')

      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Cleanup resources
   * Requirements: 13.1
   */
  async cleanup(): Promise<void> {
    try {
      console.log('Cleaning up Enhanced REST API Service...')

      // Stop health monitoring
      this.healthMonitor.stopMonitoring()

      // Clear configurations
      this.configManager.cleanup()

      // Log cleanup
      this.loggingService.info('system', 'Enhanced REST API Service cleaned up', {
        timestamp: new Date().toISOString()
      }, 'enhanced-rest-api-service')

      this.isInitialized = false
      console.log('Enhanced REST API Service cleaned up successfully')
    } catch (error) {
      console.error('Error during Enhanced REST API Service cleanup:', error)
      throw error
    }
  }
}

/**
 * Service health status interface
 * Requirements: 13.1
 */
export interface ServiceHealthStatus {
  healthy: boolean
  timestamp: Date
  service: {
    initialized: boolean
    monitoring: boolean
    lastHealthCheck: Date | null
  }
  projects: {
    total: number
    healthy: number
    unhealthy: number
  }
  logs: {
    totalLogs: number
    errorCount: number
    warningCount: number
  }
  alerts: number
  error?: string
}

/**
 * Project status interface
 * Requirements: 13.1
 */
export interface ProjectStatus {
  projectRef: string
  healthy: boolean
  lastCheck: Date | null
  configuration: {
    enabledFeatures: {
      rpcFunctions: boolean
      databaseViews: boolean
      advancedJSON: boolean
      fullTextSearch: boolean
      advancedFiltering: boolean
      aggregateQueries: boolean
      bulkOperations: boolean
      nestedResources: boolean
      transactions: boolean
      arrayOperations: boolean
      contentNegotiation: boolean
    }
    performance: {
      queryTimeout: number
      connectionPoolSize: number
      enableQueryLogging: boolean
      enablePerformanceMonitoring: boolean
      enableCaching: boolean
    }
  } | null
  logs: {
    totalLogs: number
    errorCount: number
    warningCount: number
    lastLogTime: Date | null
  }
  issues: string[]
}

/**
 * Factory function to get the enhanced REST API service
 */
export function getEnhancedRestApiService(): EnhancedRestApiService {
  return EnhancedRestApiService.getInstance()
}