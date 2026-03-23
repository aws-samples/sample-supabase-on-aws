/**
 * Pooling Service Detection and Adaptation
 * 
 * This module provides automatic detection of available pooling services
 * and adapts the UI and API calls accordingly. It supports both PgBouncer
 * (platform) and Supavisor (self-hosted) with graceful fallbacks.
 */

import { IS_PLATFORM } from 'lib/constants'

export type PoolingService = 'pgbouncer' | 'supavisor'
export type Environment = 'platform' | 'self-hosted'

export interface PoolingServiceCapabilities {
  service: PoolingService
  environment: Environment
  isAvailable: boolean
  isHealthy: boolean
  version?: string
  features: {
    configurationUpdate: boolean
    statisticsMonitoring: boolean
    healthChecks: boolean
    containerManagement: boolean
  }
}

export interface PoolingServiceDetectionResult {
  primary: PoolingServiceCapabilities
  fallback?: PoolingServiceCapabilities
  recommendedService: PoolingService
  environment: Environment
}

/**
 * Detects available pooling services and their capabilities
 */
export class PoolingServiceDetector {
  private static cache = new Map<string, PoolingServiceDetectionResult>()
  private static cacheTimeout = 5 * 60 * 1000 // 5 minutes

  /**
   * Detects available pooling services for a project
   */
  static async detectServices(projectRef: string): Promise<PoolingServiceDetectionResult> {
    const cacheKey = `${projectRef}-detection`
    const cached = this.cache.get(cacheKey)
    
    if (cached && Date.now() - (cached as any).timestamp < this.cacheTimeout) {
      return cached
    }

    const environment: Environment = IS_PLATFORM ? 'platform' : 'self-hosted'
    
    let result: PoolingServiceDetectionResult

    if (environment === 'platform') {
      result = await this.detectPlatformServices(projectRef)
    } else {
      result = await this.detectSelfHostedServices(projectRef)
    }

    // Cache the result with timestamp
    ;(result as any).timestamp = Date.now()
    this.cache.set(cacheKey, result)

    return result
  }

  /**
   * Detects services in platform environment
   */
  private static async detectPlatformServices(projectRef: string): Promise<PoolingServiceDetectionResult> {
    const pgbouncerCapabilities = await this.checkPgbouncerCapabilities(projectRef)
    
    return {
      primary: pgbouncerCapabilities,
      recommendedService: 'pgbouncer',
      environment: 'platform'
    }
  }

  /**
   * Detects services in self-hosted environment
   */
  private static async detectSelfHostedServices(projectRef: string): Promise<PoolingServiceDetectionResult> {
    const supavisorCapabilities = await this.checkSupavisorCapabilities(projectRef)
    
    // Check if PgBouncer is also available as fallback (hybrid setup)
    let pgbouncerFallback: PoolingServiceCapabilities | undefined
    try {
      pgbouncerFallback = await this.checkPgbouncerCapabilities(projectRef)
      if (!pgbouncerFallback.isAvailable) {
        pgbouncerFallback = undefined
      }
    } catch {
      // PgBouncer not available, which is expected in pure self-hosted
    }

    return {
      primary: supavisorCapabilities,
      fallback: pgbouncerFallback,
      recommendedService: supavisorCapabilities.isAvailable ? 'supavisor' : 'pgbouncer',
      environment: 'self-hosted'
    }
  }

  /**
   * Checks PgBouncer capabilities
   */
  private static async checkPgbouncerCapabilities(projectRef: string): Promise<PoolingServiceCapabilities> {
    try {
      const response = await fetch(`/api/platform/projects/${projectRef}/pgbouncer-config`)
      const isHealthy = response.ok
      
      return {
        service: 'pgbouncer',
        environment: 'platform',
        isAvailable: true,
        isHealthy,
        features: {
          configurationUpdate: true,
          statisticsMonitoring: true,
          healthChecks: true,
          containerManagement: false
        }
      }
    } catch (error) {
      return {
        service: 'pgbouncer',
        environment: 'platform',
        isAvailable: false,
        isHealthy: false,
        features: {
          configurationUpdate: false,
          statisticsMonitoring: false,
          healthChecks: false,
          containerManagement: false
        }
      }
    }
  }

  /**
   * Checks Supavisor capabilities
   */
  private static async checkSupavisorCapabilities(projectRef: string): Promise<PoolingServiceCapabilities> {
    try {
      // Check configuration endpoint
      const configResponse = await fetch(`/api/platform/projects/${projectRef}/supavisor-config`)
      const configAvailable = configResponse.ok

      // Check health endpoint
      let healthAvailable = false
      let version: string | undefined
      try {
        const healthResponse = await fetch(`/api/platform/projects/${projectRef}/supavisor-health`)
        if (healthResponse.ok) {
          const healthData = await healthResponse.json()
          healthAvailable = true
          version = healthData.version
        }
      } catch {
        // Health endpoint not available
      }

      // Check container management
      let containerManagement = false
      try {
        const containerResponse = await fetch(`/api/platform/projects/${projectRef}/docker-containers`)
        containerManagement = containerResponse.ok
      } catch {
        // Container management not available
      }

      const isAvailable = configAvailable
      const isHealthy = configAvailable && healthAvailable

      return {
        service: 'supavisor',
        environment: 'self-hosted',
        isAvailable,
        isHealthy,
        version,
        features: {
          configurationUpdate: configAvailable,
          statisticsMonitoring: healthAvailable,
          healthChecks: healthAvailable,
          containerManagement
        }
      }
    } catch (error) {
      return {
        service: 'supavisor',
        environment: 'self-hosted',
        isAvailable: false,
        isHealthy: false,
        features: {
          configurationUpdate: false,
          statisticsMonitoring: false,
          healthChecks: false,
          containerManagement: false
        }
      }
    }
  }

  /**
   * Clears the detection cache for a project
   */
  static clearCache(projectRef?: string) {
    if (projectRef) {
      this.cache.delete(`${projectRef}-detection`)
    } else {
      this.cache.clear()
    }
  }

  /**
   * Gets the recommended service configuration based on detection results
   */
  static getRecommendedConfiguration(detection: PoolingServiceDetectionResult) {
    const { primary, fallback, recommendedService } = detection

    if (primary.isAvailable && primary.isHealthy) {
      return {
        service: primary.service,
        capabilities: primary,
        reason: 'Primary service is available and healthy'
      }
    }

    if (fallback?.isAvailable && fallback.isHealthy) {
      return {
        service: fallback.service,
        capabilities: fallback,
        reason: 'Using fallback service as primary is unavailable'
      }
    }

    if (primary.isAvailable) {
      return {
        service: primary.service,
        capabilities: primary,
        reason: 'Primary service is available but may have health issues'
      }
    }

    // Return the recommended service even if not available for error handling
    return {
      service: recommendedService,
      capabilities: primary,
      reason: 'No services are currently available'
    }
  }
}

/**
 * Service-specific configuration adapters
 */
export class PoolingServiceAdapter {
  /**
   * Adapts configuration based on service capabilities
   */
  static adaptConfiguration(
    service: PoolingService,
    capabilities: PoolingServiceCapabilities,
    baseConfig: any
  ) {
    if (service === 'pgbouncer') {
      return this.adaptPgbouncerConfiguration(baseConfig, capabilities)
    } else {
      return this.adaptSupavisorConfiguration(baseConfig, capabilities)
    }
  }

  /**
   * Adapts configuration for PgBouncer
   */
  private static adaptPgbouncerConfiguration(config: any, capabilities: PoolingServiceCapabilities) {
    return {
      ...config,
      // PgBouncer specific adaptations
      poolMode: 'transaction', // PgBouncer typically uses transaction mode
      maxClientConnections: config.maxClientConnections || 200,
      // Disable features not supported by PgBouncer
      containerManagement: false,
      environmentVariables: false
    }
  }

  /**
   * Adapts configuration for Supavisor
   */
  private static adaptSupavisorConfiguration(config: any, capabilities: PoolingServiceCapabilities) {
    return {
      ...config,
      // Supavisor specific adaptations
      poolMode: config.poolMode || 'transaction',
      maxClientConnections: config.maxClientConnections || 200,
      // Enable Supavisor-specific features if available
      containerManagement: capabilities.features.containerManagement,
      environmentVariables: true,
      healthMonitoring: capabilities.features.healthChecks
    }
  }

  /**
   * Gets UI configuration based on service and capabilities
   */
  static getUIConfiguration(
    service: PoolingService,
    capabilities: PoolingServiceCapabilities
  ) {
    const baseConfig = {
      serviceName: service === 'pgbouncer' ? 'PgBouncer' : 'Supavisor',
      badgeVariant: service === 'supavisor' ? 'default' : 'secondary',
      showHealthStatus: capabilities.features.healthChecks,
      showStatistics: capabilities.features.statisticsMonitoring,
      allowConfigurationUpdate: capabilities.features.configurationUpdate,
      showContainerManagement: capabilities.features.containerManagement
    }

    if (service === 'pgbouncer') {
      return {
        ...baseConfig,
        description: 'Platform connection pooling service',
        documentationUrl: '/guides/database/connecting-to-postgres#connection-pooler',
        features: ['Connection pooling', 'Load balancing', 'Connection reuse']
      }
    } else {
      return {
        ...baseConfig,
        description: 'Self-hosted connection pooling service',
        documentationUrl: '/guides/database/connection-management#configuring-supavisors-pool-size',
        features: [
          'Connection pooling',
          'Multi-tenant support',
          'Real-time monitoring',
          ...(capabilities.features.containerManagement ? ['Container management'] : [])
        ]
      }
    }
  }
}