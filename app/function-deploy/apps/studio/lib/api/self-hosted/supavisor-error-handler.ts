/**
 * Comprehensive error handling utilities for Supavisor configuration
 */

export type SupavisorErrorType = 
  | 'missing-config'
  | 'service-unavailable' 
  | 'configuration-invalid'
  | 'network-error'
  | 'permission-denied'
  | 'timeout'
  | 'unknown'

export interface SupavisorError extends Error {
  type: SupavisorErrorType
  code?: string
  details?: Record<string, any>
  suggestions?: string[]
}

export class SupavisorErrorHandler {
  /**
   * Create a standardized Supavisor error
   */
  static createError(
    type: SupavisorErrorType,
    message: string,
    originalError?: Error,
    details?: Record<string, any>
  ): SupavisorError {
    const error = new Error(message) as SupavisorError
    error.type = type
    error.details = details
    error.suggestions = this.getSuggestions(type)
    
    if (originalError) {
      error.stack = originalError.stack
      error.cause = originalError
    }
    
    return error
  }

  /**
   * Analyze an error and determine its type and appropriate handling
   */
  static analyzeError(error: Error | unknown): SupavisorError {
    if (this.isSupavisorError(error)) {
      return error
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : undefined

    // Environment variable errors
    if (errorMessage.includes('POOLER_TENANT_ID') || 
        errorMessage.includes('environment variable') ||
        errorMessage.includes('not properly configured')) {
      return this.createError(
        'missing-config',
        'Required Supavisor environment variables are missing or invalid',
        error instanceof Error ? error : undefined,
        { originalMessage: errorMessage }
      )
    }

    // Service unavailable errors
    if (errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('service is not running') ||
        errorMessage.includes('container') ||
        errorMessage.includes('Connection refused')) {
      return this.createError(
        'service-unavailable',
        'Supavisor service is not running or not accessible',
        error instanceof Error ? error : undefined,
        { originalMessage: errorMessage }
      )
    }

    // Network/timeout errors
    if (errorMessage.includes('timeout') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('AbortError') ||
        errorMessage.includes('network')) {
      return this.createError(
        'network-error',
        'Network timeout or connection error when accessing Supavisor',
        error instanceof Error ? error : undefined,
        { originalMessage: errorMessage }
      )
    }

    // Configuration validation errors
    if (errorMessage.includes('must be greater than 0') ||
        errorMessage.includes('invalid') ||
        errorMessage.includes('validation')) {
      return this.createError(
        'configuration-invalid',
        'Supavisor configuration contains invalid values',
        error instanceof Error ? error : undefined,
        { originalMessage: errorMessage }
      )
    }

    // Permission errors
    if (errorMessage.includes('permission') ||
        errorMessage.includes('unauthorized') ||
        errorMessage.includes('403') ||
        errorMessage.includes('401')) {
      return this.createError(
        'permission-denied',
        'Insufficient permissions to access Supavisor configuration',
        error instanceof Error ? error : undefined,
        { originalMessage: errorMessage }
      )
    }

    // Default to unknown error
    return this.createError(
      'unknown',
      `Unexpected error: ${errorMessage}`,
      error instanceof Error ? error : undefined,
      { originalMessage: errorMessage }
    )
  }

  /**
   * Check if an error is already a SupavisorError
   */
  static isSupavisorError(error: any): error is SupavisorError {
    return error && typeof error === 'object' && 'type' in error && 'suggestions' in error
  }

  /**
   * Get user-friendly suggestions based on error type
   */
  static getSuggestions(type: SupavisorErrorType): string[] {
    switch (type) {
      case 'missing-config':
        return [
          'Check that all required environment variables are set in your .env file',
          'Ensure POOLER_TENANT_ID is not set to the default placeholder value',
          'Verify that numeric values (pool sizes, ports) are valid numbers',
          'Restart your Docker containers after updating environment variables'
        ]

      case 'service-unavailable':
        return [
          'Check if the Supavisor Docker container is running',
          'Verify the container is healthy and not in a restart loop',
          'Check Docker logs for Supavisor startup errors',
          'Ensure the management port (4000) is not blocked by firewall',
          'Try restarting the Supavisor container'
        ]

      case 'configuration-invalid':
        return [
          'Ensure pool size values are positive integers',
          'Check that port numbers are valid (1024-65535)',
          'Verify tenant ID format matches requirements',
          'Review the Supavisor configuration documentation'
        ]

      case 'network-error':
        return [
          'Check your network connection',
          'Verify Supavisor service is accessible on the expected ports',
          'Try refreshing the page after a few moments',
          'Check if there are any firewall rules blocking the connection'
        ]

      case 'permission-denied':
        return [
          'Ensure you have administrator privileges',
          'Check that the Docker daemon is accessible',
          'Verify file permissions for configuration files',
          'Contact your system administrator if the issue persists'
        ]

      case 'timeout':
        return [
          'The Supavisor service may be starting up - wait a few moments and try again',
          'Check if the service is under heavy load',
          'Verify network connectivity to the service',
          'Consider increasing timeout values if this persists'
        ]

      default:
        return [
          'Try refreshing the page',
          'Check the browser console for additional error details',
          'Verify your Supabase self-hosted setup is complete',
          'Contact support if the issue persists'
        ]
    }
  }

  /**
   * Get a user-friendly error message for display
   */
  static getUserFriendlyMessage(error: SupavisorError): string {
    switch (error.type) {
      case 'missing-config':
        return 'Supavisor is not configured. Please set up the required environment variables to enable connection pooling.'

      case 'service-unavailable':
        return 'The Supavisor connection pooling service is not running. Please check your Docker setup and ensure the service is started.'

      case 'configuration-invalid':
        return 'The Supavisor configuration contains invalid values. Please check your environment variables and correct any issues.'

      case 'network-error':
        return 'Unable to connect to the Supavisor service. This may be a temporary network issue - please try again.'

      case 'permission-denied':
        return 'You do not have sufficient permissions to access the Supavisor configuration. Please contact your administrator.'

      case 'timeout':
        return 'The request to Supavisor timed out. The service may be starting up or under heavy load.'

      default:
        return error.message || 'An unexpected error occurred while accessing Supavisor configuration.'
    }
  }

  /**
   * Determine if an error is recoverable (user can retry)
   */
  static isRecoverable(error: SupavisorError): boolean {
    switch (error.type) {
      case 'network-error':
      case 'timeout':
      case 'service-unavailable':
        return true
      
      case 'missing-config':
      case 'configuration-invalid':
      case 'permission-denied':
        return false
      
      default:
        return true
    }
  }

  /**
   * Get appropriate retry delay in milliseconds
   */
  static getRetryDelay(error: SupavisorError, attemptNumber: number): number {
    const baseDelay = 1000 // 1 second
    const maxDelay = 30000 // 30 seconds
    
    switch (error.type) {
      case 'network-error':
      case 'timeout':
        // Exponential backoff for network issues
        return Math.min(baseDelay * Math.pow(2, attemptNumber), maxDelay)
      
      case 'service-unavailable':
        // Longer delay for service issues
        return Math.min(baseDelay * 3 * attemptNumber, maxDelay)
      
      default:
        return baseDelay
    }
  }

  /**
   * Log error with appropriate level and context
   */
  static logError(error: SupavisorError, context?: Record<string, any>): void {
    const logContext = {
      type: error.type,
      message: error.message,
      details: error.details,
      suggestions: error.suggestions,
      ...context
    }

    switch (error.type) {
      case 'missing-config':
      case 'configuration-invalid':
        console.warn('Supavisor configuration issue:', logContext)
        break
      
      case 'service-unavailable':
      case 'network-error':
      case 'timeout':
        console.error('Supavisor service issue:', logContext)
        break
      
      case 'permission-denied':
        console.error('Supavisor permission issue:', logContext)
        break
      
      default:
        console.error('Supavisor unknown error:', logContext)
    }
  }
}