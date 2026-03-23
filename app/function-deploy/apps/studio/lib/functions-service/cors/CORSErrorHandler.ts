/**
 * CORS Error Handler for Edge Functions
 * 
 * Provides comprehensive error handling and user-friendly error messages for CORS issues.
 * Implements detailed logging and diagnostic information for troubleshooting.
 * 
 * Requirements: 22.1, 22.2, 22.3, 22.4
 */

import { CORSError } from './CORSConfigurationService'

/**
 * CORS error types with detailed information
 */
export interface DetailedCORSError extends CORSError {
  timestamp: string
  requestId?: string
  userAgent?: string
  referer?: string
  troubleshootingSteps: string[]
  configurationSuggestions: string[]
}

/**
 * CORS error logging interface
 */
export interface CORSErrorLog {
  timestamp: string
  level: 'error' | 'warning' | 'info'
  type: CORSError['type']
  message: string
  details: {
    origin?: string
    method?: string
    headers?: string[]
    userAgent?: string
    referer?: string
    requestId?: string
  }
  troubleshooting: {
    steps: string[]
    suggestions: string[]
    documentation?: string[]
  }
}

/**
 * CORS Error Handler Service
 */
export class CORSErrorHandler {
  private static instance: CORSErrorHandler | null = null
  private errorLogs: CORSErrorLog[] = []
  private maxLogEntries = 1000

  /**
   * Get singleton instance
   */
  static getInstance(): CORSErrorHandler {
    if (!CORSErrorHandler.instance) {
      CORSErrorHandler.instance = new CORSErrorHandler()
    }
    return CORSErrorHandler.instance
  }

  /**
   * Handle CORS origin not allowed error
   */
  handleOriginNotAllowed(origin: string, requestDetails?: any): DetailedCORSError {
    const error: DetailedCORSError = {
      type: 'ORIGIN_NOT_ALLOWED',
      origin,
      message: `Origin '${origin}' is not allowed by CORS policy`,
      timestamp: new Date().toISOString(),
      userAgent: requestDetails?.userAgent,
      referer: requestDetails?.referer,
      troubleshootingSteps: [
        'Check if the origin is included in EDGE_FUNCTIONS_CORS_ALLOWED_ORIGINS environment variable',
        'Verify that Studio is running on the expected port and protocol',
        'Ensure the origin matches exactly (including protocol, hostname, and port)',
        'Check for typos in the environment variable configuration',
      ],
      configurationSuggestions: [
        `Add '${origin}' to EDGE_FUNCTIONS_CORS_ALLOWED_ORIGINS`,
        'For development, consider adding common origins: http://localhost:3000,http://localhost:8080',
        'For production, use the exact Studio URL without trailing slashes',
        'Avoid using wildcard (*) with credentials for security reasons',
      ],
    }

    this.logError(error, requestDetails)
    return error
  }

  /**
   * Handle CORS header not allowed error
   */
  handleHeaderNotAllowed(header: string, origin?: string, requestDetails?: any): DetailedCORSError {
    const error: DetailedCORSError = {
      type: 'HEADER_NOT_ALLOWED',
      header,
      origin,
      message: `Header '${header}' is not allowed by CORS policy`,
      timestamp: new Date().toISOString(),
      userAgent: requestDetails?.userAgent,
      referer: requestDetails?.referer,
      troubleshootingSteps: [
        'Check if the header is included in EDGE_FUNCTIONS_CORS_ALLOWED_HEADERS environment variable',
        'Verify that all required headers are listed in the configuration',
        'Check for case sensitivity issues (headers should be lowercase)',
        'Ensure user-agent header is included if Studio requests are failing',
      ],
      configurationSuggestions: [
        `Add '${header.toLowerCase()}' to EDGE_FUNCTIONS_CORS_ALLOWED_HEADERS`,
        'Include common headers: user-agent,content-type,authorization,x-client-info,apikey',
        'For Studio compatibility, ensure these headers are allowed: user-agent,x-supabase-api-version',
        'Use lowercase header names in the configuration',
      ],
    }

    this.logError(error, requestDetails)
    return error
  }

  /**
   * Handle CORS method not allowed error
   */
  handleMethodNotAllowed(method: string, origin?: string, requestDetails?: any): DetailedCORSError {
    const error: DetailedCORSError = {
      type: 'METHOD_NOT_ALLOWED',
      method,
      origin,
      message: `Method '${method}' is not allowed by CORS policy`,
      timestamp: new Date().toISOString(),
      userAgent: requestDetails?.userAgent,
      referer: requestDetails?.referer,
      troubleshootingSteps: [
        'Check if the method is included in EDGE_FUNCTIONS_CORS_ALLOWED_METHODS environment variable',
        'Verify that OPTIONS method is included for preflight requests',
        'Ensure all required HTTP methods are listed in the configuration',
        'Check for case sensitivity issues (methods should be uppercase)',
      ],
      configurationSuggestions: [
        `Add '${method.toUpperCase()}' to EDGE_FUNCTIONS_CORS_ALLOWED_METHODS`,
        'Include all necessary methods: GET,POST,PUT,DELETE,OPTIONS,HEAD',
        'Always include OPTIONS method for preflight request handling',
        'Use uppercase method names in the configuration',
      ],
    }

    this.logError(error, requestDetails)
    return error
  }

  /**
   * Handle general CORS error
   */
  handleGeneralError(message: string, requestDetails?: any): DetailedCORSError {
    const error: DetailedCORSError = {
      type: 'GENERAL',
      message: `CORS error: ${message}`,
      timestamp: new Date().toISOString(),
      userAgent: requestDetails?.userAgent,
      referer: requestDetails?.referer,
      troubleshootingSteps: [
        'Check Edge Functions service is running and accessible',
        'Verify CORS configuration environment variables are set correctly',
        'Check browser developer tools for detailed CORS error messages',
        'Ensure Studio and Edge Functions service can communicate',
      ],
      configurationSuggestions: [
        'Review all CORS environment variables: EDGE_FUNCTIONS_CORS_ALLOWED_ORIGINS, EDGE_FUNCTIONS_CORS_ALLOWED_HEADERS, EDGE_FUNCTIONS_CORS_ALLOWED_METHODS',
        'Check Docker Compose configuration for proper service networking',
        'Verify that Edge Functions service is healthy using the health endpoint',
        'Consider using CORS diagnostics endpoint for detailed configuration validation',
      ],
    }

    this.logError(error, requestDetails)
    return error
  }

  /**
   * Log CORS error with detailed information
   */
  private logError(error: DetailedCORSError, requestDetails?: any): void {
    const logEntry: CORSErrorLog = {
      timestamp: error.timestamp,
      level: 'error',
      type: error.type,
      message: error.message,
      details: {
        origin: error.origin,
        method: error.method,
        headers: requestDetails?.headers,
        userAgent: error.userAgent,
        referer: error.referer,
        requestId: error.requestId,
      },
      troubleshooting: {
        steps: error.troubleshootingSteps,
        suggestions: error.configurationSuggestions,
        documentation: [
          'https://supabase.com/docs/guides/self-hosting/docker#edge-functions',
          'https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS',
        ],
      },
    }

    // Add to in-memory log
    this.errorLogs.unshift(logEntry)
    
    // Trim logs if too many
    if (this.errorLogs.length > this.maxLogEntries) {
      this.errorLogs = this.errorLogs.slice(0, this.maxLogEntries)
    }

    // Console logging with structured format
    console.error('[CORS Error Handler]', {
      type: error.type,
      message: error.message,
      origin: error.origin,
      method: error.method,
      header: error.header,
      userAgent: error.userAgent,
      timestamp: error.timestamp,
      troubleshootingSteps: error.troubleshootingSteps.length,
      suggestions: error.configurationSuggestions.length,
    })

    // Detailed console log for debugging
    console.error('[CORS Error Handler] Troubleshooting steps:', error.troubleshootingSteps)
    console.error('[CORS Error Handler] Configuration suggestions:', error.configurationSuggestions)
  }

  /**
   * Log CORS warning
   */
  logWarning(message: string, details?: any): void {
    const logEntry: CORSErrorLog = {
      timestamp: new Date().toISOString(),
      level: 'warning',
      type: 'GENERAL',
      message,
      details: details || {},
      troubleshooting: {
        steps: ['Review CORS configuration'],
        suggestions: ['Check environment variables'],
      },
    }

    this.errorLogs.unshift(logEntry)
    
    if (this.errorLogs.length > this.maxLogEntries) {
      this.errorLogs = this.errorLogs.slice(0, this.maxLogEntries)
    }

    console.warn('[CORS Warning]', message, details)
  }

  /**
   * Log CORS info
   */
  logInfo(message: string, details?: any): void {
    const logEntry: CORSErrorLog = {
      timestamp: new Date().toISOString(),
      level: 'info',
      type: 'GENERAL',
      message,
      details: details || {},
      troubleshooting: {
        steps: [],
        suggestions: [],
      },
    }

    this.errorLogs.unshift(logEntry)
    
    if (this.errorLogs.length > this.maxLogEntries) {
      this.errorLogs = this.errorLogs.slice(0, this.maxLogEntries)
    }

    console.info('[CORS Info]', message, details)
  }

  /**
   * Get recent error logs
   */
  getRecentLogs(limit = 50): CORSErrorLog[] {
    return this.errorLogs.slice(0, limit)
  }

  /**
   * Get error logs by type
   */
  getLogsByType(type: CORSError['type'], limit = 50): CORSErrorLog[] {
    return this.errorLogs
      .filter(log => log.type === type)
      .slice(0, limit)
  }

  /**
   * Get error statistics
   */
  getErrorStatistics(): {
    total: number
    byType: Record<CORSError['type'], number>
    byLevel: Record<'error' | 'warning' | 'info', number>
    recentErrors: number // Last hour
  } {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    
    const stats = {
      total: this.errorLogs.length,
      byType: {
        'ORIGIN_NOT_ALLOWED': 0,
        'HEADER_NOT_ALLOWED': 0,
        'METHOD_NOT_ALLOWED': 0,
        'GENERAL': 0,
      } as Record<CORSError['type'], number>,
      byLevel: {
        'error': 0,
        'warning': 0,
        'info': 0,
      },
      recentErrors: 0,
    }

    for (const log of this.errorLogs) {
      stats.byType[log.type]++
      stats.byLevel[log.level]++
      
      if (new Date(log.timestamp) > oneHourAgo) {
        stats.recentErrors++
      }
    }

    return stats
  }

  /**
   * Clear error logs
   */
  clearLogs(): void {
    this.errorLogs = []
    console.info('[CORS Error Handler] Error logs cleared')
  }

  /**
   * Generate user-friendly error message for Studio UI
   */
  generateUserFriendlyMessage(error: DetailedCORSError): {
    title: string
    message: string
    actions: Array<{ label: string; action: string }>
  } {
    switch (error.type) {
      case 'ORIGIN_NOT_ALLOWED':
        return {
          title: 'CORS Origin Not Allowed',
          message: `The Studio interface cannot access Edge Functions because the origin '${error.origin}' is not allowed. This is a CORS (Cross-Origin Resource Sharing) configuration issue.`,
          actions: [
            { label: 'Check CORS Configuration', action: 'open-cors-diagnostics' },
            { label: 'View Documentation', action: 'open-cors-docs' },
            { label: 'Copy Configuration Example', action: 'copy-cors-config' },
          ],
        }

      case 'HEADER_NOT_ALLOWED':
        return {
          title: 'CORS Header Not Allowed',
          message: `The request header '${error.header}' is not allowed by the CORS policy. This prevents Studio from communicating with Edge Functions.`,
          actions: [
            { label: 'Check Header Configuration', action: 'open-cors-diagnostics' },
            { label: 'View Required Headers', action: 'show-required-headers' },
            { label: 'Copy Header Configuration', action: 'copy-header-config' },
          ],
        }

      case 'METHOD_NOT_ALLOWED':
        return {
          title: 'CORS Method Not Allowed',
          message: `The HTTP method '${error.method}' is not allowed by the CORS policy. This prevents certain Edge Functions operations from working.`,
          actions: [
            { label: 'Check Method Configuration', action: 'open-cors-diagnostics' },
            { label: 'View Required Methods', action: 'show-required-methods' },
            { label: 'Copy Method Configuration', action: 'copy-method-config' },
          ],
        }

      default:
        return {
          title: 'CORS Configuration Error',
          message: 'There is a CORS configuration issue preventing Studio from accessing Edge Functions. This typically happens in self-hosted environments.',
          actions: [
            { label: 'Run CORS Diagnostics', action: 'open-cors-diagnostics' },
            { label: 'View Troubleshooting Guide', action: 'open-troubleshooting' },
            { label: 'Check Service Status', action: 'check-service-health' },
          ],
        }
    }
  }
}

/**
 * Get singleton CORS error handler instance
 */
export function getCORSErrorHandler(): CORSErrorHandler {
  return CORSErrorHandler.getInstance()
}

/**
 * Create and handle CORS error with comprehensive logging
 */
export function handleCORSError(
  type: CORSError['type'],
  message: string,
  details?: {
    origin?: string
    header?: string
    method?: string
    userAgent?: string
    referer?: string
    requestId?: string
  }
): DetailedCORSError {
  const errorHandler = getCORSErrorHandler()

  switch (type) {
    case 'ORIGIN_NOT_ALLOWED':
      return errorHandler.handleOriginNotAllowed(details?.origin || 'unknown', details)
    
    case 'HEADER_NOT_ALLOWED':
      return errorHandler.handleHeaderNotAllowed(details?.header || 'unknown', details?.origin, details)
    
    case 'METHOD_NOT_ALLOWED':
      return errorHandler.handleMethodNotAllowed(details?.method || 'unknown', details?.origin, details)
    
    default:
      return errorHandler.handleGeneralError(message, details)
  }
}

/**
 * Validate CORS configuration at startup and log warnings
 */
export function validateCORSConfigurationAtStartup(): void {
  const errorHandler = getCORSErrorHandler()

  // Check environment variables
  const requiredEnvVars = [
    'EDGE_FUNCTIONS_CORS_ALLOWED_ORIGINS',
    'EDGE_FUNCTIONS_CORS_ALLOWED_HEADERS',
    'EDGE_FUNCTIONS_CORS_ALLOWED_METHODS',
  ]

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      errorHandler.logWarning(`CORS environment variable ${envVar} is not set, using defaults`, {
        variable: envVar,
        suggestion: `Set ${envVar} environment variable for explicit CORS configuration`,
      })
    }
  }

  // Check for common configuration issues
  const origins = process.env.EDGE_FUNCTIONS_CORS_ALLOWED_ORIGINS
  if (origins && origins.includes('*') && origins.includes('localhost')) {
    errorHandler.logWarning('CORS configuration includes both wildcard (*) and specific origins', {
      suggestion: 'Use either wildcard or specific origins, not both',
    })
  }

  const headers = process.env.EDGE_FUNCTIONS_CORS_ALLOWED_HEADERS
  if (headers && !headers.toLowerCase().includes('user-agent')) {
    errorHandler.logWarning('user-agent header not found in CORS allowed headers', {
      suggestion: 'Add user-agent to EDGE_FUNCTIONS_CORS_ALLOWED_HEADERS to prevent Studio access issues',
    })
  }

  const methods = process.env.EDGE_FUNCTIONS_CORS_ALLOWED_METHODS
  if (methods && !methods.toUpperCase().includes('OPTIONS')) {
    errorHandler.logWarning('OPTIONS method not found in CORS allowed methods', {
      suggestion: 'Add OPTIONS to EDGE_FUNCTIONS_CORS_ALLOWED_METHODS for preflight request support',
    })
  }

  errorHandler.logInfo('CORS configuration validation completed at startup')
}