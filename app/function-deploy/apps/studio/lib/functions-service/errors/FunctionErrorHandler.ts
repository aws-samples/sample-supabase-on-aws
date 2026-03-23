import { StorageBackendError, StorageNotFoundError } from '../storage/StorageBackend'

/**
 * Function code error interface (to avoid circular imports)
 */
interface FunctionCodeError extends Error {
  code: string
  message: string
  details?: any
  fallbackData?: any
}

/**
 * Error severity levels
 */
export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical'

/**
 * Error category for better classification
 */
export type ErrorCategory = 
  | 'storage' 
  | 'network' 
  | 'permission' 
  | 'validation' 
  | 'configuration' 
  | 'runtime' 
  | 'unknown'

/**
 * User feedback information
 */
export interface UserFeedback {
  /** User-friendly error message */
  message: string
  /** Detailed explanation of what went wrong */
  explanation: string
  /** Suggested actions to resolve the issue */
  suggestions: string[]
  /** Whether the error is recoverable */
  recoverable: boolean
  /** Estimated time to resolution */
  estimatedResolution?: string
  /** Support contact information if needed */
  supportInfo?: string
}

/**
 * Enhanced error information
 */
export interface EnhancedErrorInfo {
  /** Original error */
  originalError: Error
  /** Error code for programmatic handling */
  code: string
  /** Error category */
  category: ErrorCategory
  /** Error severity */
  severity: ErrorSeverity
  /** User feedback */
  userFeedback: UserFeedback
  /** Technical details for debugging */
  technicalDetails: Record<string, any>
  /** Retry information */
  retryInfo?: {
    retryable: boolean
    maxRetries: number
    retryDelay: number
    backoffMultiplier: number
  }
}

/**
 * Enhanced Function Error Handler
 * 
 * Provides comprehensive error handling with specific error messages,
 * graceful degradation, and clear user feedback for code display issues.
 */
export class FunctionErrorHandler {
  
  /**
   * Handle function code retrieval errors with enhanced feedback
   * 
   * @param error - Original error
   * @param context - Error context
   * @returns Enhanced error information
   */
  handleCodeRetrievalError(
    error: any,
    context: {
      projectRef: string
      functionSlug: string
      operation: string
      storageType?: string
    }
  ): EnhancedErrorInfo {
    const { projectRef, functionSlug, operation, storageType = 'unknown' } = context

    // Handle FunctionCodeError (check for code property instead of instanceof)
    if (error && typeof error === 'object' && 'code' in error && error.code) {
      return this.handleFunctionCodeError(error, context)
    }

    // Handle StorageNotFoundError
    if (error instanceof StorageNotFoundError) {
      return {
        originalError: error,
        code: 'FUNCTION_NOT_FOUND',
        category: 'storage',
        severity: 'medium',
        userFeedback: {
          message: `Function '${functionSlug}' not found`,
          explanation: `The function '${functionSlug}' does not exist in project '${projectRef}' or has been deleted.`,
          suggestions: [
            'Verify the function name is correct',
            'Check if the function has been deployed',
            'Refresh the page to see the latest functions',
            'Deploy the function if it doesn\'t exist'
          ],
          recoverable: true,
          estimatedResolution: '1-2 minutes',
        },
        technicalDetails: {
          projectRef,
          functionSlug,
          operation,
          storageType,
          errorType: 'StorageNotFoundError',
        },
        retryInfo: {
          retryable: true,
          maxRetries: 3,
          retryDelay: 2000,
          backoffMultiplier: 1.5,
        }
      }
    }

    // Handle StorageBackendError
    if (error instanceof StorageBackendError) {
      return this.handleStorageBackendError(error, context)
    }

    // Handle network errors
    if (this.isNetworkError(error)) {
      return this.handleNetworkError(error, context)
    }

    // Handle permission errors
    if (this.isPermissionError(error)) {
      return this.handlePermissionError(error, context)
    }

    // Handle timeout errors
    if (this.isTimeoutError(error)) {
      return this.handleTimeoutError(error, context)
    }

    // Handle validation errors
    if (this.isValidationError(error)) {
      return this.handleValidationError(error, context)
    }

    // Handle generic errors
    return this.handleGenericError(error, context)
  }

  /**
   * Handle function metadata retrieval errors
   * 
   * @param error - Original error
   * @param context - Error context
   * @returns Enhanced error information
   */
  handleMetadataRetrievalError(
    error: any,
    context: {
      projectRef: string
      functionSlug: string
      operation: string
    }
  ): EnhancedErrorInfo {
    if (error instanceof StorageNotFoundError) {
      return {
        originalError: error,
        code: 'METADATA_NOT_FOUND',
        category: 'storage',
        severity: 'low',
        userFeedback: {
          message: 'Function metadata unavailable',
          explanation: 'The function metadata could not be retrieved, but the function may still be accessible.',
          suggestions: [
            'The function will use default metadata',
            'Try redeploying the function to regenerate metadata',
            'Check if the function was deployed correctly'
          ],
          recoverable: true,
          estimatedResolution: 'Immediate (using fallback)',
        },
        technicalDetails: {
          ...context,
          errorType: 'MetadataNotFound',
          fallbackUsed: true,
        },
        retryInfo: {
          retryable: true,
          maxRetries: 2,
          retryDelay: 1000,
          backoffMultiplier: 2,
        }
      }
    }

    return this.handleCodeRetrievalError(error, { ...context, storageType: 'metadata' })
  }

  /**
   * Handle function list retrieval errors
   * 
   * @param error - Original error
   * @param context - Error context
   * @returns Enhanced error information
   */
  handleListRetrievalError(
    error: any,
    context: {
      projectRef: string
      operation: string
    }
  ): EnhancedErrorInfo {
    const baseContext = { ...context, functionSlug: 'all' }

    if (this.isTimeoutError(error)) {
      return {
        originalError: error,
        code: 'FUNCTION_LIST_TIMEOUT',
        category: 'network',
        severity: 'medium',
        userFeedback: {
          message: 'Function list loading timed out',
          explanation: 'The request to load the function list took too long and timed out.',
          suggestions: [
            'Try refreshing the page',
            'Check your network connection',
            'The storage backend may be experiencing high load'
          ],
          recoverable: true,
          estimatedResolution: '30 seconds to 2 minutes',
        },
        technicalDetails: {
          ...baseContext,
          errorType: 'ListTimeout',
          timeout: true,
        },
        retryInfo: {
          retryable: true,
          maxRetries: 3,
          retryDelay: 5000,
          backoffMultiplier: 2,
        }
      }
    }

    return this.handleCodeRetrievalError(error, baseContext)
  }

  /**
   * Create user-friendly error message for display
   * 
   * @param errorInfo - Enhanced error information
   * @returns User-friendly error message
   */
  createUserFriendlyMessage(errorInfo: EnhancedErrorInfo): string {
    const { userFeedback, severity } = errorInfo
    
    let prefix = ''
    switch (severity) {
      case 'critical':
        prefix = '🚨 Critical Error: '
        break
      case 'high':
        prefix = '⚠️ Error: '
        break
      case 'medium':
        prefix = '⚠️ '
        break
      case 'low':
        prefix = 'ℹ️ '
        break
    }

    return `${prefix}${userFeedback.message}`
  }

  /**
   * Get suggested actions for error resolution
   * 
   * @param errorInfo - Enhanced error information
   * @returns Array of suggested actions
   */
  getSuggestedActions(errorInfo: EnhancedErrorInfo): string[] {
    return errorInfo.userFeedback.suggestions
  }

  /**
   * Check if error is retryable
   * 
   * @param errorInfo - Enhanced error information
   * @returns Whether the error is retryable
   */
  isRetryable(errorInfo: EnhancedErrorInfo): boolean {
    return errorInfo.retryInfo?.retryable ?? false
  }

  /**
   * Get retry configuration
   * 
   * @param errorInfo - Enhanced error information
   * @returns Retry configuration
   */
  getRetryConfig(errorInfo: EnhancedErrorInfo): {
    maxRetries: number
    retryDelay: number
    backoffMultiplier: number
  } | null {
    if (!errorInfo.retryInfo?.retryable) {
      return null
    }

    return {
      maxRetries: errorInfo.retryInfo.maxRetries,
      retryDelay: errorInfo.retryInfo.retryDelay,
      backoffMultiplier: errorInfo.retryInfo.backoffMultiplier,
    }
  }

  /**
   * Handle FunctionCodeError specifically
   */
  private handleFunctionCodeError(
    error: FunctionCodeError,
    context: { projectRef: string; functionSlug: string; operation: string }
  ): EnhancedErrorInfo {
    const severity = this.getSeverityForCode(error.code)
    const category = this.getCategoryForCode(error.code)

    return {
      originalError: error,
      code: error.code,
      category,
      severity,
      userFeedback: this.getUserFeedbackForCode(error.code, context, error.details),
      technicalDetails: {
        ...context,
        errorCode: error.code,
        errorDetails: error.details,
        errorType: 'FunctionCodeError',
      },
      retryInfo: this.getRetryInfoForCode(error.code),
    }
  }

  /**
   * Handle StorageBackendError
   */
  private handleStorageBackendError(
    error: StorageBackendError,
    context: { projectRef: string; functionSlug: string; operation: string; storageType?: string }
  ): EnhancedErrorInfo {
    return {
      originalError: error,
      code: error.code || 'STORAGE_ERROR',
      category: 'storage',
      severity: 'high',
      userFeedback: {
        message: 'Storage backend error',
        explanation: `The storage backend (${context.storageType}) encountered an error while ${context.operation}.`,
        suggestions: [
          'Check storage backend configuration',
          'Verify storage backend connectivity',
          'Check storage permissions',
          'Try again in a few moments'
        ],
        recoverable: true,
        estimatedResolution: '2-5 minutes',
        supportInfo: 'Contact support if the issue persists',
      },
      technicalDetails: {
        ...context,
        storageError: error.code,
        storageDetails: error.details,
        errorType: 'StorageBackendError',
      },
      retryInfo: {
        retryable: true,
        maxRetries: 3,
        retryDelay: 3000,
        backoffMultiplier: 2,
      }
    }
  }

  /**
   * Handle network errors
   */
  private handleNetworkError(
    error: any,
    context: { projectRef: string; functionSlug: string; operation: string }
  ): EnhancedErrorInfo {
    return {
      originalError: error,
      code: 'NETWORK_ERROR',
      category: 'network',
      severity: 'medium',
      userFeedback: {
        message: 'Network connection error',
        explanation: 'A network error occurred while trying to retrieve the function data.',
        suggestions: [
          'Check your internet connection',
          'Try refreshing the page',
          'Check if the storage backend is accessible',
          'Wait a moment and try again'
        ],
        recoverable: true,
        estimatedResolution: '1-3 minutes',
      },
      technicalDetails: {
        ...context,
        networkError: error.message,
        errorType: 'NetworkError',
      },
      retryInfo: {
        retryable: true,
        maxRetries: 5,
        retryDelay: 2000,
        backoffMultiplier: 1.5,
      }
    }
  }

  /**
   * Handle permission errors
   */
  private handlePermissionError(
    error: any,
    context: { projectRef: string; functionSlug: string; operation: string }
  ): EnhancedErrorInfo {
    return {
      originalError: error,
      code: 'PERMISSION_DENIED',
      category: 'permission',
      severity: 'high',
      userFeedback: {
        message: 'Access denied',
        explanation: `You don't have permission to access function '${context.functionSlug}' in project '${context.projectRef}'.`,
        suggestions: [
          'Check your project permissions',
          'Contact the project owner for access',
          'Verify you\'re logged into the correct account',
          'Refresh your session by logging out and back in'
        ],
        recoverable: false,
        supportInfo: 'Contact your project administrator for access',
      },
      technicalDetails: {
        ...context,
        permissionError: error.message,
        errorType: 'PermissionError',
      },
      retryInfo: {
        retryable: false,
        maxRetries: 0,
        retryDelay: 0,
        backoffMultiplier: 1,
      }
    }
  }

  /**
   * Handle timeout errors
   */
  private handleTimeoutError(
    error: any,
    context: { projectRef: string; functionSlug: string; operation: string }
  ): EnhancedErrorInfo {
    return {
      originalError: error,
      code: 'OPERATION_TIMEOUT',
      category: 'network',
      severity: 'medium',
      userFeedback: {
        message: 'Operation timed out',
        explanation: `The ${context.operation} operation took too long and timed out.`,
        suggestions: [
          'Try the operation again',
          'Check your network connection',
          'The storage backend may be experiencing high load',
          'Try again in a few minutes'
        ],
        recoverable: true,
        estimatedResolution: '1-5 minutes',
      },
      technicalDetails: {
        ...context,
        timeoutError: error.message,
        errorType: 'TimeoutError',
      },
      retryInfo: {
        retryable: true,
        maxRetries: 3,
        retryDelay: 5000,
        backoffMultiplier: 2,
      }
    }
  }

  /**
   * Handle validation errors
   */
  private handleValidationError(
    error: any,
    context: { projectRef: string; functionSlug: string; operation: string }
  ): EnhancedErrorInfo {
    return {
      originalError: error,
      code: 'VALIDATION_ERROR',
      category: 'validation',
      severity: 'medium',
      userFeedback: {
        message: 'Function data validation failed',
        explanation: 'The function data failed validation checks.',
        suggestions: [
          'Check if the function was deployed correctly',
          'Try redeploying the function',
          'Verify the function files are not corrupted'
        ],
        recoverable: true,
        estimatedResolution: '2-5 minutes',
      },
      technicalDetails: {
        ...context,
        validationError: error.message,
        errorType: 'ValidationError',
      },
      retryInfo: {
        retryable: true,
        maxRetries: 2,
        retryDelay: 3000,
        backoffMultiplier: 2,
      }
    }
  }

  /**
   * Handle generic errors
   */
  private handleGenericError(
    error: any,
    context: { projectRef: string; functionSlug: string; operation: string }
  ): EnhancedErrorInfo {
    return {
      originalError: error,
      code: 'UNKNOWN_ERROR',
      category: 'unknown',
      severity: 'medium',
      userFeedback: {
        message: 'An unexpected error occurred',
        explanation: `An unexpected error occurred while ${context.operation}.`,
        suggestions: [
          'Try refreshing the page',
          'Try the operation again',
          'Check the browser console for more details',
          'Contact support if the issue persists'
        ],
        recoverable: true,
        estimatedResolution: 'Unknown',
        supportInfo: 'Please provide error details to support',
      },
      technicalDetails: {
        ...context,
        genericError: error.message,
        errorStack: error.stack,
        errorType: 'GenericError',
      },
      retryInfo: {
        retryable: true,
        maxRetries: 2,
        retryDelay: 3000,
        backoffMultiplier: 2,
      }
    }
  }

  /**
   * Check if error is a network error
   */
  private isNetworkError(error: any): boolean {
    const message = error.message?.toLowerCase() || ''
    return message.includes('network') || 
           message.includes('connection') || 
           message.includes('fetch') ||
           message.includes('enotfound') ||
           message.includes('econnrefused')
  }

  /**
   * Check if error is a permission error
   */
  private isPermissionError(error: any): boolean {
    const message = error.message?.toLowerCase() || ''
    return message.includes('permission') || 
           message.includes('access') || 
           message.includes('unauthorized') ||
           message.includes('forbidden') ||
           message.includes('auth')
  }

  /**
   * Check if error is a timeout error
   */
  private isTimeoutError(error: any): boolean {
    const message = error.message?.toLowerCase() || ''
    return message.includes('timeout') || 
           message.includes('timed out') ||
           error.code === 'ETIMEDOUT'
  }

  /**
   * Check if error is a validation error
   */
  private isValidationError(error: any): boolean {
    const message = error.message?.toLowerCase() || ''
    return message.includes('validation') || 
           message.includes('invalid') ||
           message.includes('malformed') ||
           message.includes('corrupt')
  }

  /**
   * Get severity for error code
   */
  private getSeverityForCode(code: string): ErrorSeverity {
    switch (code) {
      case 'FUNCTION_NOT_FOUND':
      case 'METADATA_NOT_FOUND':
        return 'medium'
      case 'FUNCTION_ACCESS_DENIED':
      case 'STORAGE_BACKEND_ERROR':
        return 'high'
      case 'FUNCTION_ENTRYPOINT_NOT_FOUND':
      case 'FUNCTION_FILES_NOT_FOUND':
        return 'medium'
      default:
        return 'medium'
    }
  }

  /**
   * Get category for error code
   */
  private getCategoryForCode(code: string): ErrorCategory {
    switch (code) {
      case 'FUNCTION_NOT_FOUND':
      case 'METADATA_NOT_FOUND':
      case 'STORAGE_BACKEND_ERROR':
        return 'storage'
      case 'FUNCTION_ACCESS_DENIED':
        return 'permission'
      case 'NETWORK_ERROR':
      case 'FUNCTION_RETRIEVAL_TIMEOUT':
        return 'network'
      case 'FUNCTION_ENTRYPOINT_NOT_FOUND':
      case 'FUNCTION_FILES_NOT_FOUND':
        return 'validation'
      default:
        return 'unknown'
    }
  }

  /**
   * Get user feedback for error code
   */
  private getUserFeedbackForCode(
    code: string, 
    context: { projectRef: string; functionSlug: string }, 
    details?: any
  ): UserFeedback {
    switch (code) {
      case 'FUNCTION_NOT_FOUND':
        return {
          message: `Function '${context.functionSlug}' not found`,
          explanation: 'The requested function does not exist or has been deleted.',
          suggestions: [
            'Verify the function name is correct',
            'Check if the function has been deployed',
            'Deploy the function if it doesn\'t exist'
          ],
          recoverable: true,
          estimatedResolution: '1-2 minutes',
        }
      
      case 'FUNCTION_ACCESS_DENIED':
        return {
          message: 'Access denied to function',
          explanation: 'You don\'t have permission to access this function.',
          suggestions: [
            'Check your project permissions',
            'Contact the project owner for access',
            'Verify you\'re logged into the correct account'
          ],
          recoverable: false,
          supportInfo: 'Contact your project administrator',
        }
      
      case 'FUNCTION_ENTRYPOINT_NOT_FOUND':
        return {
          message: 'Function entry point not found',
          explanation: 'The function\'s main entry point file could not be located.',
          suggestions: [
            'Check if the function was deployed correctly',
            'Verify the entry point file exists',
            'Try redeploying the function'
          ],
          recoverable: true,
          estimatedResolution: '2-5 minutes',
        }
      
      default:
        return {
          message: 'Function retrieval error',
          explanation: 'An error occurred while retrieving the function.',
          suggestions: [
            'Try refreshing the page',
            'Check your network connection',
            'Try again in a few moments'
          ],
          recoverable: true,
          estimatedResolution: '1-3 minutes',
        }
    }
  }

  /**
   * Get retry info for error code
   */
  private getRetryInfoForCode(code: string): {
    retryable: boolean
    maxRetries: number
    retryDelay: number
    backoffMultiplier: number
  } {
    switch (code) {
      case 'FUNCTION_ACCESS_DENIED':
        return {
          retryable: false,
          maxRetries: 0,
          retryDelay: 0,
          backoffMultiplier: 1,
        }
      
      case 'FUNCTION_NOT_FOUND':
      case 'FUNCTION_ENTRYPOINT_NOT_FOUND':
        return {
          retryable: true,
          maxRetries: 2,
          retryDelay: 2000,
          backoffMultiplier: 2,
        }
      
      default:
        return {
          retryable: true,
          maxRetries: 3,
          retryDelay: 1000,
          backoffMultiplier: 1.5,
        }
    }
  }
}

/**
 * Singleton instance
 */
let functionErrorHandler: FunctionErrorHandler | null = null

/**
 * Get the singleton FunctionErrorHandler instance
 */
export function getFunctionErrorHandler(): FunctionErrorHandler {
  if (!functionErrorHandler) {
    functionErrorHandler = new FunctionErrorHandler()
  }
  return functionErrorHandler
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetFunctionErrorHandler(): void {
  functionErrorHandler = null
}