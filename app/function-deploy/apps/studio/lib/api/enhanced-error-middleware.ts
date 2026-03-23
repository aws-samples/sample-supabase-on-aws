import { NextApiRequest, NextApiResponse } from 'next'
import { 
  EnhancedErrorHandler, 
  getEnhancedErrorHandler, 
  PostgRESTErrorCode,
  ValidationErrorDetail,
  PerformanceErrorContext,
  extractRequestId
} from './enhanced-error-handler'

/**
 * Enhanced Error Middleware
 * Provides middleware functions for consistent error handling across the API
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */

/**
 * Error handling middleware that wraps API handlers
 */
export function withEnhancedErrorHandling<T = any>(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<T>
) {
  return async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
    const errorHandler = getEnhancedErrorHandler()
    const requestId = extractRequestId(req)
    
    try {
      await handler(req, res)
    } catch (error) {
      console.error('API Error:', error)
      
      // Don't send response if headers already sent
      if (!res.headersSent) {
        errorHandler.handleGenericError(error, res, requestId, 'API Handler')
      }
    }
  }
}

/**
 * Request validation middleware
 */
export function validateRequest(
  validationRules: RequestValidationRules
) {
  return (req: NextApiRequest, res: NextApiResponse, next: () => void) => {
    const errorHandler = getEnhancedErrorHandler()
    const requestId = extractRequestId(req)
    const errors: ValidationErrorDetail[] = []

    // Validate HTTP method
    if (validationRules.allowedMethods && !validationRules.allowedMethods.includes(req.method as any)) {
      errors.push({
        field: 'method',
        value: req.method,
        message: `Method ${req.method} not allowed`,
        code: 'METHOD_NOT_ALLOWED'
      })
    }

    // Validate required headers
    if (validationRules.requiredHeaders) {
      for (const header of validationRules.requiredHeaders) {
        if (!req.headers[header.toLowerCase()]) {
          errors.push({
            field: `headers.${header}`,
            value: undefined,
            message: `Required header '${header}' is missing`,
            code: 'MISSING_HEADER'
          })
        }
      }
    }

    // Validate content type
    if (validationRules.expectedContentType && req.method !== 'GET') {
      const contentType = req.headers['content-type']
      if (!contentType || !contentType.includes(validationRules.expectedContentType)) {
        errors.push({
          field: 'headers.content-type',
          value: contentType,
          message: `Expected content type '${validationRules.expectedContentType}'`,
          code: 'INVALID_CONTENT_TYPE'
        })
      }
    }

    // Validate query parameters
    if (validationRules.queryValidation) {
      const queryErrors = validateQueryParameters(req.query, validationRules.queryValidation)
      errors.push(...queryErrors)
    }

    // Validate request body
    if (validationRules.bodyValidation && req.body) {
      const bodyErrors = validateRequestBody(req.body, validationRules.bodyValidation)
      errors.push(...bodyErrors)
    }

    // If there are validation errors, return them
    if (errors.length > 0) {
      errorHandler.handleValidationError(errors, res, requestId)
      return
    }

    // Continue to next middleware/handler
    next()
  }
}

/**
 * Performance monitoring middleware
 */
export function withPerformanceMonitoring(
  limits: PerformanceLimits
) {
  return (req: NextApiRequest, res: NextApiResponse, next: () => void) => {
    const errorHandler = getEnhancedErrorHandler()
    const requestId = extractRequestId(req)
    const startTime = Date.now()
    const startMemory = process.memoryUsage()

    // Set timeout if specified
    let timeoutHandle: NodeJS.Timeout | undefined
    if (limits.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        if (!res.headersSent) {
          const context: PerformanceErrorContext = {
            executionTime: Date.now() - startTime
          }
          errorHandler.handlePerformanceError('timeout', context, res, requestId)
        }
      }, limits.timeoutMs)
    }

    // Monitor response
    const originalEnd = res.end
    res.end = function(chunk?: any, encoding?: any) {
      // Clear timeout
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }

      const executionTime = Date.now() - startTime
      const endMemory = process.memoryUsage()
      const memoryUsage = endMemory.heapUsed - startMemory.heapUsed

      // Check performance limits
      if (limits.maxExecutionTimeMs && executionTime > limits.maxExecutionTimeMs) {
        if (!res.headersSent) {
          const context: PerformanceErrorContext = {
            executionTime,
            memoryUsage
          }
          errorHandler.handlePerformanceError('timeout', context, res, requestId)
          return
        }
      }

      if (limits.maxMemoryUsageMB && memoryUsage > limits.maxMemoryUsageMB * 1024 * 1024) {
        if (!res.headersSent) {
          const context: PerformanceErrorContext = {
            executionTime,
            memoryUsage
          }
          errorHandler.handlePerformanceError('complexity', context, res, requestId)
          return
        }
      }

      // Check response size
      if (limits.maxResponseSizeMB && chunk) {
        const responseSize = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk.toString())
        if (responseSize > limits.maxResponseSizeMB * 1024 * 1024) {
          if (!res.headersSent) {
            const context: PerformanceErrorContext = {
              executionTime,
              memoryUsage
            }
            errorHandler.handlePerformanceError('response_size', context, res, requestId)
            return
          }
        }
      }

      // Call original end method
      originalEnd.call(this, chunk, encoding)
    }

    next()
  }
}

/**
 * Database error handling middleware
 */
export function withDatabaseErrorHandling() {
  return (req: NextApiRequest, res: NextApiResponse, next: () => void) => {
    const errorHandler = getEnhancedErrorHandler()
    const requestId = extractRequestId(req)

    // Wrap the response object to catch database errors
    const originalJson = res.json
    res.json = function(body: any) {
      // Check if the response contains a database error
      if (body && typeof body === 'object' && body.error) {
        const error = body.error
        
        // Handle specific database error types
        if (error.code && typeof error.code === 'string') {
          if (error.code.startsWith('23')) {
            // Constraint violation
            errorHandler.handleConstraintViolation(error, res, requestId)
            return res
          } else if (error.code === '42P01') {
            // Table does not exist
            errorHandler.handleResourceNotFound('table', error.table || 'unknown', res, requestId)
            return res
          } else if (error.code === '42703') {
            // Column does not exist
            errorHandler.handleResourceNotFound('column', error.column || 'unknown', res, requestId)
            return res
          } else if (error.code === '42883') {
            // Function does not exist
            errorHandler.handleResourceNotFound('function', error.routine || 'unknown', res, requestId)
            return res
          }
        }
        
        // Handle authentication/authorization errors
        if (error.message && typeof error.message === 'string') {
          const message = error.message.toLowerCase()
          if (message.includes('permission denied') || message.includes('access denied')) {
            errorHandler.handleAuthError('authorization', res, requestId, error.message)
            return res
          } else if (message.includes('authentication') || message.includes('unauthorized')) {
            errorHandler.handleAuthError('authentication', res, requestId, error.message)
            return res
          }
        }
      }

      // Call original json method
      return originalJson.call(this, body)
    }

    next()
  }
}

/**
 * Content negotiation error handling
 */
export function withContentNegotiation(
  supportedTypes: string[] = ['application/json', 'text/csv', 'application/vnd.pgrst.object+json']
) {
  return (req: NextApiRequest, res: NextApiResponse, next: () => void) => {
    const errorHandler = getEnhancedErrorHandler()
    const requestId = extractRequestId(req)
    
    // Check Accept header
    const acceptHeader = req.headers.accept
    if (acceptHeader && acceptHeader !== '*/*') {
      const acceptedTypes = acceptHeader.split(',').map(type => type.trim().split(';')[0])
      const hasSupported = acceptedTypes.some(type => 
        supportedTypes.includes(type) || type === '*/*'
      )
      
      if (!hasSupported) {
        const errorResponse = {
          code: PostgRESTErrorCode.PGRST208,
          message: 'Not acceptable',
          details: `Supported content types: ${supportedTypes.join(', ')}`,
          hint: 'Use a supported Accept header value',
          requestId,
          timestamp: new Date().toISOString()
        }
        
        res.status(406).json(errorResponse)
        return
      }
    }

    next()
  }
}

/**
 * Request validation rules interface
 */
export interface RequestValidationRules {
  allowedMethods?: ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS')[]
  requiredHeaders?: string[]
  expectedContentType?: string
  queryValidation?: QueryValidationRules
  bodyValidation?: BodyValidationRules
}

/**
 * Query parameter validation rules
 */
export interface QueryValidationRules {
  requiredParams?: string[]
  allowedParams?: string[]
  paramTypes?: Record<string, 'string' | 'number' | 'boolean' | 'array'>
  paramPatterns?: Record<string, RegExp>
}

/**
 * Request body validation rules
 */
export interface BodyValidationRules {
  requiredFields?: string[]
  allowedFields?: string[]
  fieldTypes?: Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>
  maxSize?: number
}

/**
 * Performance limits configuration
 */
export interface PerformanceLimits {
  timeoutMs?: number
  maxExecutionTimeMs?: number
  maxMemoryUsageMB?: number
  maxResponseSizeMB?: number
}

/**
 * Validate query parameters
 */
function validateQueryParameters(
  query: any,
  rules: QueryValidationRules
): ValidationErrorDetail[] {
  const errors: ValidationErrorDetail[] = []

  // Check required parameters
  if (rules.requiredParams) {
    for (const param of rules.requiredParams) {
      if (!(param in query) || query[param] === undefined || query[param] === '') {
        errors.push({
          field: `query.${param}`,
          value: query[param],
          message: `Required query parameter '${param}' is missing`,
          code: 'MISSING_QUERY_PARAM'
        })
      }
    }
  }

  // Check allowed parameters
  if (rules.allowedParams) {
    for (const param in query) {
      if (!rules.allowedParams.includes(param)) {
        errors.push({
          field: `query.${param}`,
          value: query[param],
          message: `Query parameter '${param}' is not allowed`,
          code: 'INVALID_QUERY_PARAM'
        })
      }
    }
  }

  // Check parameter types
  if (rules.paramTypes) {
    for (const [param, expectedType] of Object.entries(rules.paramTypes)) {
      if (param in query && query[param] !== undefined) {
        const value = query[param]
        let isValid = false

        switch (expectedType) {
          case 'string':
            isValid = typeof value === 'string'
            break
          case 'number':
            isValid = !isNaN(Number(value))
            break
          case 'boolean':
            isValid = value === 'true' || value === 'false'
            break
          case 'array':
            isValid = Array.isArray(value) || typeof value === 'string'
            break
        }

        if (!isValid) {
          errors.push({
            field: `query.${param}`,
            value,
            message: `Query parameter '${param}' must be of type ${expectedType}`,
            code: 'INVALID_QUERY_PARAM_TYPE'
          })
        }
      }
    }
  }

  // Check parameter patterns
  if (rules.paramPatterns) {
    for (const [param, pattern] of Object.entries(rules.paramPatterns)) {
      if (param in query && query[param] !== undefined) {
        const value = String(query[param])
        if (!pattern.test(value)) {
          errors.push({
            field: `query.${param}`,
            value,
            message: `Query parameter '${param}' format is invalid`,
            code: 'INVALID_QUERY_PARAM_FORMAT'
          })
        }
      }
    }
  }

  return errors
}

/**
 * Validate request body
 */
function validateRequestBody(
  body: any,
  rules: BodyValidationRules
): ValidationErrorDetail[] {
  const errors: ValidationErrorDetail[] = []

  if (typeof body !== 'object' || body === null) {
    errors.push({
      field: 'body',
      value: body,
      message: 'Request body must be a valid JSON object',
      code: 'INVALID_BODY_FORMAT'
    })
    return errors
  }

  // Check required fields
  if (rules.requiredFields) {
    for (const field of rules.requiredFields) {
      if (!(field in body) || body[field] === undefined || body[field] === null) {
        errors.push({
          field: `body.${field}`,
          value: body[field],
          message: `Required field '${field}' is missing`,
          code: 'MISSING_BODY_FIELD'
        })
      }
    }
  }

  // Check allowed fields
  if (rules.allowedFields) {
    for (const field in body) {
      if (!rules.allowedFields.includes(field)) {
        errors.push({
          field: `body.${field}`,
          value: body[field],
          message: `Field '${field}' is not allowed`,
          code: 'INVALID_BODY_FIELD'
        })
      }
    }
  }

  // Check field types
  if (rules.fieldTypes) {
    for (const [field, expectedType] of Object.entries(rules.fieldTypes)) {
      if (field in body && body[field] !== undefined && body[field] !== null) {
        const value = body[field]
        let isValid = false

        switch (expectedType) {
          case 'string':
            isValid = typeof value === 'string'
            break
          case 'number':
            isValid = typeof value === 'number' && !isNaN(value)
            break
          case 'boolean':
            isValid = typeof value === 'boolean'
            break
          case 'object':
            isValid = typeof value === 'object' && !Array.isArray(value)
            break
          case 'array':
            isValid = Array.isArray(value)
            break
        }

        if (!isValid) {
          errors.push({
            field: `body.${field}`,
            value,
            message: `Field '${field}' must be of type ${expectedType}`,
            code: 'INVALID_BODY_FIELD_TYPE'
          })
        }
      }
    }
  }

  return errors
}

/**
 * Utility function to create a complete error handling middleware stack
 */
export function createErrorHandlingMiddleware(options: {
  validation?: RequestValidationRules
  performance?: PerformanceLimits
  contentTypes?: string[]
}) {
  const middlewares: Array<(req: NextApiRequest, res: NextApiResponse, next: () => void) => void> = []

  // Add content negotiation middleware
  if (options.contentTypes) {
    middlewares.push(withContentNegotiation(options.contentTypes))
  }

  // Add validation middleware
  if (options.validation) {
    middlewares.push(validateRequest(options.validation))
  }

  // Add performance monitoring middleware
  if (options.performance) {
    middlewares.push(withPerformanceMonitoring(options.performance))
  }

  // Always add database error handling
  middlewares.push(withDatabaseErrorHandling())

  return middlewares
}