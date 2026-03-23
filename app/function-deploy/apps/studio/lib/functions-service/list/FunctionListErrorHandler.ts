import { StorageBackendError, StorageNotFoundError } from '../storage/StorageBackend'

/**
 * Function list error types
 */
export type FunctionListErrorType = 
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_ACCESS_DENIED'
  | 'FUNCTION_LIST_TIMEOUT'
  | 'STORAGE_ERROR'
  | 'NETWORK_ERROR'
  | 'PERMISSION_ERROR'
  | 'SYNC_ERROR'
  | 'METADATA_ERROR'
  | 'VALIDATION_ERROR'
  | 'FUNCTION_LIST_ERROR'

/**
 * Function list error information
 */
export interface FunctionListError {
  /** Error type/code */
  code: FunctionListErrorType
  /** Human-readable error message */
  message: string
  /** Whether the error is retryable */
  retryable: boolean
  /** Suggested retry delay in milliseconds */
  retryAfter?: number
  /** Additional error details */
  details?: Record<string, any>
  /** Suggested actions to resolve the error */
  suggestions?: string[]
  /** Original error that caused this */
  originalError?: any
}

/**
 * Retry configuration for function list operations
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts: number
  /** Base delay between retries in milliseconds */
  baseDelay: number
  /** Maximum delay between retries in milliseconds */
  maxDelay: number
  /** Exponential backoff multiplier */
  backoffMultiplier: number
  /** Whether to use jitter in retry delays */
  useJitter: boolean
}

/**
 * Retry attempt information
 */
export interface RetryAttempt {
  /** Attempt number (1-based) */
  attempt: number
  /** Delay before this attempt in milliseconds */
  delay: number
  /** Error from previous attempt */
  previousError?: FunctionListError
  /** Timestamp of this attempt */
  timestamp: string
}

/**
 * Function List Error Handler
 * 
 * Provides enhanced error handling for function list operations including
 * specific error messages, retry mechanisms, and synchronization error handling.
 */
export class FunctionListErrorHandler {
  private defaultRetryConfig: RetryConfig = {
    maxAttempts: 3,
    baseDelay: 1000, // 1 second
    maxDelay: 30000, // 30 seconds
    backoffMultiplier: 2,
    useJitter: true,
  }

  constructor(private retryConfig: RetryConfig = this.defaultRetryConfig) {
    this.retryConfig = { ...this.defaultRetryConfig, ...retryConfig }
  }

  /**
   * Handle and classify function list retrieval errors
   * 
   * @param error - Original error
   * @param context - Additional context about the operation
   * @returns Structured error information
   */
  handleListRetrievalError(error: any, context?: Record<string, any>): FunctionListError {
    // Handle storage backend errors
    if (error instanceof StorageBackendError) {
      return this.handleStorageBackendError(error, context)
    }

    // Handle storage not found errors
    if (error instanceof StorageNotFoundError) {
      return {
        code: 'STORAGE_ERROR',
        message: `Storage location not found: ${error.message}`,
        retryable: false,
        details: {
          ...context,
          originalError: error.message,
        },
        suggestions: [
          'Check if the storage backend is properly configured',
          'Verify the project exists',
          'Check storage permissions',
        ],
        originalError: error,
      }
    }

    // Handle network/timeout errors
    if (this.isTimeoutError(error)) {
      return {
        code: 'FUNCTION_LIST_TIMEOUT',
        message: 'Function list retrieval timed out',
        retryable: true,
        retryAfter: this.calculateRetryDelay(1),
        details: {
          ...context,
          originalError: error.message,
          timeout: true,
        },
        suggestions: [
          'Check network connectivity',
          'Verify storage backend is responsive',
          'Try again in a few moments',
        ],
        originalError: error,
      }
    }

    // Handle network connectivity errors
    if (this.isNetworkError(error)) {
      return {
        code: 'NETWORK_ERROR',
        message: 'Network connectivity issue while retrieving function list',
        retryable: true,
        retryAfter: this.calculateRetryDelay(1),
        details: {
          ...context,
          originalError: error.message,
          networkError: true,
        },
        suggestions: [
          'Check network connectivity',
          'Verify storage service is running',
          'Check firewall settings',
          'Verify DNS resolution',
        ],
        originalError: error,
      }
    }

    // Handle permission errors
    if (this.isPermissionError(error)) {
      return {
        code: 'PERMISSION_ERROR',
        message: 'Access denied while retrieving function list',
        retryable: false,
        details: {
          ...context,
          originalError: error.message,
          permissionError: true,
        },
        suggestions: [
          'Check storage permissions',
          'Verify user access rights',
          'Check AWS credentials (if using S3)',
          'Verify file system permissions (if using local storage)',
        ],
        originalError: error,
      }
    }

    // Handle validation errors
    if (this.isValidationError(error)) {
      return {
        code: 'VALIDATION_ERROR',
        message: `Validation error: ${error.message}`,
        retryable: false,
        details: {
          ...context,
          originalError: error.message,
          validationError: true,
        },
        suggestions: [
          'Check function metadata format',
          'Verify storage data integrity',
          'Check for corrupted function files',
        ],
        originalError: error,
      }
    }

    // Generic error fallback
    return {
      code: 'FUNCTION_LIST_ERROR',
      message: 'Failed to retrieve function list',
      retryable: false,
      details: {
        ...context,
        originalError: error.message || 'Unknown error',
        errorType: error.constructor?.name || 'Unknown',
      },
      suggestions: [
        'Check system logs for more details',
        'Verify storage backend configuration',
        'Contact support if the issue persists',
      ],
      originalError: error,
    }
  }

  /**
   * Handle storage backend specific errors
   * 
   * @param error - Storage backend error
   * @param context - Additional context
   * @returns Structured error information
   */
  private handleStorageBackendError(error: StorageBackendError, context?: Record<string, any>): FunctionListError {
    switch (error.code) {
      case 'STORAGE_UNAVAILABLE':
      case 'CONNECTION_ERROR':
        return {
          code: 'STORAGE_UNAVAILABLE',
          message: 'Storage backend is unavailable',
          retryable: true,
          retryAfter: this.calculateRetryDelay(2),
          details: {
            ...context,
            storageType: error.details?.storageType,
            originalError: error.message,
          },
          suggestions: [
            'Check if storage service is running',
            'Verify network connectivity to storage backend',
            'Check storage service health',
            error.details?.storageType === 's3' ? 'Verify AWS S3 service status' : 'Check local file system availability',
          ],
          originalError: error,
        }

      case 'PERMISSION_DENIED':
      case 'ACCESS_DENIED':
        return {
          code: 'STORAGE_ACCESS_DENIED',
          message: 'Access denied to storage backend',
          retryable: false,
          details: {
            ...context,
            storageType: error.details?.storageType,
            originalError: error.message,
          },
          suggestions: [
            'Check storage permissions',
            error.details?.storageType === 's3' ? 'Verify AWS credentials and S3 bucket permissions' : 'Check file system permissions',
            'Verify user has access to the project',
            'Check IAM roles and policies (if using AWS)',
          ],
          originalError: error,
        }

      case 'TIMEOUT':
        return {
          code: 'FUNCTION_LIST_TIMEOUT',
          message: 'Storage operation timed out',
          retryable: true,
          retryAfter: this.calculateRetryDelay(1),
          details: {
            ...context,
            storageType: error.details?.storageType,
            originalError: error.message,
          },
          suggestions: [
            'Check network latency to storage backend',
            'Verify storage backend performance',
            'Try again with a longer timeout',
          ],
          originalError: error,
        }

      case 'INVALID_CONFIGURATION':
        return {
          code: 'STORAGE_ERROR',
          message: 'Invalid storage backend configuration',
          retryable: false,
          details: {
            ...context,
            storageType: error.details?.storageType,
            originalError: error.message,
          },
          suggestions: [
            'Check storage backend configuration',
            'Verify environment variables',
            'Check AWS credentials format (if using S3)',
            'Verify storage paths and permissions',
          ],
          originalError: error,
        }

      default:
        return {
          code: 'STORAGE_ERROR',
          message: `Storage backend error: ${error.message}`,
          retryable: true,
          retryAfter: this.calculateRetryDelay(3),
          details: {
            ...context,
            storageError: error.code,
            storageType: error.details?.storageType,
            originalError: error.message,
          },
          suggestions: [
            'Check storage backend logs',
            'Verify storage backend health',
            'Check system resources',
            'Contact support if the issue persists',
          ],
          originalError: error,
        }
    }
  }

  /**
   * Handle synchronization errors between deployment methods
   * 
   * @param error - Synchronization error
   * @param context - Additional context
   * @returns Structured error information
   */
  handleSyncError(error: any, context?: Record<string, any>): FunctionListError {
    return {
      code: 'SYNC_ERROR',
      message: `Function list synchronization failed: ${error.message}`,
      retryable: true,
      retryAfter: this.calculateRetryDelay(2),
      details: {
        ...context,
        originalError: error.message,
        syncError: true,
      },
      suggestions: [
        'Check if all deployment sources are accessible',
        'Verify metadata consistency across deployment methods',
        'Try refreshing the function list',
        'Check for concurrent deployment operations',
      ],
      originalError: error,
    }
  }

  /**
   * Handle metadata loading errors
   * 
   * @param error - Metadata error
   * @param functionSlug - Function slug that failed
   * @param context - Additional context
   * @returns Structured error information
   */
  handleMetadataError(error: any, functionSlug: string, context?: Record<string, any>): FunctionListError {
    return {
      code: 'METADATA_ERROR',
      message: `Failed to load metadata for function '${functionSlug}': ${error.message}`,
      retryable: true,
      retryAfter: this.calculateRetryDelay(1),
      details: {
        ...context,
        functionSlug,
        originalError: error.message,
        metadataError: true,
      },
      suggestions: [
        'Check if function metadata file exists',
        'Verify metadata file format',
        'Check storage permissions for metadata files',
        'Try refreshing the specific function',
      ],
      originalError: error,
    }
  }

  /**
   * Execute operation with retry logic
   * 
   * @param operation - Operation to execute
   * @param operationName - Name of the operation for logging
   * @returns Operation result
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string = 'function list operation'
  ): Promise<T> {
    let lastError: FunctionListError | null = null
    const attempts: RetryAttempt[] = []

    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt++) {
      const attemptInfo: RetryAttempt = {
        attempt,
        delay: attempt === 1 ? 0 : this.calculateRetryDelay(attempt - 1),
        previousError: lastError || undefined,
        timestamp: new Date().toISOString(),
      }
      attempts.push(attemptInfo)

      // Wait before retry (except for first attempt)
      if (attempt > 1 && attemptInfo.delay > 0) {
        console.log(`Retrying ${operationName} (attempt ${attempt}/${this.retryConfig.maxAttempts}) after ${attemptInfo.delay}ms delay`)
        await this.sleep(attemptInfo.delay)
      }

      try {
        const result = await operation()
        
        if (attempt > 1) {
          console.log(`${operationName} succeeded on attempt ${attempt}/${this.retryConfig.maxAttempts}`)
        }
        
        return result
      } catch (error) {
        lastError = this.handleListRetrievalError(error, {
          operationName,
          attempt,
          maxAttempts: this.retryConfig.maxAttempts,
          attempts,
        })

        console.warn(`${operationName} failed on attempt ${attempt}/${this.retryConfig.maxAttempts}:`, lastError.message)

        // If this is the last attempt or error is not retryable, throw the error
        if (attempt === this.retryConfig.maxAttempts || !lastError.retryable) {
          console.error(`${operationName} failed after ${attempt} attempts:`, lastError)
          throw lastError
        }
      }
    }

    // This should never be reached, but just in case
    throw lastError || new Error(`${operationName} failed after ${this.retryConfig.maxAttempts} attempts`)
  }

  /**
   * Calculate retry delay with exponential backoff and jitter
   * 
   * @param attempt - Attempt number (0-based)
   * @returns Delay in milliseconds
   */
  private calculateRetryDelay(attempt: number): number {
    // Calculate exponential backoff delay
    let delay = Math.min(
      this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffMultiplier, attempt),
      this.retryConfig.maxDelay
    )

    // Add jitter to prevent thundering herd
    if (this.retryConfig.useJitter) {
      delay = delay * (0.5 + Math.random() * 0.5) // Random between 50% and 100% of calculated delay
    }

    return Math.floor(delay)
  }

  /**
   * Sleep for specified milliseconds
   * 
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Check if error is a timeout error
   * 
   * @param error - Error to check
   * @returns True if timeout error
   */
  private isTimeoutError(error: any): boolean {
    if (!error) return false
    
    const message = error.message?.toLowerCase() || ''
    const code = error.code?.toLowerCase() || ''
    
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      code === 'etimedout' ||
      code === 'timeout' ||
      error.name === 'TimeoutError'
    )
  }

  /**
   * Check if error is a network connectivity error
   * 
   * @param error - Error to check
   * @returns True if network error
   */
  private isNetworkError(error: any): boolean {
    if (!error) return false
    
    const message = error.message?.toLowerCase() || ''
    const code = error.code?.toLowerCase() || ''
    
    return (
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('enetunreach') ||
      message.includes('ehostunreach') ||
      message.includes('network') ||
      code === 'econnrefused' ||
      code === 'enotfound' ||
      code === 'enetunreach' ||
      code === 'ehostunreach' ||
      error.name === 'NetworkError'
    )
  }

  /**
   * Check if error is a permission/access error
   * 
   * @param error - Error to check
   * @returns True if permission error
   */
  private isPermissionError(error: any): boolean {
    if (!error) return false
    
    const message = error.message?.toLowerCase() || ''
    const code = error.code?.toLowerCase() || ''
    
    return (
      message.includes('permission') ||
      message.includes('access denied') ||
      message.includes('forbidden') ||
      message.includes('unauthorized') ||
      message.includes('eacces') ||
      code === 'eacces' ||
      code === 'eperm' ||
      error.name === 'PermissionError' ||
      error.statusCode === 403 ||
      error.status === 403
    )
  }

  /**
   * Check if error is a validation error
   * 
   * @param error - Error to check
   * @returns True if validation error
   */
  private isValidationError(error: any): boolean {
    if (!error) return false
    
    const message = error.message?.toLowerCase() || ''
    
    return (
      message.includes('validation') ||
      message.includes('invalid') ||
      message.includes('malformed') ||
      message.includes('corrupt') ||
      error.name === 'ValidationError' ||
      error.name === 'SyntaxError'
    )
  }

  /**
   * Get retry configuration
   */
  getRetryConfig(): RetryConfig {
    return { ...this.retryConfig }
  }

  /**
   * Update retry configuration
   * 
   * @param config - New retry configuration
   */
  updateRetryConfig(config: Partial<RetryConfig>): void {
    this.retryConfig = { ...this.retryConfig, ...config }
  }

  /**
   * Reset retry configuration to defaults
   */
  resetRetryConfig(): void {
    this.retryConfig = { ...this.defaultRetryConfig }
  }
}

/**
 * Singleton instance
 */
let errorHandler: FunctionListErrorHandler | null = null

/**
 * Get the singleton FunctionListErrorHandler instance
 */
export function getFunctionListErrorHandler(config?: RetryConfig): FunctionListErrorHandler {
  if (!errorHandler) {
    errorHandler = new FunctionListErrorHandler(config)
  }
  return errorHandler
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetFunctionListErrorHandler(): void {
  errorHandler = null
}