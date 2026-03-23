/**
 * Comprehensive error handling utilities for project management improvements
 * 
 * This module provides:
 * - Standardized error types and codes
 * - Error classification and handling strategies
 * - User-friendly error messages and recovery options
 * - Logging and monitoring integration
 * - Security audit logging for access control violations
 * - Sanitized error messages that don't leak sensitive information
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */

import { NextApiResponse } from 'next'
import { toast } from 'sonner'

/**
 * Security audit log entry
 */
export interface SecurityAuditLog {
  eventType: 'authentication_failure' | 'authorization_failure' | 'access_violation' | 'data_ownership_violation' | 'suspicious_activity'
  severity: 'low' | 'medium' | 'high' | 'critical'
  userId?: string
  projectId?: number
  projectRef?: string
  operation: string
  reason: string
  ip?: string
  userAgent?: string
  endpoint?: string
  method?: string
  requestId?: string
  metadata?: Record<string, any>
  timestamp: Date
}

/**
 * Standard error codes for project management operations
 */
export enum ErrorCode {
  // Project deletion errors
  PROJECT_NOT_FOUND = 'PROJECT_NOT_FOUND',
  PROJECT_DELETE_FORBIDDEN = 'PROJECT_DELETE_FORBIDDEN',
  PROJECT_DELETE_FAILED = 'PROJECT_DELETE_FAILED',
  PROJECT_DELETE_DEFAULT_PROJECT = 'PROJECT_DELETE_DEFAULT_PROJECT',
  PROJECT_DELETE_VALIDATION_FAILED = 'PROJECT_DELETE_VALIDATION_FAILED',
  
  // Data isolation errors
  DATA_ISOLATION_FAILED = 'DATA_ISOLATION_FAILED',
  INVALID_PROJECT_ID = 'INVALID_PROJECT_ID',
  PROJECT_ACCESS_DENIED = 'PROJECT_ACCESS_DENIED',
  DATA_OWNERSHIP_VIOLATION = 'DATA_OWNERSHIP_VIOLATION',
  DATA_QUERY_FAILED = 'DATA_QUERY_FAILED',
  CROSS_PROJECT_DATA_LEAK = 'CROSS_PROJECT_DATA_LEAK',
  
  // Routing errors
  INVALID_PROJECT_REF = 'INVALID_PROJECT_REF',
  SETTINGS_LOAD_FAILED = 'SETTINGS_LOAD_FAILED',
  ROUTE_PARAMETER_INVALID = 'ROUTE_PARAMETER_INVALID',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  
  // Authentication and authorization errors
  USER_NOT_AUTHENTICATED = 'USER_NOT_AUTHENTICATED',
  TOKEN_MISSING = 'TOKEN_MISSING',
  TOKEN_INVALID = 'TOKEN_INVALID',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  ORGANIZATION_ACCESS_DENIED = 'ORGANIZATION_ACCESS_DENIED',
  
  // Validation errors
  INVALID_INPUT = 'INVALID_INPUT',
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
  
  // Generic errors
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR'
}

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

/**
 * Error recovery strategies
 */
export enum RecoveryStrategy {
  RETRY = 'retry',
  REDIRECT = 'redirect',
  REFRESH = 'refresh',
  CONTACT_SUPPORT = 'contact_support',
  MANUAL_INTERVENTION = 'manual_intervention',
  NONE = 'none'
}

/**
 * Structured error information
 */
export interface ErrorInfo {
  code: ErrorCode
  message: string
  userMessage: string
  severity: ErrorSeverity
  recoveryStrategy: RecoveryStrategy
  recoveryOptions?: RecoveryOption[]
  metadata?: Record<string, any>
  timestamp: Date
}

/**
 * Recovery option for user actions
 */
export interface RecoveryOption {
  label: string
  action: () => any
  type: 'primary' | 'secondary' | 'danger'
}

/**
 * Error context for logging and debugging
 */
export interface ErrorContext {
  userId?: string
  projectId?: number
  projectRef?: string
  operation: string
  endpoint?: string
  method?: string
  userAgent?: string
  ip?: string
  requestId?: string
}

/**
 * Write security audit log entry
 * Requirements: 6.2, 6.3
 * 
 * @param log - Security audit log entry
 */
export function writeSecurityAuditLog(log: SecurityAuditLog): void {
  // Structured security audit log
  const auditEntry = {
    type: 'SECURITY_AUDIT',
    eventType: log.eventType,
    severity: log.severity,
    userId: log.userId || 'anonymous',
    projectId: log.projectId,
    projectRef: log.projectRef,
    operation: log.operation,
    reason: log.reason,
    ip: log.ip,
    userAgent: log.userAgent,
    endpoint: log.endpoint,
    method: log.method,
    requestId: log.requestId,
    metadata: log.metadata,
    timestamp: log.timestamp.toISOString()
  }

  // Log with appropriate severity level
  switch (log.severity) {
    case 'critical':
      console.error('[SECURITY AUDIT - CRITICAL]', JSON.stringify(auditEntry, null, 2))
      break
    case 'high':
      console.error('[SECURITY AUDIT - HIGH]', JSON.stringify(auditEntry, null, 2))
      break
    case 'medium':
      console.warn('[SECURITY AUDIT - MEDIUM]', JSON.stringify(auditEntry, null, 2))
      break
    case 'low':
      console.info('[SECURITY AUDIT - LOW]', JSON.stringify(auditEntry, null, 2))
      break
  }

  // In production, this would also send to a security monitoring service
  // e.g., Sentry, DataDog, CloudWatch, etc.
}

/**
 * Log authentication failure for security audit
 * Requirements: 4.5, 6.3
 * 
 * @param context - Error context with authentication details
 * @param reason - Reason for authentication failure
 */
export function logAuthenticationFailure(
  context: ErrorContext,
  reason: string
): void {
  writeSecurityAuditLog({
    eventType: 'authentication_failure',
    severity: 'medium',
    userId: context.userId,
    projectId: context.projectId,
    projectRef: context.projectRef,
    operation: context.operation,
    reason,
    ip: context.ip,
    userAgent: context.userAgent,
    endpoint: context.endpoint,
    requestId: context.requestId,
    timestamp: new Date()
  })
}

/**
 * Log authorization failure for security audit
 * Requirements: 6.2, 6.3
 * 
 * @param context - Error context with authorization details
 * @param reason - Reason for authorization failure
 */
export function logAuthorizationFailure(
  context: ErrorContext,
  reason: string
): void {
  writeSecurityAuditLog({
    eventType: 'authorization_failure',
    severity: 'high',
    userId: context.userId,
    projectId: context.projectId,
    projectRef: context.projectRef,
    operation: context.operation,
    reason,
    ip: context.ip,
    userAgent: context.userAgent,
    endpoint: context.endpoint,
    requestId: context.requestId,
    timestamp: new Date()
  })
}

/**
 * Log access control violation for security audit
 * Requirements: 6.2
 * 
 * @param context - Error context with violation details
 * @param violationType - Type of access violation
 * @param details - Additional details about the violation
 */
export function logAccessViolation(
  context: ErrorContext,
  violationType: string,
  details?: Record<string, any>
): void {
  writeSecurityAuditLog({
    eventType: 'access_violation',
    severity: 'high',
    userId: context.userId,
    projectId: context.projectId,
    projectRef: context.projectRef,
    operation: context.operation,
    reason: violationType,
    ip: context.ip,
    userAgent: context.userAgent,
    endpoint: context.endpoint,
    requestId: context.requestId,
    metadata: details,
    timestamp: new Date()
  })
}

/**
 * Log data ownership violation for security audit
 * Requirements: 6.2
 * 
 * @param context - Error context with violation details
 * @param details - Details about the data ownership violation
 */
export function logDataOwnershipViolation(
  context: ErrorContext,
  details: Record<string, any>
): void {
  writeSecurityAuditLog({
    eventType: 'data_ownership_violation',
    severity: 'critical',
    userId: context.userId,
    projectId: context.projectId,
    projectRef: context.projectRef,
    operation: context.operation,
    reason: 'Data ownership violation detected',
    ip: context.ip,
    userAgent: context.userAgent,
    endpoint: context.endpoint,
    requestId: context.requestId,
    metadata: details,
    timestamp: new Date()
  })
}

/**
 * Log suspicious activity for security audit
 * Requirements: 6.2, 6.3
 * 
 * @param context - Error context with activity details
 * @param activityDescription - Description of suspicious activity
 * @param metadata - Additional metadata about the activity
 */
export function logSuspiciousActivity(
  context: ErrorContext,
  activityDescription: string,
  metadata?: Record<string, any>
): void {
  writeSecurityAuditLog({
    eventType: 'suspicious_activity',
    severity: 'high',
    userId: context.userId,
    projectId: context.projectId,
    projectRef: context.projectRef,
    operation: context.operation,
    reason: activityDescription,
    ip: context.ip,
    userAgent: context.userAgent,
    endpoint: context.endpoint,
    requestId: context.requestId,
    metadata,
    timestamp: new Date()
  })
}

/**
 * Sanitize error message to prevent sensitive information leakage
 * Requirements: 6.1, 6.5
 * 
 * @param message - Original error message
 * @returns Sanitized error message safe for client display
 */
export function sanitizeErrorMessage(message: string): string {
  // Remove potential sensitive patterns
  let sanitized = message
  
  // Remove database connection strings
  sanitized = sanitized.replace(/postgres:\/\/[^\s]+/gi, '[DATABASE_CONNECTION]')
  sanitized = sanitized.replace(/postgresql:\/\/[^\s]+/gi, '[DATABASE_CONNECTION]')
  
  // Remove API keys and tokens
  sanitized = sanitized.replace(/[a-zA-Z0-9_-]{32,}/g, '[REDACTED_TOKEN]')
  
  // Remove email addresses (except in specific contexts)
  sanitized = sanitized.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL]')
  
  // Remove IP addresses
  sanitized = sanitized.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP_ADDRESS]')
  
  // Remove file paths
  sanitized = sanitized.replace(/\/[a-zA-Z0-9_\-./]+/g, '[FILE_PATH]')
  sanitized = sanitized.replace(/[A-Z]:\\[a-zA-Z0-9_\-\\]+/g, '[FILE_PATH]')
  
  // Remove SQL query fragments
  sanitized = sanitized.replace(/SELECT .+ FROM .+/gi, '[SQL_QUERY]')
  sanitized = sanitized.replace(/INSERT INTO .+/gi, '[SQL_QUERY]')
  sanitized = sanitized.replace(/UPDATE .+ SET .+/gi, '[SQL_QUERY]')
  sanitized = sanitized.replace(/DELETE FROM .+/gi, '[SQL_QUERY]')
  
  // Remove stack traces
  sanitized = sanitized.replace(/at .+\(.+:\d+:\d+\)/g, '[STACK_TRACE]')
  
  return sanitized
}

/**
 * Create safe error response that doesn't leak sensitive information
 * Requirements: 6.1, 6.4, 6.5
 * 
 * @param error - Error object
 * @param includeDetails - Whether to include detailed error information (only in development)
 * @returns Safe error response object
 */
export function createSafeErrorResponse(
  error: ProjectManagementError,
  includeDetails: boolean = false
): {
  error: string
  message: string
  code: string
  severity: string
  recoveryStrategy: string
  timestamp: string
  details?: any
} {
  const isDevelopment = process.env.NODE_ENV === 'development'
  
  // Base response with sanitized message
  const response = {
    error: error.name,
    message: sanitizeErrorMessage(error.userMessage),
    code: error.code,
    severity: error.severity,
    recoveryStrategy: error.recoveryStrategy,
    timestamp: error.timestamp.toISOString()
  }
  
  // Only include detailed information in development mode
  if (isDevelopment && includeDetails) {
    return {
      ...response,
      details: {
        originalMessage: error.message,
        metadata: error.metadata,
        stack: error.stack
      }
    }
  }
  
  return response
}

/**
 * Comprehensive error class with context and recovery options
 */
export class ProjectManagementError extends Error {
  public readonly code: ErrorCode
  public readonly userMessage: string
  public readonly severity: ErrorSeverity
  public readonly recoveryStrategy: RecoveryStrategy
  public readonly recoveryOptions?: RecoveryOption[]
  public context?: ErrorContext
  public readonly metadata?: Record<string, any>
  public readonly timestamp: Date

  constructor(
    code: ErrorCode,
    message: string,
    userMessage: string,
    severity: ErrorSeverity = ErrorSeverity.MEDIUM,
    recoveryStrategy: RecoveryStrategy = RecoveryStrategy.NONE,
    options?: {
      recoveryOptions?: RecoveryOption[]
      context?: ErrorContext
      metadata?: Record<string, any>
      cause?: Error
    }
  ) {
    super(message, { cause: options?.cause })
    
    this.name = 'ProjectManagementError'
    this.code = code
    this.userMessage = userMessage
    this.severity = severity
    this.recoveryStrategy = recoveryStrategy
    this.recoveryOptions = options?.recoveryOptions
    this.context = options?.context
    this.metadata = options?.metadata
    this.timestamp = new Date()
  }

  /**
   * Convert error to API response format
   * Requirements: 6.1, 6.4
   */
  toApiResponse(): {
    error: string
    message: string
    code: string
    severity: string
    recoveryStrategy: string
    timestamp: string
    metadata?: Record<string, any>
  } {
    // Use safe error response that doesn't leak sensitive information
    return createSafeErrorResponse(this, false)
  }

  /**
   * Log error with appropriate level based on severity
   * Also writes security audit log for security-related errors
   * Requirements: 6.2, 6.3
   */
  log(): void {
    const logData = {
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      severity: this.severity,
      context: this.context,
      metadata: this.metadata,
      timestamp: this.timestamp,
      stack: this.stack
    }

    switch (this.severity) {
      case ErrorSeverity.CRITICAL:
        console.error('CRITICAL ERROR:', logData)
        break
      case ErrorSeverity.HIGH:
        console.error('HIGH SEVERITY ERROR:', logData)
        break
      case ErrorSeverity.MEDIUM:
        console.warn('MEDIUM SEVERITY ERROR:', logData)
        break
      case ErrorSeverity.LOW:
        console.info('LOW SEVERITY ERROR:', logData)
        break
    }

    // Write security audit log for security-related errors
    if (this.context && this.isSecurityRelated()) {
      this.writeSecurityAuditLog()
    }
  }

  /**
   * Check if error is security-related
   * Requirements: 6.2
   */
  private isSecurityRelated(): boolean {
    const securityCodes = [
      ErrorCode.USER_NOT_AUTHENTICATED,
      ErrorCode.TOKEN_MISSING,
      ErrorCode.TOKEN_INVALID,
      ErrorCode.TOKEN_EXPIRED,
      ErrorCode.AUTHENTICATION_FAILED,
      ErrorCode.INSUFFICIENT_PERMISSIONS,
      ErrorCode.PROJECT_ACCESS_DENIED,
      ErrorCode.ORGANIZATION_ACCESS_DENIED,
      ErrorCode.DATA_OWNERSHIP_VIOLATION,
      ErrorCode.CROSS_PROJECT_DATA_LEAK,
      ErrorCode.PROJECT_DELETE_FORBIDDEN
    ]
    
    return securityCodes.includes(this.code)
  }

  /**
   * Write security audit log for this error
   * Requirements: 6.2, 6.3
   */
  private writeSecurityAuditLog(): void {
    if (!this.context) return

    let eventType: SecurityAuditLog['eventType'] = 'access_violation'
    let severity: SecurityAuditLog['severity'] = 'medium'

    // Determine event type and severity based on error code
    switch (this.code) {
      case ErrorCode.USER_NOT_AUTHENTICATED:
      case ErrorCode.TOKEN_MISSING:
      case ErrorCode.TOKEN_INVALID:
      case ErrorCode.TOKEN_EXPIRED:
      case ErrorCode.AUTHENTICATION_FAILED:
        eventType = 'authentication_failure'
        severity = 'medium'
        break
      
      case ErrorCode.INSUFFICIENT_PERMISSIONS:
      case ErrorCode.PROJECT_ACCESS_DENIED:
      case ErrorCode.ORGANIZATION_ACCESS_DENIED:
      case ErrorCode.PROJECT_DELETE_FORBIDDEN:
        eventType = 'authorization_failure'
        severity = 'high'
        break
      
      case ErrorCode.DATA_OWNERSHIP_VIOLATION:
      case ErrorCode.CROSS_PROJECT_DATA_LEAK:
        eventType = 'data_ownership_violation'
        severity = 'critical'
        break
    }

    writeSecurityAuditLog({
      eventType,
      severity,
      userId: this.context.userId,
      projectId: this.context.projectId,
      projectRef: this.context.projectRef,
      operation: this.context.operation,
      reason: this.message,
      ip: this.context.ip,
      userAgent: this.context.userAgent,
      endpoint: this.context.endpoint,
      requestId: this.context.requestId,
      metadata: this.metadata,
      timestamp: this.timestamp
    })
  }
}

/**
 * Error factory for creating standardized errors
 */
export class ErrorFactory {
  /**
   * Create project deletion errors
   */
  static projectDeletion = {
    projectNotFound: (projectRef: string, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.PROJECT_NOT_FOUND,
        `Project not found: ${projectRef}`,
        `The project "${projectRef}" could not be found. It may have been deleted or you may not have access to it.`,
        ErrorSeverity.MEDIUM,
        RecoveryStrategy.REDIRECT,
        {
          context,
          recoveryOptions: [
            {
              label: 'Go to Projects',
              action: () => window.location.href = '/projects',
              type: 'primary'
            },
            {
              label: 'Contact Support',
              action: () => window.open('/support', '_blank'),
              type: 'secondary'
            }
          ]
        }
      ),

    deleteForbidden: (projectRef: string, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.PROJECT_DELETE_FORBIDDEN,
        `Delete forbidden for project: ${projectRef}`,
        'You do not have permission to delete this project. Please contact your organization administrator.',
        ErrorSeverity.HIGH,
        RecoveryStrategy.CONTACT_SUPPORT,
        {
          context,
          recoveryOptions: [
            {
              label: 'Contact Admin',
              action: () => toast.info('Please contact your organization administrator for project deletion permissions.'),
              type: 'primary'
            }
          ]
        }
      ),

    deleteFailed: (projectRef: string, cause?: Error, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.PROJECT_DELETE_FAILED,
        `Failed to delete project: ${projectRef}`,
        'Project deletion failed due to a server error. Please try again or contact support if the problem persists.',
        ErrorSeverity.HIGH,
        RecoveryStrategy.RETRY,
        {
          context,
          cause,
          recoveryOptions: [
            {
              label: 'Try Again',
              action: () => window.location.reload(),
              type: 'primary'
            },
            {
              label: 'Contact Support',
              action: () => window.open('/support', '_blank'),
              type: 'secondary'
            }
          ]
        }
      ),

    deleteDefaultProject: (context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.PROJECT_DELETE_DEFAULT_PROJECT,
        'Cannot delete default project',
        'The default project cannot be deleted. Please select a different project to delete.',
        ErrorSeverity.MEDIUM,
        RecoveryStrategy.NONE,
        { context }
      ),

    validationFailed: (reason: string, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.PROJECT_DELETE_VALIDATION_FAILED,
        `Project deletion validation failed: ${reason}`,
        `Project deletion was blocked: ${reason}`,
        ErrorSeverity.MEDIUM,
        RecoveryStrategy.MANUAL_INTERVENTION,
        { context }
      )
  }

  /**
   * Create data isolation errors
   */
  static dataIsolation = {
    isolationFailed: (operation: string, cause?: Error, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.DATA_ISOLATION_FAILED,
        `Data isolation failed for operation: ${operation}`,
        'A data isolation error occurred. Your request could not be processed safely.',
        ErrorSeverity.HIGH,
        RecoveryStrategy.REFRESH,
        {
          context,
          cause,
          recoveryOptions: [
            {
              label: 'Refresh Page',
              action: () => window.location.reload(),
              type: 'primary'
            }
          ]
        }
      ),

    invalidProjectId: (projectId: any, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.INVALID_PROJECT_ID,
        `Invalid project ID: ${projectId}`,
        'The project ID is invalid. Please check the URL and try again.',
        ErrorSeverity.MEDIUM,
        RecoveryStrategy.REDIRECT,
        {
          context,
          recoveryOptions: [
            {
              label: 'Go to Projects',
              action: () => window.location.href = '/projects',
              type: 'primary'
            }
          ]
        }
      ),

    accessDenied: (projectRef: string, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.PROJECT_ACCESS_DENIED,
        `Access denied to project: ${projectRef}`,
        'You do not have permission to access this project\'s data.',
        ErrorSeverity.HIGH,
        RecoveryStrategy.CONTACT_SUPPORT,
        {
          context,
          recoveryOptions: [
            {
              label: 'Contact Admin',
              action: () => toast.info('Please contact your organization administrator for project access.'),
              type: 'primary'
            }
          ]
        }
      ),

    ownershipViolation: (details: string, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.DATA_OWNERSHIP_VIOLATION,
        `Data ownership violation: ${details}`,
        'A data security violation was detected. The operation was blocked for your protection.',
        ErrorSeverity.CRITICAL,
        RecoveryStrategy.CONTACT_SUPPORT,
        {
          context,
          recoveryOptions: [
            {
              label: 'Contact Support',
              action: () => window.open('/support', '_blank'),
              type: 'danger'
            }
          ]
        }
      ),

    queryFailed: (dataType: string, cause?: Error, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.DATA_QUERY_FAILED,
        `Failed to query ${dataType} data`,
        `Failed to load ${dataType} data. Please try again.`,
        ErrorSeverity.MEDIUM,
        RecoveryStrategy.RETRY,
        {
          context,
          cause,
          recoveryOptions: [
            {
              label: 'Retry',
              action: () => window.location.reload(),
              type: 'primary'
            }
          ]
        }
      ),

    crossProjectDataLeak: (details: string, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.CROSS_PROJECT_DATA_LEAK,
        `Cross-project data leak detected: ${details}`,
        'A data security issue was detected and prevented. The operation was blocked for your protection.',
        ErrorSeverity.CRITICAL,
        RecoveryStrategy.CONTACT_SUPPORT,
        {
          context,
          metadata: { details },
          recoveryOptions: [
            {
              label: 'Contact Support',
              action: () => window.open('/support', '_blank'),
              type: 'danger'
            }
          ]
        }
      )
  }

  /**
   * Create routing errors
   */
  static routing = {
    invalidProjectRef: (projectRef: string, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.INVALID_PROJECT_REF,
        `Invalid project reference: ${projectRef}`,
        'The project reference in the URL is invalid. Please check the URL and try again.',
        ErrorSeverity.MEDIUM,
        RecoveryStrategy.REDIRECT,
        {
          context,
          recoveryOptions: [
            {
              label: 'Go to Projects',
              action: () => window.location.href = '/projects',
              type: 'primary'
            }
          ]
        }
      ),

    settingsLoadFailed: (projectRef: string, cause?: Error, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.SETTINGS_LOAD_FAILED,
        `Failed to load settings for project: ${projectRef}`,
        'Failed to load project settings. Please try again or contact support if the problem persists.',
        ErrorSeverity.MEDIUM,
        RecoveryStrategy.RETRY,
        {
          context,
          cause,
          recoveryOptions: [
            {
              label: 'Retry',
              action: () => window.location.reload(),
              type: 'primary'
            },
            {
              label: 'Go Back',
              action: () => window.history.back(),
              type: 'secondary'
            }
          ]
        }
      ),

    sessionExpired: (context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.SESSION_EXPIRED,
        'User session has expired',
        'Your session has expired. Please log in again to continue.',
        ErrorSeverity.MEDIUM,
        RecoveryStrategy.REDIRECT,
        {
          context,
          recoveryOptions: [
            {
              label: 'Log In',
              action: () => window.location.href = '/sign-in',
              type: 'primary'
            }
          ]
        }
      )
  }

  /**
   * Create authentication/authorization errors
   */
  static auth = {
    notAuthenticated: (context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.USER_NOT_AUTHENTICATED,
        'User not authenticated',
        'You must be logged in to perform this action.',
        ErrorSeverity.HIGH,
        RecoveryStrategy.REDIRECT,
        {
          context,
          recoveryOptions: [
            {
              label: 'Log In',
              action: () => window.location.href = '/sign-in',
              type: 'primary'
            }
          ]
        }
      ),

    tokenMissing: (context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.TOKEN_MISSING,
        'Authentication token missing',
        'Authentication token is missing. Please log in again.',
        ErrorSeverity.HIGH,
        RecoveryStrategy.REDIRECT,
        {
          context,
          recoveryOptions: [
            {
              label: 'Log In',
              action: () => window.location.href = '/sign-in',
              type: 'primary'
            }
          ]
        }
      ),

    tokenInvalid: (context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.TOKEN_INVALID,
        'Authentication token invalid',
        'Your authentication token is invalid. Please log in again.',
        ErrorSeverity.HIGH,
        RecoveryStrategy.REDIRECT,
        {
          context,
          recoveryOptions: [
            {
              label: 'Log In',
              action: () => window.location.href = '/sign-in',
              type: 'primary'
            }
          ]
        }
      ),

    tokenExpired: (context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.TOKEN_EXPIRED,
        'Authentication token expired',
        'Your session has expired. Please log in again.',
        ErrorSeverity.MEDIUM,
        RecoveryStrategy.REDIRECT,
        {
          context,
          recoveryOptions: [
            {
              label: 'Log In',
              action: () => window.location.href = '/sign-in',
              type: 'primary'
            }
          ]
        }
      ),

    authenticationFailed: (reason: string, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.AUTHENTICATION_FAILED,
        `Authentication failed: ${reason}`,
        'Authentication failed. Please check your credentials and try again.',
        ErrorSeverity.HIGH,
        RecoveryStrategy.RETRY,
        {
          context,
          recoveryOptions: [
            {
              label: 'Try Again',
              action: () => window.location.reload(),
              type: 'primary'
            },
            {
              label: 'Log In',
              action: () => window.location.href = '/sign-in',
              type: 'secondary'
            }
          ]
        }
      ),

    insufficientPermissions: (resource: string, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Insufficient permissions for: ${resource}`,
        `You do not have permission to access ${resource}. Please contact your administrator.`,
        ErrorSeverity.HIGH,
        RecoveryStrategy.CONTACT_SUPPORT,
        {
          context,
          recoveryOptions: [
            {
              label: 'Contact Admin',
              action: () => toast.info('Please contact your organization administrator for access permissions.'),
              type: 'primary'
            }
          ]
        }
      ),

    organizationAccessDenied: (organizationId: number, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.ORGANIZATION_ACCESS_DENIED,
        `Access denied to organization: ${organizationId}`,
        'You do not have permission to access this organization\'s resources.',
        ErrorSeverity.HIGH,
        RecoveryStrategy.CONTACT_SUPPORT,
        {
          context,
          metadata: { organizationId },
          recoveryOptions: [
            {
              label: 'Contact Admin',
              action: () => toast.info('Please contact your organization administrator for access.'),
              type: 'primary'
            }
          ]
        }
      )
  }

  /**
   * Create validation errors
   */
  static validation = {
    invalidInput: (field: string, reason: string, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.INVALID_INPUT,
        `Invalid input for ${field}: ${reason}`,
        `Invalid ${field}: ${reason}`,
        ErrorSeverity.LOW,
        RecoveryStrategy.MANUAL_INTERVENTION,
        { context }
      ),

    missingRequiredField: (field: string, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.MISSING_REQUIRED_FIELD,
        `Missing required field: ${field}`,
        `${field} is required. Please provide a value.`,
        ErrorSeverity.LOW,
        RecoveryStrategy.MANUAL_INTERVENTION,
        { context }
      )
  }

  /**
   * Create generic errors
   */
  static generic = {
    internalServerError: (operation: string, cause?: Error, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.INTERNAL_SERVER_ERROR,
        `Internal server error during: ${operation}`,
        'An unexpected error occurred. Please try again or contact support if the problem persists.',
        ErrorSeverity.HIGH,
        RecoveryStrategy.RETRY,
        {
          context,
          cause,
          recoveryOptions: [
            {
              label: 'Try Again',
              action: () => window.location.reload(),
              type: 'primary'
            },
            {
              label: 'Contact Support',
              action: () => window.open('/support', '_blank'),
              type: 'secondary'
            }
          ]
        }
      ),

    networkError: (operation: string, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.NETWORK_ERROR,
        `Network error during: ${operation}`,
        'Network connection failed. Please check your internet connection and try again.',
        ErrorSeverity.MEDIUM,
        RecoveryStrategy.RETRY,
        {
          context,
          recoveryOptions: [
            {
              label: 'Retry',
              action: () => window.location.reload(),
              type: 'primary'
            }
          ]
        }
      ),

    timeoutError: (operation: string, context?: ErrorContext) =>
      new ProjectManagementError(
        ErrorCode.TIMEOUT_ERROR,
        `Timeout error during: ${operation}`,
        'The operation timed out. Please try again.',
        ErrorSeverity.MEDIUM,
        RecoveryStrategy.RETRY,
        {
          context,
          recoveryOptions: [
            {
              label: 'Try Again',
              action: () => window.location.reload(),
              type: 'primary'
            }
          ]
        }
      )
  }
}

/**
 * Error handler for API responses
 * Requirements: 6.1, 6.4, 6.5
 */
export function handleApiError(
  error: ProjectManagementError,
  res: NextApiResponse,
  context?: ErrorContext
): void {
  // Log the error (includes security audit logging)
  error.log()

  // Add context if provided
  if (context && !error.context) {
    error.context = context
  }

  // Determine HTTP status code based on error code
  let statusCode = 500
  switch (error.code) {
    case ErrorCode.PROJECT_NOT_FOUND:
    case ErrorCode.INVALID_PROJECT_REF:
      statusCode = 404
      break
    case ErrorCode.PROJECT_DELETE_FORBIDDEN:
    case ErrorCode.PROJECT_ACCESS_DENIED:
    case ErrorCode.INSUFFICIENT_PERMISSIONS:
    case ErrorCode.DATA_OWNERSHIP_VIOLATION:
    case ErrorCode.ORGANIZATION_ACCESS_DENIED:
    case ErrorCode.CROSS_PROJECT_DATA_LEAK:
      statusCode = 403
      break
    case ErrorCode.USER_NOT_AUTHENTICATED:
    case ErrorCode.SESSION_EXPIRED:
    case ErrorCode.TOKEN_MISSING:
    case ErrorCode.TOKEN_INVALID:
    case ErrorCode.TOKEN_EXPIRED:
    case ErrorCode.AUTHENTICATION_FAILED:
      statusCode = 401
      break
    case ErrorCode.INVALID_INPUT:
    case ErrorCode.MISSING_REQUIRED_FIELD:
    case ErrorCode.PROJECT_DELETE_VALIDATION_FAILED:
    case ErrorCode.INVALID_PROJECT_ID:
      statusCode = 400
      break
    default:
      statusCode = 500
  }

  // Send safe error response that doesn't leak sensitive information
  if (!res.headersSent) {
    res.status(statusCode).json(error.toApiResponse())
  }
}

/**
 * Error handler for client-side errors
 */
export function handleClientError(
  error: ProjectManagementError,
  options?: {
    showToast?: boolean
    showRecoveryOptions?: boolean
  }
): void {
  // Log the error
  error.log()

  // Show toast notification if requested
  if (options?.showToast !== false) {
    switch (error.severity) {
      case ErrorSeverity.CRITICAL:
      case ErrorSeverity.HIGH:
        toast.error(error.userMessage)
        break
      case ErrorSeverity.MEDIUM:
        toast.warning(error.userMessage)
        break
      case ErrorSeverity.LOW:
        toast.info(error.userMessage)
        break
    }
  }

  // Show recovery options if available and requested
  if (options?.showRecoveryOptions !== false && error.recoveryOptions?.length) {
    // This would typically integrate with a modal or notification system
    // For now, we'll just log the available recovery options
    console.info('Recovery options available:', error.recoveryOptions)
  }
}

/**
 * Utility to wrap async operations with error handling
 */
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  errorContext: ErrorContext,
  errorFactory: (cause: Error) => ProjectManagementError
): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    const error = errorFactory(cause as Error)
    error.context = { ...error.context, ...errorContext }
    throw error
  }
}

/**
 * Utility to create error context from request
 * Requirements: 6.2, 6.3
 */
export function createErrorContext(
  operation: string,
  options?: {
    userId?: string
    projectId?: number
    projectRef?: string
    endpoint?: string
    method?: string
    userAgent?: string
    ip?: string
    requestId?: string
  }
): ErrorContext {
  return {
    operation,
    ...options
  }
}

/**
 * Extract error context from Next.js API request
 * Requirements: 6.2, 6.3
 * 
 * @param req - Next.js API request
 * @param operation - Operation being performed
 * @param additionalContext - Additional context to include
 * @returns Error context object
 */
export function extractErrorContextFromRequest(
  req: any,
  operation: string,
  additionalContext?: {
    userId?: string
    projectId?: number
    projectRef?: string
  }
): ErrorContext {
  return createErrorContext(operation, {
    ...additionalContext,
    endpoint: req.url,
    method: req.method,
    userAgent: req.headers?.['user-agent'],
    ip: req.headers?.['x-forwarded-for'] || req.connection?.remoteAddress,
    requestId: req.headers?.['x-request-id']
  })
}