import { getEnhancedPostgRESTConfigManager, ProjectHealthStatus } from './enhanced-postgrest-config-manager'
import { getSupabaseRestContainerClient, ContainerHealthResponse } from './supabase-rest-container-client'
import { DockerContainerService } from './self-hosted/docker-container-service'

/**
 * Container Health Monitor
 * Monitors the health of the enhanced supabase-rest container and related services
 * Requirements: 13.1
 */
export class ContainerHealthMonitor {
  private static instance: ContainerHealthMonitor
  private monitoringInterval: NodeJS.Timeout | null = null
  private dockerService: DockerContainerService
  private containerClient = getSupabaseRestContainerClient()
  private configManager = getEnhancedPostgRESTConfigManager()
  
  private healthHistory: Map<string, HealthHistoryEntry[]> = new Map()
  private readonly MAX_HISTORY_ENTRIES = 100
  private readonly MONITORING_INTERVAL = 30000 // 30 seconds

  private constructor() {
    this.dockerService = new DockerContainerService()
  }

  static getInstance(): ContainerHealthMonitor {
    if (!ContainerHealthMonitor.instance) {
      ContainerHealthMonitor.instance = new ContainerHealthMonitor()
    }
    return ContainerHealthMonitor.instance
  }

  /**
   * Start health monitoring
   * Requirements: 13.1
   */
  startMonitoring(): void {
    if (this.monitoringInterval) {
      console.log('Health monitoring is already running')
      return
    }

    console.log('Starting container health monitoring...')
    
    // Perform initial health check
    this.performHealthCheck().catch(error => {
      console.error('Initial health check failed:', error)
    })

    // Start periodic monitoring
    this.monitoringInterval = setInterval(async () => {
      try {
        await this.performHealthCheck()
      } catch (error) {
        console.error('Periodic health check failed:', error)
      }
    }, this.MONITORING_INTERVAL)

    console.log(`Health monitoring started with ${this.MONITORING_INTERVAL}ms interval`)
  }

  /**
   * Stop health monitoring
   * Requirements: 13.1
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval)
      this.monitoringInterval = null
      console.log('Container health monitoring stopped')
    }
  }

  /**
   * Perform comprehensive health check
   * Requirements: 13.1
   */
  private async performHealthCheck(): Promise<void> {
    const timestamp = new Date()
    
    try {
      // Check Docker container status
      const containerStatus = await this.dockerService.getContainerStatus('supabase-rest')
      
      // Check all enhanced project configurations
      const projectConfigs = this.configManager.getAllEnhancedProjectConfigs()
      
      for (const [projectRef, config] of projectConfigs) {
        try {
          // Get container health for this project
          const containerHealth = await this.containerClient.getContainerHealth(projectRef)
          
          // Get project health from configuration manager
          const projectHealth = this.configManager.getProjectHealthStatus(projectRef)
          
          // Create comprehensive health entry
          const healthEntry: HealthHistoryEntry = {
            timestamp,
            projectRef,
            containerStatus: {
              name: containerStatus.name,
              status: containerStatus.status,
              health: containerStatus.health,
              uptime: containerStatus.uptime,
              ports: containerStatus.ports
            },
            containerHealth,
            projectHealth,
            overallHealth: this.calculateOverallHealth(containerStatus, containerHealth, projectHealth)
          }
          
          // Add to history
          this.addToHistory(projectRef, healthEntry)
          
          // Log health issues
          if (!healthEntry.overallHealth.healthy) {
            console.warn(`Health issue detected for project ${projectRef}:`, healthEntry.overallHealth.issues)
          }
          
        } catch (error) {
          console.error(`Health check failed for project ${projectRef}:`, error)
          
          // Add error entry to history
          const errorEntry: HealthHistoryEntry = {
            timestamp,
            projectRef,
            containerStatus: {
              name: 'supabase-rest',
              status: 'error',
              health: 'unhealthy',
              uptime: '0',
              ports: []
            },
            containerHealth: {
              projectRef,
              healthy: false,
              status: 'error',
              responseTime: 0,
              timestamp: timestamp.toISOString(),
              details: {},
              error: error instanceof Error ? error.message : 'Unknown error'
            },
            projectHealth: null,
            overallHealth: {
              healthy: false,
              status: 'error',
              issues: [error instanceof Error ? error.message : 'Unknown error']
            }
          }
          
          this.addToHistory(projectRef, errorEntry)
        }
      }
      
    } catch (error) {
      console.error('Global health check failed:', error)
    }
  }

  /**
   * Calculate overall health status
   * Requirements: 13.1
   */
  private calculateOverallHealth(
    containerStatus: any,
    containerHealth: ContainerHealthResponse,
    projectHealth: ProjectHealthStatus | null
  ): OverallHealthStatus {
    const issues: string[] = []
    
    // Check container status
    if (containerStatus.status !== 'running') {
      issues.push(`Container is ${containerStatus.status}`)
    }
    
    if (containerStatus.health !== 'healthy') {
      issues.push(`Container health is ${containerStatus.health}`)
    }
    
    // Check container health response
    if (!containerHealth.healthy) {
      issues.push(`Container health check failed: ${containerHealth.error || 'Unknown error'}`)
    }
    
    // Check project health
    if (projectHealth && projectHealth.status !== 'healthy') {
      issues.push(`Project health is ${projectHealth.status}: ${projectHealth.error || 'Unknown error'}`)
    }
    
    const healthy = issues.length === 0
    const status = healthy ? 'healthy' : 'unhealthy'
    
    return {
      healthy,
      status,
      issues: issues.length > 0 ? issues : undefined
    }
  }

  /**
   * Add health entry to history
   * Requirements: 13.1
   */
  private addToHistory(projectRef: string, entry: HealthHistoryEntry): void {
    if (!this.healthHistory.has(projectRef)) {
      this.healthHistory.set(projectRef, [])
    }
    
    const history = this.healthHistory.get(projectRef)!
    history.push(entry)
    
    // Keep only the most recent entries
    if (history.length > this.MAX_HISTORY_ENTRIES) {
      history.splice(0, history.length - this.MAX_HISTORY_ENTRIES)
    }
  }

  /**
   * Get health history for a project
   * Requirements: 13.1
   */
  getHealthHistory(projectRef: string, limit?: number): HealthHistoryEntry[] {
    const history = this.healthHistory.get(projectRef) || []
    
    if (limit && limit > 0) {
      return history.slice(-limit)
    }
    
    return [...history]
  }

  /**
   * Get current health status for a project
   * Requirements: 13.1
   */
  getCurrentHealthStatus(projectRef: string): HealthHistoryEntry | null {
    const history = this.healthHistory.get(projectRef)
    if (!history || history.length === 0) {
      return null
    }
    
    return history[history.length - 1]
  }

  /**
   * Get health summary for all projects
   * Requirements: 13.1
   */
  getHealthSummary(): HealthSummary {
    const summary: HealthSummary = {
      timestamp: new Date(),
      totalProjects: 0,
      healthyProjects: 0,
      unhealthyProjects: 0,
      projects: []
    }
    
    for (const [projectRef] of this.healthHistory) {
      const currentHealth = this.getCurrentHealthStatus(projectRef)
      if (currentHealth) {
        summary.totalProjects++
        
        if (currentHealth.overallHealth.healthy) {
          summary.healthyProjects++
        } else {
          summary.unhealthyProjects++
        }
        
        summary.projects.push({
          projectRef,
          healthy: currentHealth.overallHealth.healthy,
          status: currentHealth.overallHealth.status,
          lastCheck: currentHealth.timestamp,
          issues: currentHealth.overallHealth.issues
        })
      }
    }
    
    return summary
  }

  /**
   * Get health alerts (unhealthy projects)
   * Requirements: 13.1
   */
  getHealthAlerts(): HealthAlert[] {
    const alerts: HealthAlert[] = []
    
    for (const [projectRef] of this.healthHistory) {
      const currentHealth = this.getCurrentHealthStatus(projectRef)
      if (currentHealth && !currentHealth.overallHealth.healthy) {
        alerts.push({
          projectRef,
          severity: this.calculateAlertSeverity(currentHealth),
          message: currentHealth.overallHealth.issues?.join(', ') || 'Unknown health issue',
          timestamp: currentHealth.timestamp,
          details: {
            containerStatus: currentHealth.containerStatus,
            containerHealth: currentHealth.containerHealth,
            projectHealth: currentHealth.projectHealth
          }
        })
      }
    }
    
    return alerts.sort((a, b) => {
      // Sort by severity (critical first) then by timestamp (newest first)
      if (a.severity !== b.severity) {
        const severityOrder = { critical: 0, warning: 1, info: 2 }
        return severityOrder[a.severity] - severityOrder[b.severity]
      }
      return b.timestamp.getTime() - a.timestamp.getTime()
    })
  }

  /**
   * Calculate alert severity
   * Requirements: 13.1
   */
  private calculateAlertSeverity(healthEntry: HealthHistoryEntry): 'critical' | 'warning' | 'info' {
    const { containerStatus, containerHealth } = healthEntry
    
    // Critical: Container is stopped or has been unhealthy for a while
    if (containerStatus.status === 'stopped' || containerStatus.status === 'error') {
      return 'critical'
    }
    
    // Critical: Container health check is failing
    if (!containerHealth.healthy && containerHealth.error) {
      return 'critical'
    }
    
    // Warning: Container is starting or health is degraded
    if (containerStatus.health === 'starting' || containerStatus.health === 'unhealthy') {
      return 'warning'
    }
    
    // Info: Minor issues
    return 'info'
  }

  /**
   * Clear health history for a project
   * Requirements: 13.1
   */
  clearHealthHistory(projectRef: string): void {
    this.healthHistory.delete(projectRef)
    console.log(`Cleared health history for project ${projectRef}`)
  }

  /**
   * Clear all health history
   * Requirements: 13.1
   */
  clearAllHealthHistory(): void {
    this.healthHistory.clear()
    console.log('Cleared all health history')
  }

  /**
   * Get monitoring status
   * Requirements: 13.1
   */
  getMonitoringStatus(): MonitoringStatus {
    return {
      isRunning: this.monitoringInterval !== null,
      interval: this.MONITORING_INTERVAL,
      maxHistoryEntries: this.MAX_HISTORY_ENTRIES,
      totalProjects: this.healthHistory.size,
      lastCheck: this.getLastCheckTime()
    }
  }

  /**
   * Get the timestamp of the last health check
   * Requirements: 13.1
   */
  private getLastCheckTime(): Date | null {
    let lastCheck: Date | null = null
    
    for (const [, history] of this.healthHistory) {
      if (history.length > 0) {
        const entryTime = history[history.length - 1].timestamp
        if (!lastCheck || entryTime > lastCheck) {
          lastCheck = entryTime
        }
      }
    }
    
    return lastCheck
  }
}

/**
 * Health history entry
 * Requirements: 13.1
 */
export interface HealthHistoryEntry {
  timestamp: Date
  projectRef: string
  containerStatus: {
    name: string
    status: string
    health: string
    uptime: string
    ports: Array<{ host: number; container: number }>
  }
  containerHealth: ContainerHealthResponse
  projectHealth: ProjectHealthStatus | null
  overallHealth: OverallHealthStatus
}

/**
 * Overall health status
 * Requirements: 13.1
 */
export interface OverallHealthStatus {
  healthy: boolean
  status: string
  issues?: string[]
}

/**
 * Health summary
 * Requirements: 13.1
 */
export interface HealthSummary {
  timestamp: Date
  totalProjects: number
  healthyProjects: number
  unhealthyProjects: number
  projects: Array<{
    projectRef: string
    healthy: boolean
    status: string
    lastCheck: Date
    issues?: string[]
  }>
}

/**
 * Health alert
 * Requirements: 13.1
 */
export interface HealthAlert {
  projectRef: string
  severity: 'critical' | 'warning' | 'info'
  message: string
  timestamp: Date
  details: {
    containerStatus: any
    containerHealth: ContainerHealthResponse
    projectHealth: ProjectHealthStatus | null
  }
}

/**
 * Monitoring status
 * Requirements: 13.1
 */
export interface MonitoringStatus {
  isRunning: boolean
  interval: number
  maxHistoryEntries: number
  totalProjects: number
  lastCheck: Date | null
}

/**
 * Factory function to get the container health monitor
 */
export function getContainerHealthMonitor(): ContainerHealthMonitor {
  return ContainerHealthMonitor.getInstance()
}