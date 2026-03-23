/**
 * SSL Error Handler for Database Connections
 * Requirements: 12.4, 12.5
 */

import { SSLError, SSLErrorResponse, SSLMode, SSLValidationResult } from './ssl-types'

/**
 * SSL Error Handler class for comprehensive SSL error management
 */
export class SSLErrorHandler {
  private static instance: SSLErrorHandler

  private constructor() {}

  static getInstance(): SSLErrorHandler {
    if (!SSLErrorHandler.instance) {
      SSLErrorHandler.instance = new SSLErrorHandler()
    }
    return SSLErrorHandler.instance
  }

  /**
   * Check if an error is SSL-related
   * Requirements: 12.4
   */
  isSSLError(error: any): boolean {
    if (!error || typeof error.message !== 'string') {
      return false
    }
    
    const sslErrorPatterns = [
      'server does not support ssl',
      'ssl connection',
      'ssl is not enabled',
      'sslmode',
      'certificate',
      'tls',
      'ssl handshake',
      'ssl_connect',
      'certificate verify failed',
      'self signed certificate',
      'unable to verify the first certificate',
      'certificate has expired',
      'hostname/ip does not match certificate',
      'ssl connection error',
      'ssl negotiation failed',
      'ssl protocol error'
    ]
    
    const errorMessage = error.message.toLowerCase()
    return sslErrorPatterns.some(pattern => errorMessage.includes(pattern))
  }

  /**
   * Categorize SSL error type
   * Requirements: 12.4
   */
  categorizeSSLError(error: any): SSLError {
    const message = error.message?.toLowerCase() || ''
    const sslError: SSLError = {
      ...error,
      name: 'SSLError',
      message: error.message
    }

    // Certificate-related errors
    if (message.includes('certificate') || message.includes('cert')) {
      sslError.certificateIssue = true
      
      if (message.includes('self signed')) {
        sslError.code = 'SELF_SIGNED_CERT'
      } else if (message.includes('expired')) {
        sslError.code = 'CERT_EXPIRED'
      } else if (message.includes('verify failed')) {
        sslError.code = 'CERT_VERIFY_FAILED'
      } else if (message.includes('hostname') || message.includes('ip does not match')) {
        sslError.code = 'CERT_HOSTNAME_MISMATCH'
      } else {
        sslError.code = 'CERT_ERROR'
      }
    }
    // Connection-related errors
    else if (message.includes('connection') || message.includes('connect') || message.includes('server does not support ssl')) {
      sslError.connectionRefused = true
      
      if (message.includes('server does not support ssl')) {
        sslError.code = 'SSL_NOT_SUPPORTED'
      } else if (message.includes('ssl connection error')) {
        sslError.code = 'SSL_CONNECTION_ERROR'
      } else {
        sslError.code = 'SSL_CONNECTION_FAILED'
      }
    }
    // Protocol-related errors
    else if (message.includes('protocol') || message.includes('handshake')) {
      sslError.code = 'SSL_PROTOCOL_ERROR'
    }
    // Generic SSL error
    else {
      sslError.code = 'SSL_ERROR'
    }

    return sslError
  }

  /**
   * Generate user-friendly error message with suggestions
   * Requirements: 12.4
   */
  generateErrorResponse(error: SSLError, projectRef: string, sslMode?: SSLMode): SSLErrorResponse {
    const suggestions: string[] = []
    let message = 'SSL connection failed'

    switch (error.code) {
      case 'SSL_NOT_SUPPORTED':
        message = 'The database server does not support SSL connections'
        suggestions.push('Try connecting without SSL by setting sslmode to "disable"')
        suggestions.push('Contact your database administrator to enable SSL support')
        break

      case 'SELF_SIGNED_CERT':
        message = 'SSL connection failed due to self-signed certificate'
        suggestions.push('Set sslmode to "require" to accept self-signed certificates')
        suggestions.push('Provide the CA certificate if available')
        suggestions.push('Use "prefer" mode to allow fallback to non-SSL')
        break

      case 'CERT_EXPIRED':
        message = 'SSL certificate has expired'
        suggestions.push('Contact your database administrator to renew the SSL certificate')
        suggestions.push('Temporarily use sslmode "disable" if SSL is not required')
        break

      case 'CERT_VERIFY_FAILED':
        message = 'SSL certificate verification failed'
        suggestions.push('Ensure the CA certificate is correctly configured')
        suggestions.push('Check if the certificate chain is complete')
        suggestions.push('Use sslmode "require" to skip certificate verification')
        break

      case 'CERT_HOSTNAME_MISMATCH':
        message = 'SSL certificate hostname does not match the connection hostname'
        suggestions.push('Verify the database hostname in your connection string')
        suggestions.push('Use the correct hostname that matches the certificate')
        suggestions.push('Use sslmode "require" to skip hostname verification')
        break

      case 'SSL_CONNECTION_ERROR':
        message = 'SSL connection could not be established'
        suggestions.push('Check if the database server supports SSL on the specified port')
        suggestions.push('Verify firewall settings allow SSL connections')
        suggestions.push('Try connecting without SSL to test basic connectivity')
        break

      case 'SSL_PROTOCOL_ERROR':
        message = 'SSL protocol negotiation failed'
        suggestions.push('Check if the SSL/TLS version is supported by both client and server')
        suggestions.push('Verify SSL configuration parameters')
        break

      default:
        message = error.message || 'Unknown SSL error occurred'
        suggestions.push('Check SSL configuration parameters')
        suggestions.push('Verify database server SSL settings')
        suggestions.push('Try connecting without SSL to isolate the issue')
    }

    return {
      success: false,
      error: {
        code: error.code || 'SSL_ERROR',
        message,
        sslMode,
        suggestions
      }
    }
  }

  /**
   * Log SSL error with detailed context
   * Requirements: 12.5
   */
  logSSLError(error: SSLError, context: {
    projectRef: string
    sslMode?: SSLMode
    connectionAttempt: number
    fallbackAttempted?: boolean
  }): void {
    const logData = {
      timestamp: new Date().toISOString(),
      level: 'error',
      category: 'ssl_connection',
      projectRef: context.projectRef,
      errorCode: error.code,
      errorMessage: error.message,
      sslMode: context.sslMode,
      connectionAttempt: context.connectionAttempt,
      fallbackAttempted: context.fallbackAttempted,
      certificateIssue: error.certificateIssue,
      connectionRefused: error.connectionRefused,
      stack: error.stack
    }

    // Log to console with structured format
    console.error('SSL Connection Error:', JSON.stringify(logData, null, 2))

    // In production, this could be sent to a logging service
    if (process.env.NODE_ENV === 'production') {
      // Example: Send to logging service
      // await this.sendToLoggingService(logData)
    }
  }

  /**
   * Validate SSL configuration
   * Requirements: 12.1, 12.2, 12.3
   */
  validateSSLConfig(sslConfig: any): SSLValidationResult {
    const result: SSLValidationResult = {
      isValid: true,
      sslEnabled: false,
      errors: [],
      warnings: []
    }

    // Handle boolean SSL config
    if (typeof sslConfig === 'boolean') {
      result.sslEnabled = sslConfig
      return result
    }

    // Handle string SSL mode
    if (typeof sslConfig === 'string') {
      const validModes: SSLMode[] = ['require', 'prefer', 'allow', 'disable', 'verify-ca', 'verify-full']
      if (!validModes.includes(sslConfig as SSLMode)) {
        result.isValid = false
        result.errors.push(`Invalid SSL mode: ${sslConfig}. Valid modes are: ${validModes.join(', ')}`)
      } else {
        result.sslEnabled = sslConfig !== 'disable'
        result.sslMode = sslConfig as SSLMode
      }
      return result
    }

    // Handle object SSL config
    if (typeof sslConfig === 'object' && sslConfig !== null && !Array.isArray(sslConfig)) {
      result.sslEnabled = true
      result.certificateInfo = {
        hasCaCert: !!sslConfig.ca,
        hasClientCert: !!sslConfig.cert,
        hasClientKey: !!sslConfig.key
      }

      // Validate certificate configuration
      if (sslConfig.cert && !sslConfig.key) {
        result.warnings.push('Client certificate provided without private key')
      }
      if (sslConfig.key && !sslConfig.cert) {
        result.warnings.push('Private key provided without client certificate')
      }

      // Validate rejectUnauthorized setting
      if ('rejectUnauthorized' in sslConfig && typeof sslConfig.rejectUnauthorized !== 'boolean') {
        result.errors.push('rejectUnauthorized must be a boolean value')
        result.isValid = false
      }

      return result
    }

    // Invalid SSL config type
    if (sslConfig === null) {
      result.isValid = false
      result.errors.push('SSL configuration cannot be null')
      return result
    }
    
    result.isValid = false
    result.errors.push('SSL configuration must be boolean, string, or object')
    return result
  }

  /**
   * Get SSL configuration recommendations
   * Requirements: 12.1, 12.2
   */
  getSSLRecommendations(environment: 'development' | 'production' | 'test'): {
    recommended: SSLMode
    alternatives: SSLMode[]
    reasoning: string
  } {
    switch (environment) {
      case 'production':
        return {
          recommended: 'verify-full',
          alternatives: ['verify-ca', 'require'],
          reasoning: 'Production environments should use the highest level of SSL security with full certificate verification'
        }

      case 'development':
        return {
          recommended: 'prefer',
          alternatives: ['require', 'disable'],
          reasoning: 'Development environments can use prefer mode to allow SSL when available but fallback to non-SSL'
        }

      case 'test':
        return {
          recommended: 'disable',
          alternatives: ['prefer', 'require'],
          reasoning: 'Test environments typically prioritize speed and simplicity over SSL security'
        }

      default:
        return {
          recommended: 'prefer',
          alternatives: ['require', 'disable'],
          reasoning: 'Default recommendation balances security and compatibility'
        }
    }
  }
}

/**
 * Factory function to get the SSL error handler
 */
export function getSSLErrorHandler(): SSLErrorHandler {
  return SSLErrorHandler.getInstance()
}