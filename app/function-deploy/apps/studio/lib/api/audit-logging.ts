/**
 * Audit logging for sensitive operations
 * 
 * This module provides:
 * - Comprehensive audit trail for security-sensitive operations
 * - Structured logging with metadata and context
 * - Integration with monitoring and alerting systems
 * - Compliance and forensic capabilities
 * 
 * Requirements: Security and performance considerations
 */

import { 
  ProjectManagementError, 
  ErrorFactory, 
  createErrorContext,
  withErrorHandling 
} from './error-handling'

/**
 * Audit event types for different operations
 */
export enum AuditEventType {
  // Authentication events
  USER_LOGIN = 'USER_LOGIN',
  USER_LOGOUT = 'USER_LOGOUT',
  USER_LOGIN_FAILED = 'USER_LOGIN_FAILED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  
  // Project management events
  PROJECT_CREATED = 'PROJECT_CREATED',
  PROJECT_DELETED = 'PROJECT_DELETED',
  PROJECT_DELETE_ATTEMPTED = 'PROJECT_DELETE_ATTEMPTED',
  PROJECT_SETTINGS_ACCESSED = 'PROJECT_SETTINGS_ACCESSED',
  PROJECT_SETTINGS_MODIFIED = 'PROJECT_SETTINGS_MODIFIED',
  
  // Data access events
  DATA_ACCESSED = 'DATA_ACCESSED',
  DATA_MODIFIED = 'DATA_MODIFIED',
  DATA_EXPORTED = 'DATA_EXPORTED',
  UNAUTHORIZED_ACCESS_ATTEMPTED = 'UNAUTHORIZED_ACCESS_ATTEMPTED',
  
  // Security events
  SUSPICIOUS_ACTIVITY_DETECTED = 'SUSPICIOUS_ACTIVITY_DETECTED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  DATA_ISOLATION_VIOLATION = 'DATA_ISOLATION_VIOLATION',
  
  // System events
  API_ERROR = 'API_ERROR',
  SYSTEM_ERROR = 'SYSTEM_ERROR',
  PERFORMANCE_ISSUE = 'PERFORMANCE_ISSUE'
}

/**
 * Audit event severity levels
 */
export enum AuditSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical'
}

/**
 * Audit event metadata
 */
export interface AuditEventMetadata {
  userId?: string
  projectId?: number
  projectRef?: string
  endpoint?: string
  method?: string
  userAgent?: string
  ipAddress?: string
  sessionId?: string
  requestId?: string
  duration?: number
  dataType?: string
  recordCount?: number
  errorCode?: string
  [key: string]: any
}

/**
 * Structured audit event
 */
export interface AuditEvent {
  id: string
  timestamp: Date
  eventType: AuditEventType
  severity: AuditSeverity
  message: string
  metadata: AuditEventMetadata
  success: boolean
  source: string
}

/**
 * Audit log storage interface
 */
export interface AuditLogStorage {
  store(event: AuditEvent): Promise<void>
  query(filters: AuditLogFilters): Promise<AuditEvent[]>
  count(filters: AuditLogFilters): Promise<number>
}

/**
 * Audit log query filters
 */
export interface AuditLogFilters {
  eventTypes?: AuditEventType[]
  severity?: AuditSeverity[]
  userId?: string
  projectId?: number
  startDate?: Date
  endDate?: Date
  limit?: number
  offset?: number
}

/**
 * In-memory audit log storage (for development/testing)
 */
class InMemoryAuditStorage implements AuditLogStorage {
  private events: AuditEvent[] = []
  private maxEvents = 10000 // Prevent memory issues

  async store(event: AuditEvent): Promise<void> {
    this.events.push(event)
    
    // Keep only the most recent events
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents)
    }
  }

  async query(filters: AuditLogFilters): Promise<AuditEvent[]> {
    let filteredEvents = [...this.events]

    // Apply filters
    if (filters.eventTypes?.length) {
      filteredEvents = filteredEvents.filter(e => filters.eventTypes!.includes(e.eventType))
    }

    if (filters.severity?.length) {
      filteredEvents = filteredEvents.filter(e => filters.severity!.includes(e.severity))
    }

    if (filters.userId) {
      filteredEvents = filteredEvents.filter(e => e.metadata.userId === filters.userId)
    }

    if (filters.projectId) {
      filteredEvents = filteredEvents.filter(e => e.metadata.projectId === filters.projectId)
    }

    if (filters.startDate) {
      filteredEvents = filteredEvents.filter(e => e.timestamp >= filters.startDate!)
    }

    if (filters.endDate) {
      filteredEvents = filteredEvents.filter(e => e.timestamp <= filters.endDate!)
    }

    // Sort by timestamp (newest first)
    filteredEvents.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

    // Apply pagination
    const offset = filters.offset || 0
    const limit = filters.limit || 100
    return filteredEvents.slice(offset, offset + limit)
  }

  async count(filters: AuditLogFilters): Promise<number> {
    const events = await this.query({ ...filters, limit: undefined, offset: undefined })
    return events.length
  }

  // Development helper methods
  clear(): void {
    this.events = []
  }

  getAll(): AuditEvent[] {
    return [...this.events]
  }
}

/**
 * Audit logger class for recording security events
 */
export class AuditLogger {
  private storage: AuditLogStorage
  private source: string

  constructor(storage?: AuditLogStorage, source = 'supabase-studio') {
    this.storage = storage || new InMemoryAuditStorage()
    this.source = source
  }

  /**
   * Log an audit event
   */
  async logEvent(
    eventType: AuditEventType,
    message: string,
    metadata: AuditEventMetadata = {},
    severity: AuditSeverity = AuditSeverity.INFO,
    success = true
  ): Promise<void> {
    const errorContext = createErrorContext('AuditLogger.logEvent')

    return withErrorHandling(
      async () => {
        const event: AuditEvent = {
          id: this.generateEventId(),
          timestamp: new Date(),
          eventType,
          severity,
          message,
          metadata,
          success,
          source: this.source
        }

        await this.storage.store(event)
        this.logToConsole(event)
      },
      errorContext,
      (cause) => ErrorFactory.generic.internalServerError('audit logging', cause, errorContext)
    )
  }

  /**
   * Log project management events
   */
  async logProjectOperation(
    eventType: AuditEventType,
    projectId: number,
    projectRef: string,
    userId: string,
    metadata: AuditEventMetadata = {},
    success = true
  ): Promise<void> {
    const message = this.getProjectOperationMessage(eventType, projectRef, success)
    const severity = this.getProjectOperationSeverity(eventType, success)

    await this.logEvent(
      eventType,
      message,
      { ...metadata, projectId, projectRef, userId },
      severity,
      success
    )
  }

  /**
   * Log security events
   */
  async logSecurityEvent(
    eventType: AuditEventType,
    message: string,
    metadata: AuditEventMetadata = {},
    severity: AuditSeverity = AuditSeverity.WARNING
  ): Promise<void> {
    await this.logEvent(eventType, message, metadata, severity, false)
  }

  /**
   * Query audit logs
   */
  async queryLogs(filters: AuditLogFilters): Promise<AuditEvent[]> {
    const errorContext = createErrorContext('AuditLogger.queryLogs')

    return withErrorHandling(
      async () => {
        return await this.storage.query(filters)
      },
      errorContext,
      (cause) => ErrorFactory.generic.internalServerError('audit log query', cause, errorContext)
    )
  }

  private generateEventId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`
  }

  private getProjectOperationMessage(
    eventType: AuditEventType,
    projectRef: string,
    success: boolean
  ): string {
    switch (eventType) {
      case AuditEventType.PROJECT_DELETED:
        return success ? `Project ${projectRef} deleted successfully` : `Failed to delete project ${projectRef}`
      case AuditEventType.PROJECT_DELETE_ATTEMPTED:
        return `Deletion attempted for project ${projectRef}`
      case AuditEventType.PROJECT_SETTINGS_ACCESSED:
        return `Settings accessed for project ${projectRef}`
      default:
        return `Project operation on ${projectRef}`
    }
  }

  private getProjectOperationSeverity(eventType: AuditEventType, success: boolean): AuditSeverity {
    if (!success) {
      return AuditSeverity.ERROR
    }

    switch (eventType) {
      case AuditEventType.PROJECT_DELETED:
        return AuditSeverity.WARNING
      case AuditEventType.PROJECT_DELETE_ATTEMPTED:
        return AuditSeverity.WARNING
      default:
        return AuditSeverity.INFO
    }
  }

  private logToConsole(event: AuditEvent): void {
    const logLevel = this.getConsoleLogLevel(event.severity)
    const logMessage = `[AUDIT] ${event.eventType}: ${event.message}`
    
    console[logLevel](logMessage, {
      id: event.id,
      timestamp: event.timestamp,
      metadata: event.metadata,
      success: event.success
    })
  }

  private getConsoleLogLevel(severity: AuditSeverity): 'info' | 'warn' | 'error' {
    switch (severity) {
      case AuditSeverity.CRITICAL:
      case AuditSeverity.ERROR:
        return 'error'
      case AuditSeverity.WARNING:
        return 'warn'
      case AuditSeverity.INFO:
      default:
        return 'info'
    }
  }
}

/**
 * Singleton audit logger instance
 */
let auditLoggerInstance: AuditLogger | null = null

/**
 * Get the singleton AuditLogger instance
 */
export function getAuditLogger(): AuditLogger {
  if (!auditLoggerInstance) {
    auditLoggerInstance = new AuditLogger()
  }
  return auditLoggerInstance
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetAuditLogger(): void {
  auditLoggerInstance = null
}