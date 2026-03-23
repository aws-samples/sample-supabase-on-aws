/**
 * Edge Functions Docker Integration Service
 * 
 * Provides Docker container management, health monitoring, and reconnection logic
 * specifically for the Edge Functions service in self-hosted environments.
 */

import { DockerContainerService, type ContainerStatus, type HealthCheckResult } from './api/self-hosted/docker-container-service'
import { serviceDiscovery, type ServiceEndpoint } from './service-discovery'

export interface EdgeFunctionsDockerStatus {
  containerRunning: boolean
  serviceHealthy: boolean
  endpoint?: string
  containerInfo?: ContainerStatus
  healthInfo?: HealthCheckResult
  lastChecked: Date
  reconnectionAttempts: number
}

export interface EdgeFunctionsDockerConfig {
  containerNames: string[]
  healthCheckInterval: number
  maxReconnectionAttempts: number
  reconnectionDelay: number
  healthTimeout: number
}

export class EdgeFunctionsDockerIntegration {
  private dockerService: DockerContainerService
  private config: EdgeFunctionsDockerConfig
  private status: EdgeFunctionsDockerStatus
  private healthCheckTimer?: NodeJS.Timeout
  private reconnectionTimer?: NodeJS.Timeout
  private listeners: Array<(status: EdgeFunctionsDockerStatus) => void> = []

  constructor(config: Partial<EdgeFunctionsDockerConfig> = {}) {
    this.dockerService = new DockerContainerService()
    this.config = {
      containerNames: config.containerNames || ['supabase-edge-functions', 'functions', 'edge-functions'],
      healthCheckInterval: config.healthCheckInterval || 30000, // 30 seconds
      maxReconnectionAttempts: config.maxReconnectionAttempts || 5,
      reconnectionDelay: config.reconnectionDelay || 5000, // 5 seconds
      healthTimeout: config.healthTimeout || 10000, // 10 seconds
    }
    
    this.status = {
      containerRunning: false,
      serviceHealthy: false,
      lastChecked: new Date(),
      reconnectionAttempts: 0,
    }
  }

  /**
   * Start monitoring Edge Functions Docker container
   */
  async startMonitoring(): Promise<void> {
    console.log('[EdgeFunctionsDocker] Starting monitoring...')
    
    // Initial check
    await this.checkStatus()
    
    // Start periodic health checks
    this.healthCheckTimer = setInterval(async () => {
      await this.checkStatus()
    }, this.config.healthCheckInterval)
    
    console.log(`[EdgeFunctionsDocker] Monitoring started with ${this.config.healthCheckInterval}ms interval`)
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    console.log('[EdgeFunctionsDocker] Stopping monitoring...')
    
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = undefined
    }
    
    if (this.reconnectionTimer) {
      clearTimeout(this.reconnectionTimer)
      this.reconnectionTimer = undefined
    }
    
    this.listeners = []
  }

  /**
   * Check current status of Edge Functions container and service
   */
  async checkStatus(): Promise<EdgeFunctionsDockerStatus> {
    const startTime = Date.now()
    
    try {
      // Find the Edge Functions container
      const containerInfo = await this.findEdgeFunctionsContainer()
      
      if (!containerInfo) {
        this.updateStatus({
          containerRunning: false,
          serviceHealthy: false,
          containerInfo: undefined,
          healthInfo: undefined,
          lastChecked: new Date(),
        })
        
        // Attempt to start container if it's not running
        await this.attemptContainerStart()
        return this.status
      }

      // Container exists, check if it's running
      const isRunning = containerInfo.status === 'running'
      
      if (!isRunning) {
        this.updateStatus({
          containerRunning: false,
          serviceHealthy: false,
          containerInfo,
          healthInfo: undefined,
          lastChecked: new Date(),
        })
        
        // Attempt to start the container
        await this.attemptContainerStart()
        return this.status
      }

      // Container is running, check service health
      const healthInfo = await this.dockerService.getContainerHealth(containerInfo.name)
      const serviceHealthy = healthInfo.healthy
      
      // Get service endpoint
      let endpoint: string | undefined
      if (serviceHealthy) {
        const serviceEndpoint = await serviceDiscovery.discoverEdgeFunctions()
        endpoint = serviceEndpoint.healthy ? serviceEndpoint.url : undefined
      }

      this.updateStatus({
        containerRunning: true,
        serviceHealthy,
        endpoint,
        containerInfo,
        healthInfo,
        lastChecked: new Date(),
        reconnectionAttempts: serviceHealthy ? 0 : this.status.reconnectionAttempts,
      })

      // If service is unhealthy, attempt reconnection
      if (!serviceHealthy) {
        await this.attemptReconnection()
      }

    } catch (error) {
      console.error('[EdgeFunctionsDocker] Status check failed:', error)
      
      this.updateStatus({
        containerRunning: false,
        serviceHealthy: false,
        containerInfo: undefined,
        healthInfo: {
          healthy: false,
          message: `Status check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          lastChecked: new Date().toISOString(),
        },
        lastChecked: new Date(),
      })
    }

    const checkDuration = Date.now() - startTime
    console.log(`[EdgeFunctionsDocker] Status check completed in ${checkDuration}ms:`, {
      running: this.status.containerRunning,
      healthy: this.status.serviceHealthy,
      endpoint: this.status.endpoint,
    })

    return this.status
  }

  /**
   * Find Edge Functions container among possible names
   */
  private async findEdgeFunctionsContainer(): Promise<ContainerStatus | null> {
    for (const containerName of this.config.containerNames) {
      try {
        const status = await this.dockerService.getContainerStatus(containerName)
        
        // If we found a container (even if stopped), return it
        if (status.name === containerName) {
          return status
        }
      } catch (error) {
        console.debug(`[EdgeFunctionsDocker] Container ${containerName} not found:`, error)
      }
    }
    
    return null
  }

  /**
   * Attempt to start the Edge Functions container
   */
  private async attemptContainerStart(): Promise<void> {
    if (this.status.reconnectionAttempts >= this.config.maxReconnectionAttempts) {
      console.warn('[EdgeFunctionsDocker] Max reconnection attempts reached, skipping container start')
      return
    }

    for (const containerName of this.config.containerNames) {
      try {
        console.log(`[EdgeFunctionsDocker] Attempting to start container: ${containerName}`)
        
        const result = await this.dockerService.startContainer(containerName)
        
        if (result.success) {
          console.log(`[EdgeFunctionsDocker] Successfully started container: ${containerName}`)
          this.status.reconnectionAttempts = 0
          
          // Wait a moment for the service to initialize
          await this.sleep(2000)
          
          // Recheck status
          setTimeout(() => this.checkStatus(), 1000)
          return
        } else {
          console.warn(`[EdgeFunctionsDocker] Failed to start container ${containerName}: ${result.message}`)
        }
      } catch (error) {
        console.error(`[EdgeFunctionsDocker] Error starting container ${containerName}:`, error)
      }
    }
    
    this.status.reconnectionAttempts++
  }

  /**
   * Attempt to reconnect to Edge Functions service
   */
  private async attemptReconnection(): Promise<void> {
    if (this.status.reconnectionAttempts >= this.config.maxReconnectionAttempts) {
      console.warn('[EdgeFunctionsDocker] Max reconnection attempts reached')
      return
    }

    if (this.reconnectionTimer) {
      return // Reconnection already in progress
    }

    this.status.reconnectionAttempts++
    console.log(`[EdgeFunctionsDocker] Attempting reconnection (${this.status.reconnectionAttempts}/${this.config.maxReconnectionAttempts})`)

    this.reconnectionTimer = setTimeout(async () => {
      this.reconnectionTimer = undefined
      
      try {
        // Try restarting the container
        const containerInfo = this.status.containerInfo
        if (containerInfo) {
          console.log(`[EdgeFunctionsDocker] Restarting container: ${containerInfo.name}`)
          
          const result = await this.dockerService.restartContainer(containerInfo.name)
          
          if (result.success) {
            console.log(`[EdgeFunctionsDocker] Container restart successful: ${containerInfo.name}`)
            
            // Wait for service to initialize
            await this.sleep(3000)
            
            // Clear service discovery cache to force re-discovery
            serviceDiscovery.clearCache()
            
            // Recheck status
            setTimeout(() => this.checkStatus(), 1000)
          } else {
            console.error(`[EdgeFunctionsDocker] Container restart failed: ${result.message}`)
          }
        }
      } catch (error) {
        console.error('[EdgeFunctionsDocker] Reconnection attempt failed:', error)
      }
    }, this.config.reconnectionDelay)
  }

  /**
   * Update status and notify listeners
   */
  private updateStatus(updates: Partial<EdgeFunctionsDockerStatus>): void {
    const previousStatus = { ...this.status }
    this.status = { ...this.status, ...updates }
    
    // Notify listeners if status changed significantly
    const significantChange = 
      previousStatus.containerRunning !== this.status.containerRunning ||
      previousStatus.serviceHealthy !== this.status.serviceHealthy ||
      previousStatus.endpoint !== this.status.endpoint
    
    if (significantChange) {
      console.log('[EdgeFunctionsDocker] Status changed:', {
        from: {
          running: previousStatus.containerRunning,
          healthy: previousStatus.serviceHealthy,
          endpoint: previousStatus.endpoint,
        },
        to: {
          running: this.status.containerRunning,
          healthy: this.status.serviceHealthy,
          endpoint: this.status.endpoint,
        },
      })
      
      this.notifyListeners()
    }
  }

  /**
   * Notify all status listeners
   */
  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.status)
      } catch (error) {
        console.error('[EdgeFunctionsDocker] Error notifying listener:', error)
      }
    }
  }

  /**
   * Add status change listener
   */
  onStatusChange(listener: (status: EdgeFunctionsDockerStatus) => void): () => void {
    this.listeners.push(listener)
    
    // Return unsubscribe function
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index > -1) {
        this.listeners.splice(index, 1)
      }
    }
  }

  /**
   * Get current status
   */
  getStatus(): EdgeFunctionsDockerStatus {
    return { ...this.status }
  }

  /**
   * Force a status check
   */
  async forceStatusCheck(): Promise<EdgeFunctionsDockerStatus> {
    return await this.checkStatus()
  }

  /**
   * Get diagnostic information
   */
  getDiagnosticInfo(): Record<string, any> {
    return {
      config: this.config,
      status: this.status,
      environment: {
        EDGE_FUNCTIONS_URL: process.env.EDGE_FUNCTIONS_URL,
        EDGE_FUNCTIONS_PORT: process.env.EDGE_FUNCTIONS_PORT,
        NODE_ENV: process.env.NODE_ENV,
      },
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Manually restart Edge Functions container
   */
  async restartContainer(): Promise<{ success: boolean; message: string }> {
    const containerInfo = await this.findEdgeFunctionsContainer()
    
    if (!containerInfo) {
      return {
        success: false,
        message: 'Edge Functions container not found'
      }
    }

    console.log(`[EdgeFunctionsDocker] Manual restart requested for: ${containerInfo.name}`)
    
    const result = await this.dockerService.restartContainer(containerInfo.name)
    
    if (result.success) {
      // Reset reconnection attempts on successful manual restart
      this.status.reconnectionAttempts = 0
      
      // Clear service discovery cache
      serviceDiscovery.clearCache()
      
      // Schedule status recheck
      setTimeout(() => this.checkStatus(), 2000)
    }
    
    return result
  }

  /**
   * Get container logs
   */
  async getContainerLogs(lines: number = 100): Promise<string[]> {
    const containerInfo = await this.findEdgeFunctionsContainer()
    
    if (!containerInfo) {
      return ['Edge Functions container not found']
    }

    return await this.dockerService.getContainerLogs(containerInfo.name, lines)
  }
}

// Singleton instance for global use
export const edgeFunctionsDocker = new EdgeFunctionsDockerIntegration()

/**
 * Initialize Edge Functions Docker integration
 */
export async function initializeEdgeFunctionsDocker(): Promise<void> {
  console.log('[EdgeFunctionsDocker] Initializing Docker integration...')
  
  try {
    await edgeFunctionsDocker.startMonitoring()
    console.log('[EdgeFunctionsDocker] Docker integration initialized successfully')
  } catch (error) {
    console.error('[EdgeFunctionsDocker] Failed to initialize Docker integration:', error)
  }
}

/**
 * Check if Edge Functions Docker integration is healthy
 */
export async function isEdgeFunctionsDockerHealthy(): Promise<boolean> {
  const status = await edgeFunctionsDocker.checkStatus()
  return status.containerRunning && status.serviceHealthy
}