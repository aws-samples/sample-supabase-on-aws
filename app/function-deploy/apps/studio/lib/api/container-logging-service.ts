import { getEnhancedPostgRESTConfigManager } from './enhanced-postgrest-config-manager'
import { DockerContainerService } from './self-hosted/docker-container-service'

/**
 * Container Logging Service
 * Handles logging and log management for the enhanced supabase-rest container
 * Requirements: 13.1
 */
export class ContainerLoggingService {
  private static instance: ContainerLoggingService
  private dockerService: DockerContainerService
  private configManager = getEnhancedPostgRESTConfigManager()
  
  private logBuffer: Map<string, LogEntry[]> = new Map()
  private readonly MAX_LOG_ENTRIES = 1000
  private readonly LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

  private constructor() {
    this.dockerService = new DockerContainerService()
  }

  static getInstance(): ContainerLoggingService {
    if (!ContainerLoggingService.instance) {
      ContainerLoggingService.instance = new ContainerLoggingService()
    }
    return ContainerLoggingService.instance
  }

  /**
   * Log a message for a specific project
   * Requirements: 13.1
   */
  log(
    projectRef: string,
    level: LogLevel,
    message: string,
    details?: Record<string, any>,
    source?: string
  ): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      projectRef,
      level,
      message,
      details,
      source: source || 'enhanced-postgrest-engine'
    }

    // Add to buffer
    this.addToBuffer(projectRef, entry)

    // Console logging based on level
    const logMessage = this.formatLogMessage(entry)
    
    switch (level) {
      case 'debug':
        if (process.env.NODE_ENV === 'development') {
          console.debug(logMessage)
        }
        break
      case 'info':
        console.info(logMessage)
        break
      case 'warn':
        console.warn(logMessage)
        break
      case 'error':
        console.error(logMessage)
        break
    }
  }

  /**
   * Log debug message
   * Requirements: 13.1
   */
  debug(projectRef: string, message: string, details?: Record<string, any>, source?: string): void {
    this.log(projectRef, 'debug', message, details, source)
  }

  /**
   * Log info message
   * Requirements: 13.1
   */
  info(projectRef: string, message: string, details?: Record<string, any>, source?: string): void {
    this.log(projectRef, 'info', message, details, source)
  }

  /**
   * Log warning message
   * Requirements: 13.1
   */
  warn(projectRef: string, message: string, details?: Record<string, any>, source?: string): void {
    this.log(projectRef, 'warn', message, details, source)
  }

  /**
   * Log error message
   * Requirements: 13.1
   */
  error(projectRef: string, message: string, details?: Record<string, any>, source?: string): void {
    this.log(projectRef, 'error', message, details, source)
  }

  /**
   * Log request details
   * Requirements: 13.1
   */
  logRequest(
    projectRef: string,
    method: string,
    path: string,
    statusCode: number,
    responseTime: number,
    userAgent?: string,
    userId?: string
  ): void {
    const level: LogLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info'
    
    this.log(projectRef, level, `${method} ${path} - ${statusCode}`, {
      method,
      path,
      statusCode,
      responseTime,
      userAgent,
      userId
    }, 'request-logger')
  }

  /**
   * Log query execution details
   * Requirements: 13.1
   */
  logQuery(
    projectRef: string,
    query: string,
    executionTime: number,
    rowCount?: number,
    error?: string
  ): void {
    const level: LogLevel = error ? 'error' : 'debug'
    const message = error ? `Query failed: ${error}` : `Query executed successfully`
    
    this.log(projectRef, level, message, {
      query: query.substring(0, 500), // Truncate long queries
      executionTime,
      rowCount,
      error
    }, 'query-logger')
  }

  /**
   * Log performance metrics
   * Requirements: 13.1
   */
  logPerformance(
    projectRef: string,
    operation: string,
    metrics: PerformanceMetrics
  ): void {
    const level: LogLevel = metrics.executionTime > 5000 ? 'warn' : 'debug'
    
    this.log(projectRef, level, `Performance: ${operation}`, {
      operation,
      ...metrics
    }, 'performance-logger')
  }

  /**
   * Get logs for a project
   * Requirements: 13.1
   */
  getLogs(
    projectRef: string,
    options: GetLogsOptions = {}
  ): LogEntry[] {
    const logs = this.logBuffer.get(projectRef) || []
    let filteredLogs = [...logs]

    // Filter by level
    if (options.level) {
      const levelIndex = this.LOG_LEVELS.indexOf(options.level)
      filteredLogs = filteredLogs.filter(log => 
        this.LOG_LEVELS.indexOf(log.level) >= levelIndex
      )
    }

    // Filter by source
    if (options.source) {
      filteredLogs = filteredLogs.filter(log => log.source === options.source)
    }

    // Filter by time range
    if (options.since) {
      filteredLogs = filteredLogs.filter(log => log.timestamp >= options.since!)
    }

    if (options.until) {
      filteredLogs = filteredLogs.filter(log => log.timestamp <= options.until!)
    }

    // Filter by search term
    if (options.search) {
      const searchTerm = options.search.toLowerCase()
      filteredLogs = filteredLogs.filter(log => 
        log.message.toLowerCase().includes(searchTerm) ||
        (log.details && JSON.stringify(log.details).toLowerCase().includes(searchTerm))
      )
    }

    // Sort by timestamp (newest first)
    filteredLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

    // Apply limit
    if (options.limit && options.limit > 0) {
      filteredLogs = filteredLogs.slice(0, options.limit)
    }

    return filteredLogs
  }

  /**
   * Get container logs from Docker
   * Requirements: 13.1
   */
  async getContainerLogs(lines: number = 100): Promise<string[]> {
    try {
      return await this.dockerService.getContainerLogs('supabase-rest', lines)
    } catch (error) {
      console.error('Failed to get container logs:', error)
      return [`Error retrieving container logs: ${error instanceof Error ? error.message : 'Unknown error'}`]
    }
  }

  /**
   * Get log statistics for a project
   * Requirements: 13.1
   */
  getLogStatistics(projectRef: string, since?: Date): LogStatistics {
    const logs = this.getLogs(projectRef, { since })
    
    const stats: LogStatistics = {
      projectRef,
      totalLogs: logs.length,
      logsByLevel: {
        debug: 0,
        info: 0,
        warn: 0,
        error: 0
      },
      logsBySource: {},
      timeRange: {
        oldest: null,
        newest: null
      }
    }

    for (const log of logs) {
      // Count by level
      stats.logsByLevel[log.level]++

      // Count by source
      if (log.source) {
        stats.logsBySource[log.source] = (stats.logsBySource[log.source] || 0) + 1
      }

      // Update time range
      if (!stats.timeRange.oldest || log.timestamp < stats.timeRange.oldest) {
        stats.timeRange.oldest = log.timestamp
      }
      if (!stats.timeRange.newest || log.timestamp > stats.timeRange.newest) {
        stats.timeRange.newest = log.timestamp
      }
    }

    return stats
  }

  /**
   * Clear logs for a project
   * Requirements: 13.1
   */
  clearLogs(projectRef: string): void {
    this.logBuffer.delete(projectRef)
    console.log(`Cleared logs for project ${projectRef}`)
  }

  /**
   * Clear all logs
   * Requirements: 13.1
   */
  clearAllLogs(): void {
    this.logBuffer.clear()
    console.log('Cleared all logs')
  }

  /**
   * Export logs to JSON
   * Requirements: 13.1
   */
  exportLogs(projectRef: string, options: GetLogsOptions = {}): string {
    const logs = this.getLogs(projectRef, options)
    return JSON.stringify(logs, null, 2)
  }

  /**
   * Get log summary for all projects
   * Requirements: 13.1
   */
  getLogSummary(): LogSummary {
    const summary: LogSummary = {
      timestamp: new Date(),
      totalProjects: this.logBuffer.size,
      totalLogs: 0,
      logsByLevel: {
        debug: 0,
        info: 0,
        warn: 0,
        error: 0
      },
      projects: []
    }

    for (const [projectRef, logs] of this.logBuffer) {
      const projectStats = this.getLogStatistics(projectRef)
      
      summary.totalLogs += projectStats.totalLogs
      summary.logsByLevel.debug += projectStats.logsByLevel.debug
      summary.logsByLevel.info += projectStats.logsByLevel.info
      summary.logsByLevel.warn += projectStats.logsByLevel.warn
      summary.logsByLevel.error += projectStats.logsByLevel.error

      summary.projects.push({
        projectRef,
        totalLogs: projectStats.totalLogs,
        errorCount: projectStats.logsByLevel.error,
        warningCount: projectStats.logsByLevel.warn,
        lastLogTime: projectStats.timeRange.newest
      })
    }

    return summary
  }

  /**
   * Add log entry to buffer
   * Requirements: 13.1
   */
  private addToBuffer(projectRef: string, entry: LogEntry): void {
    if (!this.logBuffer.has(projectRef)) {
      this.logBuffer.set(projectRef, [])
    }

    const buffer = this.logBuffer.get(projectRef)!
    buffer.push(entry)

    // Keep only the most recent entries
    if (buffer.length > this.MAX_LOG_ENTRIES) {
      buffer.splice(0, buffer.length - this.MAX_LOG_ENTRIES)
    }
  }

  /**
   * Format log message for console output
   * Requirements: 13.1
   */
  private formatLogMessage(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString()
    const level = entry.level.toUpperCase().padEnd(5)
    const source = entry.source ? `[${entry.source}]` : ''
    const project = `[${entry.projectRef}]`
    
    let message = `${timestamp} ${level} ${project} ${source} ${entry.message}`
    
    if (entry.details && Object.keys(entry.details).length > 0) {
      message += ` ${JSON.stringify(entry.details)}`
    }
    
    return message
  }
}

/**
 * Log level type
 * Requirements: 13.1
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Log entry interface
 * Requirements: 13.1
 */
export interface LogEntry {
  timestamp: Date
  projectRef: string
  level: LogLevel
  message: string
  details?: Record<string, any>
  source?: string
}

/**
 * Performance metrics interface
 * Requirements: 13.1
 */
export interface PerformanceMetrics {
  executionTime: number
  memoryUsage?: number
  cpuUsage?: number
  queryCount?: number
  cacheHits?: number
  cacheMisses?: number
}

/**
 * Get logs options interface
 * Requirements: 13.1
 */
export interface GetLogsOptions {
  level?: LogLevel
  source?: string
  since?: Date
  until?: Date
  search?: string
  limit?: number
}

/**
 * Log statistics interface
 * Requirements: 13.1
 */
export interface LogStatistics {
  projectRef: string
  totalLogs: number
  logsByLevel: Record<LogLevel, number>
  logsBySource: Record<string, number>
  timeRange: {
    oldest: Date | null
    newest: Date | null
  }
}

/**
 * Log summary interface
 * Requirements: 13.1
 */
export interface LogSummary {
  timestamp: Date
  totalProjects: number
  totalLogs: number
  logsByLevel: Record<LogLevel, number>
  projects: Array<{
    projectRef: string
    totalLogs: number
    errorCount: number
    warningCount: number
    lastLogTime: Date | null
  }>
}

/**
 * Factory function to get the container logging service
 */
export function getContainerLoggingService(): ContainerLoggingService {
  return ContainerLoggingService.getInstance()
}