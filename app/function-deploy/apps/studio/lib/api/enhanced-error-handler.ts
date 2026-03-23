import { NextApiResponse } from 'next'
import { ResponseError } from 'types'

/**
 * Enhanced Error Handler for PostgREST Compatibility
 * Implements comprehensive error handling with PostgREST-compatible error codes
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */

/**
 * PostgREST-compatible error codes
 * Based on PostgREST error code standards
 */
export enum PostgRESTErrorCode {
  // Generic errors
  PGRST000 = 'PGRST000', // Internal server error
  PGRST001 = 'PGRST001', // Connection error
  PGRST002 = 'PGRST002', // Configuration error
  
  // Authentication/Authorization errors (4xx)
  PGRST100 = 'PGRST100', // Authentication required
  PGRST101 = 'PGRST101', // Invalid authentication
  PGRST102 = 'PGRST102', // Insufficient privileges
  PGRST103 = 'PGRST103', // Schema access denied
  
  // Request errors (4xx)
  PGRST200 = 'PGRST200', // Bad request
  PGRST201 = 'PGRST201', // Invalid range
  PGRST202 = 'PGRST202', // Invalid filters
  PGRST203 = 'PGRST203', // Invalid select
  PGRST204 = 'PGRST204', // Invalid order
  PGRST205 = 'PGRST205', // Invalid limit/offset
  PGRST206 = 'PGRST206', // Invalid JSON
  PGRST207 = 'PGRST207', // Invalid content type
  PGRST208 = 'PGRST208', // Invalid accept header
  
  // Resource errors (4xx)
  PGRST300 = 'PGRST300', // Resource not found
  PGRST301 = 'PGRST301', // Table not found
  PGRST302 = 'PGRST302', // View not found
  PGRST303 = 'PGRST303', // Function not found
  PGRST304 = 'PGRST304', // Column not found
  PGRST305 = 'PGRST305', // Relationship not found
  
  // Constraint violations (4xx)
  PGRST400 = 'PGRST400', // Constraint violation
  PGRST401 = 'PGRST401', // Unique constraint violation
  PGRST402 = 'PGRST402', // Foreign key constraint violation
  PGRST403 = 'PGRST403', // Check constraint violation
  PGRST404 = 'PGRST404', // Not null constraint violation
  
  // Performance/Complexity errors (4xx)
  PGRST500 = 'PGRST500', // Query too complex
  PGRST501 = 'PGRST501', // Query timeout
  PGRST502 = 'PGRST502', // Connection pool exhausted
  PGRST503 = 'PGRST503', // Rate limit exceeded
  PGRST504 = 'PGRST504', // Response too large
}

/**
 * HTTP status code mapping for PostgREST errors
 */
export const ERROR_STATUS_MAPPING: Record<PostgRESTErrorCode, number> = {
  // 5xx - Server errors
  [PostgRESTErrorCode.PGRST000]: 500, // Internal server error
  [PostgRESTErrorCode.PGRST001]: 503, // Service unavailable
  [PostgRESTErrorCode.PGRST002]: 500, // Configuration error
  
  // 4xx - Authentication/Authorization
  [PostgRESTErrorCode.PGRST100]: 401, // Unauthorized
  [PostgRESTErrorCode.PGRST101]: 401, // Unauthorized
  [PostgRESTErrorCode.PGRST102]: 403, // Forbidden
  [PostgRESTErrorCode.PGRST103]: 403, // Forbidden
  
  // 4xx - Bad requests
  [PostgRESTErrorCode.PGRST200]: 400, // Bad request
  [PostgRESTErrorCode.PGRST201]: 416, // Range not satisfiable
  [PostgRESTErrorCode.PGRST202]: 400, // Bad request
  [PostgRESTErrorCode.PGRST203]: 400, // Bad request
  [PostgRESTErrorCode.PGRST204]: 400, // Bad request
  [PostgRESTErrorCode.PGRST205]: 400, // Bad request
  [PostgRESTErrorCode.PGRST206]: 400, // Bad request
  [PostgRESTErrorCode.PGRST207]: 415, // Unsupported media type
  [PostgRESTErrorCode.PGRST208]: 406, // Not acceptable
  
  // 4xx - Not found
  [PostgRESTErrorCode.PGRST300]: 404, // Not found
  [PostgRESTErrorCode.PGRST301]: 404, // Not found
  [PostgRESTErrorCode.PGRST302]: 404, // Not found
  [PostgRESTErrorCode.PGRST303]: 404, // Not found
  [PostgRESTErrorCode.PGRST304]: 400, // Bad request (column in select)
  [PostgRESTErrorCode.PGRST305]: 400, // Bad request (relationship)
  
  // 4xx - Constraint violations
  [PostgRESTErrorCode.PGRST400]: 409, // Conflict
  [PostgRESTErrorCode.PGRST401]: 409, // Conflict
  [PostgRESTErrorCode.PGRST402]: 409, // Conflict
  [PostgRESTErrorCode.PGRST403]: 409, // Conflict
  [PostgRESTErrorCode.PGRST404]: 400, // Bad request
  
  // 4xx - Performance/Complexity
  [PostgRESTErrorCode.PGRST500]: 400, // Bad request
  [PostgRESTErrorCode.PGRST501]: 408, // Request timeout
  [PostgRESTErrorCode.PGRST502]: 503, // Service unavailable
  [PostgRESTErrorCode.PGRST503]: 429, // Too many requests
  [PostgRESTErrorCode.PGRST504]: 413, // Payload too large
}

/**
 * Enhanced error response interface
 */
export interface EnhancedErrorResponse {
  code: PostgRESTErrorCode
  message: string
  details?: string
  hint?: string
  schema?: string
  table?: string
  column?: string
  constraint?: string
  requestId?: string
  timestamp: string
}

/**
 * Validation error details
 */
export interface ValidationErrorDetail {
  field: string
  value: any
  message: string
  code: string
}

/**
 * Performance error context
 */
export interface PerformanceErrorContext {
  queryComplexity?: number
  executionTime?: number
  memoryUsage?: number
  connectionPoolStatus?: {
    active: number
    idle: number
    waiting: number
  }
}

/**
 * Enhanced Error Handler class
 */
export class EnhancedErrorHandler {
  private static instance: EnhancedErrorHandler

  private constructor() {}

  static getInstance(): EnhancedErrorHandler {
    if (!EnhancedErrorHandler.instance) {
      EnhancedErrorHandler.instance = new EnhancedErrorHandler()
    }
    return EnhancedErrorHandler.instance
  }

  /**
   * Handle database constraint violations
   * Requirements: 12.1
   */
  handleConstraintViolation(
    error: any,
    res: NextApiResponse,
    requestId?: string
  ): void {
    let errorCode: PostgRESTErrorCode
    let message: string
    let hint: string | undefined

    // Parse PostgreSQL constraint violation
    if (error.code === '23505') {
      // Unique constraint violation
      errorCode = PostgRESTErrorCode.PGRST401
      message = 'Unique constraint violation'
      hint = 'The resource you are trying to create already exists'
    } else if (error.code === '23503') {
      // Foreign key constraint violation
      errorCode = PostgRESTErrorCode.PGRST402
      message = 'Foreign key constraint violation'
      hint = 'The referenced resource does not exist'
    } else if (error.code === '23514') {
      // Check constraint violation
      errorCode = PostgRESTErrorCode.PGRST403
      message = 'Check constraint violation'
      hint = 'The provided data does not meet the required constraints'
    } else if (error.code === '23502') {
      // Not null constraint violation
      errorCode = PostgRESTErrorCode.PGRST404
      message = 'Not null constraint violation'
      hint = 'Required field cannot be null'
    } else {
      // Generic constraint violation
      errorCode = PostgRESTErrorCode.PGRST400
      message = 'Constraint violation'
      hint = 'The operation violates a database constraint'
    }

    const statusCode = ERROR_STATUS_MAPPING[errorCode]
    const errorResponse: EnhancedErrorResponse = {
      code: errorCode,
      message,
      details: error.detail || error.message,
      hint,
      constraint: error.constraint,
      table: error.table,
      schema: error.schema,
      requestId,
      timestamp: new Date().toISOString()
    }

    res.status(statusCode).json(errorResponse)
  }

  /**
   * Handle resource not found errors
   * Requirements: 12.2
   */
  handleResourceNotFound(
    resourceType: 'table' | 'view' | 'function' | 'column' | 'relationship',
    resourceName: string,
    res: NextApiResponse,
    requestId?: string,
    schema?: string
  ): void {
    let errorCode: PostgRESTErrorCode
    let message: string
    let hint: string

    switch (resourceType) {
      case 'table':
        errorCode = PostgRESTErrorCode.PGRST301
        message = `Table '${resourceName}' not found`
        hint = 'Verify the table name and ensure you have access to it'
        break
      case 'view':
        errorCode = PostgRESTErrorCode.PGRST302
        message = `View '${resourceName}' not found`
        hint = 'Verify the view name and ensure you have access to it'
        break
      case 'function':
        errorCode = PostgRESTErrorCode.PGRST303
        message = `Function '${resourceName}' not found`
        hint = 'Verify the function name and ensure it exists in the database'
        break
      case 'column':
        errorCode = PostgRESTErrorCode.PGRST304
        message = `Column '${resourceName}' not found`
        hint = 'Verify the column name exists in the selected table or view'
        break
      case 'relationship':
        errorCode = PostgRESTErrorCode.PGRST305
        message = `Relationship '${resourceName}' not found`
        hint = 'Verify the foreign key relationship exists between the tables'
        break
      default:
        errorCode = PostgRESTErrorCode.PGRST300
        message = `Resource '${resourceName}' not found`
        hint = 'Verify the resource name and ensure you have access to it'
    }

    const statusCode = ERROR_STATUS_MAPPING[errorCode]
    const errorResponse: EnhancedErrorResponse = {
      code: errorCode,
      message,
      hint,
      schema,
      table: resourceType === 'table' ? resourceName : undefined,
      column: resourceType === 'column' ? resourceName : undefined,
      requestId,
      timestamp: new Date().toISOString()
    }

    res.status(statusCode).json(errorResponse)
  }

  /**
   * Handle authentication and authorization errors
   * Requirements: 12.3
   */
  handleAuthError(
    errorType: 'authentication' | 'authorization' | 'schema_access',
    res: NextApiResponse,
    requestId?: string,
    details?: string
  ): void {
    let errorCode: PostgRESTErrorCode
    let message: string
    let hint: string

    switch (errorType) {
      case 'authentication':
        errorCode = PostgRESTErrorCode.PGRST100
        message = 'Authentication required'
        hint = 'Provide a valid JWT token in the Authorization header'
        break
      case 'authorization':
        errorCode = PostgRESTErrorCode.PGRST102
        message = 'Insufficient privileges'
        hint = 'You do not have permission to perform this operation'
        break
      case 'schema_access':
        errorCode = PostgRESTErrorCode.PGRST103
        message = 'Schema access denied'
        hint = 'You do not have access to the requested schema'
        break
      default:
        errorCode = PostgRESTErrorCode.PGRST101
        message = 'Invalid authentication'
        hint = 'Check your authentication credentials'
    }

    const statusCode = ERROR_STATUS_MAPPING[errorCode]
    const errorResponse: EnhancedErrorResponse = {
      code: errorCode,
      message,
      details,
      hint,
      requestId,
      timestamp: new Date().toISOString()
    }

    res.status(statusCode).json(errorResponse)
  }

  /**
   * Handle request format validation errors
   * Requirements: 12.4
   */
  handleValidationError(
    validationErrors: ValidationErrorDetail[],
    res: NextApiResponse,
    requestId?: string
  ): void {
    const errorCode = PostgRESTErrorCode.PGRST200
    const statusCode = ERROR_STATUS_MAPPING[errorCode]
    
    const message = 'Request validation failed'
    const details = validationErrors.map(error => 
      `${error.field}: ${error.message}`
    ).join('; ')
    
    const hint = 'Check the request format and ensure all required fields are provided with valid values'

    const errorResponse: EnhancedErrorResponse = {
      code: errorCode,
      message,
      details,
      hint,
      requestId,
      timestamp: new Date().toISOString()
    }

    res.status(statusCode).json(errorResponse)
  }

  /**
   * Handle performance and complexity errors
   * Requirements: 12.5
   */
  handlePerformanceError(
    errorType: 'complexity' | 'timeout' | 'pool_exhausted' | 'rate_limit' | 'response_size',
    context: PerformanceErrorContext,
    res: NextApiResponse,
    requestId?: string
  ): void {
    let errorCode: PostgRESTErrorCode
    let message: string
    let hint: string

    switch (errorType) {
      case 'complexity':
        errorCode = PostgRESTErrorCode.PGRST500
        message = 'Query too complex'
        hint = 'Simplify your query or use pagination to reduce complexity'
        break
      case 'timeout':
        errorCode = PostgRESTErrorCode.PGRST501
        message = 'Query timeout'
        hint = 'The query took too long to execute. Try optimizing your query or adding appropriate indexes'
        break
      case 'pool_exhausted':
        errorCode = PostgRESTErrorCode.PGRST502
        message = 'Connection pool exhausted'
        hint = 'Too many concurrent connections. Please try again later'
        break
      case 'rate_limit':
        errorCode = PostgRESTErrorCode.PGRST503
        message = 'Rate limit exceeded'
        hint = 'You have exceeded the allowed number of requests. Please wait before making more requests'
        break
      case 'response_size':
        errorCode = PostgRESTErrorCode.PGRST504
        message = 'Response too large'
        hint = 'Use pagination or filtering to reduce the response size'
        break
      default:
        errorCode = PostgRESTErrorCode.PGRST500
        message = 'Performance limit exceeded'
        hint = 'The request exceeded performance limits'
    }

    const statusCode = ERROR_STATUS_MAPPING[errorCode]
    const errorResponse: EnhancedErrorResponse = {
      code: errorCode,
      message,
      details: this.formatPerformanceDetails(context),
      hint,
      requestId,
      timestamp: new Date().toISOString()
    }

    res.status(statusCode).json(errorResponse)
  }

  /**
   * Handle generic errors with enhanced context
   */
  handleGenericError(
    error: any,
    res: NextApiResponse,
    requestId?: string,
    context?: string
  ): void {
    // Try to categorize the error
    if (error.code && error.code.startsWith('23')) {
      // Database constraint violation
      return this.handleConstraintViolation(error, res, requestId)
    }

    if (error.code === '42P01') {
      // Table does not exist
      return this.handleResourceNotFound('table', error.table || 'unknown', res, requestId)
    }

    if (error.code === '42703') {
      // Column does not exist
      return this.handleResourceNotFound('column', error.column || 'unknown', res, requestId)
    }

    if (error.code === '42883') {
      // Function does not exist
      return this.handleResourceNotFound('function', error.routine || 'unknown', res, requestId)
    }

    // Generic server error
    const errorCode = PostgRESTErrorCode.PGRST000
    const statusCode = ERROR_STATUS_MAPPING[errorCode]
    
    const errorResponse: EnhancedErrorResponse = {
      code: errorCode,
      message: 'Internal server error',
      details: error.message || 'An unexpected error occurred',
      hint: 'Please try again later or contact support if the problem persists',
      requestId,
      timestamp: new Date().toISOString()
    }

    res.status(statusCode).json(errorResponse)
  }

  /**
   * Create a ResponseError with PostgREST compatibility
   */
  createResponseError(
    code: PostgRESTErrorCode,
    message?: string,
    requestId?: string,
    details?: string
  ): ResponseError {
    const statusCode = ERROR_STATUS_MAPPING[code]
    const errorMessage = message || this.getDefaultMessage(code)
    
    const error = new ResponseError(errorMessage, statusCode, requestId)
    
    // Add PostgREST-specific properties (use different property name to avoid conflict)
    ;(error as any).postgrestCode = code
    ;(error as any).details = details
    ;(error as any).timestamp = new Date().toISOString()
    
    return error
  }

  /**
   * Format performance context details
   */
  private formatPerformanceDetails(context: PerformanceErrorContext): string {
    const details: string[] = []
    
    if (context.queryComplexity !== undefined) {
      details.push(`Query complexity: ${context.queryComplexity}`)
    }
    
    if (context.executionTime !== undefined) {
      details.push(`Execution time: ${context.executionTime}ms`)
    }
    
    if (context.memoryUsage !== undefined) {
      details.push(`Memory usage: ${Math.round(context.memoryUsage / 1024 / 1024)}MB`)
    }
    
    if (context.connectionPoolStatus) {
      const pool = context.connectionPoolStatus
      details.push(`Connection pool: ${pool.active} active, ${pool.idle} idle, ${pool.waiting} waiting`)
    }
    
    return details.join(', ')
  }

  /**
   * Get default message for error code
   */
  private getDefaultMessage(code: PostgRESTErrorCode): string {
    const messages: Record<PostgRESTErrorCode, string> = {
      [PostgRESTErrorCode.PGRST000]: 'Internal server error',
      [PostgRESTErrorCode.PGRST001]: 'Connection error',
      [PostgRESTErrorCode.PGRST002]: 'Configuration error',
      [PostgRESTErrorCode.PGRST100]: 'Authentication required',
      [PostgRESTErrorCode.PGRST101]: 'Invalid authentication',
      [PostgRESTErrorCode.PGRST102]: 'Insufficient privileges',
      [PostgRESTErrorCode.PGRST103]: 'Schema access denied',
      [PostgRESTErrorCode.PGRST200]: 'Bad request',
      [PostgRESTErrorCode.PGRST201]: 'Invalid range',
      [PostgRESTErrorCode.PGRST202]: 'Invalid filters',
      [PostgRESTErrorCode.PGRST203]: 'Invalid select',
      [PostgRESTErrorCode.PGRST204]: 'Invalid order',
      [PostgRESTErrorCode.PGRST205]: 'Invalid limit/offset',
      [PostgRESTErrorCode.PGRST206]: 'Invalid JSON',
      [PostgRESTErrorCode.PGRST207]: 'Invalid content type',
      [PostgRESTErrorCode.PGRST208]: 'Invalid accept header',
      [PostgRESTErrorCode.PGRST300]: 'Resource not found',
      [PostgRESTErrorCode.PGRST301]: 'Table not found',
      [PostgRESTErrorCode.PGRST302]: 'View not found',
      [PostgRESTErrorCode.PGRST303]: 'Function not found',
      [PostgRESTErrorCode.PGRST304]: 'Column not found',
      [PostgRESTErrorCode.PGRST305]: 'Relationship not found',
      [PostgRESTErrorCode.PGRST400]: 'Constraint violation',
      [PostgRESTErrorCode.PGRST401]: 'Unique constraint violation',
      [PostgRESTErrorCode.PGRST402]: 'Foreign key constraint violation',
      [PostgRESTErrorCode.PGRST403]: 'Check constraint violation',
      [PostgRESTErrorCode.PGRST404]: 'Not null constraint violation',
      [PostgRESTErrorCode.PGRST500]: 'Query too complex',
      [PostgRESTErrorCode.PGRST501]: 'Query timeout',
      [PostgRESTErrorCode.PGRST502]: 'Connection pool exhausted',
      [PostgRESTErrorCode.PGRST503]: 'Rate limit exceeded',
      [PostgRESTErrorCode.PGRST504]: 'Response too large',
    }
    
    return messages[code] || 'Unknown error'
  }
}

/**
 * Factory function to get the enhanced error handler
 */
export function getEnhancedErrorHandler(): EnhancedErrorHandler {
  return EnhancedErrorHandler.getInstance()
}

/**
 * Utility function to check if an error is a PostgREST error
 */
export function isPostgRESTError(error: any): error is EnhancedErrorResponse {
  return !!(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code.startsWith('PGRST'))
}

/**
 * Utility function to extract request ID from request headers
 */
export function extractRequestId(req: any): string | undefined {
  return req.headers?.['x-request-id'] || req.headers?.['X-Request-Id']
}