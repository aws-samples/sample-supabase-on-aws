/**
 * Security and Performance Integration Module
 * 
 * This module integrates all security validations, performance optimizations,
 * audit logging, and query optimizations into a cohesive system.
 * 
 * Requirements: Security and performance considerations
 */

import { NextApiRequest, NextApiResponse } from 'next'
import { getSecurityValidator, ProjectPermissions } from './security-validations'
import { getQueryOptimizer, QueryOptimizationOptions } from './query-optimizations'
import { getAuditLogger, AuditEventType, AuditSeverity } from './audit-logging'
import { 
  ProjectManagementError, 
  ErrorFactory, 
  createErrorContext,
  withErrorHandling,
  handleApiError
} from './error-handling'

/**
 * Integrated API handler configuration
 */
export interface IntegratedApiConfig {
  requiredPermission?: keyof ProjectPermissions
  enableCaching?: boolean
  cacheConfig?: {
    ttl?: number
    keyPrefix?: string
  }
  auditEvent?: AuditEventType
  queryOptimization?: QueryOptimizationOptions
  rateLimiting?: {
    windowMs?: number
    maxRequests?: number
  }
}

/**
 * API handler context with security and performance data
 */
export interface ApiHandlerContext {
  projectId: number
  projectRef: string
  userId: string
  permissions: ProjectPermissions
  requestId: string
  startTime: number
}

/**
 * API response with performance metrics
 */
export interface ApiResponse<T = any> {
  data: T
  metadata: {
    requestId: string
    duration: number
    cached: boolean
    queryMetrics?: any
  }
}

/**
 * Integrated API handler wrapper that combines security, performance, and audit logging
 */
export function createIntegratedApiHandler<T = any>(
  config: IntegratedApiConfig = {}
) {
  return function(
    handler: (
      req: NextApiRequest,
      res: NextApiResponse,
      context: ApiHandlerContext
    ) => Promise<T>
  ) {
    return async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
      const requestId = generateRequestId()
      const startTime = Date.now()
      
      const errorContext = createErrorContext('integratedApiHandler', {
        endpoint: req.url,
        requestId
      })

      try {
        // 1. Extract project information from request
        const projectInfo = extractProjectInfo(req)
        if (!projectInfo) {
          throw ErrorFactory.routing.invalidProjectRef('unknown', errorContext)
        }

        // 2. Security validation with enhanced checks
        const securityValidator = getSecurityValidator()
        const validation = await securityValidator.validateProjectAccess(
          req,
          projectInfo.projectId,
          config.requiredPermission || 'canRead'
        )

        if (!validation.isValid) {
          throw ErrorFactory.generic.internalServerError('Security validation failed', undefined, errorContext)
        }

        // 3. Audit logging - log access attempt
        const auditLogger = getAuditLogger()
        if (config.auditEvent) {
          await auditLogger.logEvent(
            config.auditEvent,
            `API access: ${req.method} ${req.url}`,
            {
              userId: validation.userId,
              projectId: projectInfo.projectId,
              projectRef: projectInfo.projectRef,
              endpoint: req.url,
              method: req.method,
              userAgent: req.headers['user-agent'] as string,
              ipAddress: getClientIp(req),
              requestId
            },
            AuditSeverity.INFO,
            true
          )
        }

        // 4. Build handler context
        const context: ApiHandlerContext = {
          projectId: projectInfo.projectId,
          projectRef: projectInfo.projectRef,
          userId: validation.userId,
          permissions: validation.permissions,
          requestId,
          startTime
        }

        // 5. Execute handler with query optimization if enabled
        let result: T
        let queryMetrics: any = null

        if (config.enableCaching) {
          const queryOptimizer = getQueryOptimizer()
          const cacheKey = buildCacheKey(req, context)
          
          const optimizedResult = await queryOptimizer.executeOptimizedQuery(
            cacheKey,
            () => handler(req, res, context),
            config.queryOptimization
          )
          
          result = optimizedResult.data as T
          queryMetrics = optimizedResult.metrics
        } else {
          result = await handler(req, res, context)
        }

        // 6. Build response with metadata
        const duration = Date.now() - startTime
        const response: ApiResponse<T> = {
          data: result,
          metadata: {
            requestId,
            duration,
            cached: queryMetrics?.cacheHit || false,
            queryMetrics
          }
        }

        // 7. Audit logging - log successful completion
        if (config.auditEvent) {
          await auditLogger.logEvent(
            config.auditEvent,
            `API operation completed successfully`,
            {
              userId: validation.userId,
              projectId: projectInfo.projectId,
              projectRef: projectInfo.projectRef,
              endpoint: req.url,
              method: req.method,
              duration,
              requestId,
              cached: queryMetrics?.cacheHit || false
            },
            AuditSeverity.INFO,
            true
          )
        }

        // 8. Send response
        if (!res.headersSent) {
          res.status(200).json(response)
        }

      } catch (error) {
        const duration = Date.now() - startTime
        
        // Handle and log errors
        if (error instanceof ProjectManagementError) {
          // Audit log the error
          const auditLogger = getAuditLogger()
          await auditLogger.logEvent(
            AuditEventType.API_ERROR,
            `API error: ${error.message}`,
            {
              endpoint: req.url,
              method: req.method,
              errorCode: error.code,
              duration,
              requestId,
              userAgent: req.headers['user-agent'] as string,
              ipAddress: getClientIp(req)
            },
            AuditSeverity.ERROR,
            false
          )

          handleApiError(error, res, errorContext)
        } else {
          // Handle unexpected errors
          const unexpectedError = ErrorFactory.generic.internalServerError(
            'API handler execution',
            error as Error,
            errorContext
          )

          const auditLogger = getAuditLogger()
          await auditLogger.logEvent(
            AuditEventType.SYSTEM_ERROR,
            `Unexpected API error: ${(error as Error).message}`,
            {
              endpoint: req.url,
              method: req.method,
              duration,
              requestId,
              userAgent: req.headers['user-agent'] as string,
              ipAddress: getClientIp(req)
            },
            AuditSeverity.CRITICAL,
            false
          )

          handleApiError(unexpectedError, res, errorContext)
        }
      }
    }
  }
}

/**
 * Enhanced data service wrapper with integrated security and performance
 */
export function createSecureDataService<T extends Record<string, any>>(
  serviceName: string,
  baseService: T
): T {
  const wrappedService = {} as T

  for (const [methodName, method] of Object.entries(baseService)) {
    if (typeof method === 'function') {
      wrappedService[methodName as keyof T] = (async (...args: any[]) => {
        const startTime = Date.now()
        const requestId = generateRequestId()
        
        const errorContext = createErrorContext(`${serviceName}.${methodName}`, {
          requestId
        })

        return withErrorHandling(
          async () => {
            // Audit log the data service operation
            const auditLogger = getAuditLogger()
            await auditLogger.logEvent(
              AuditEventType.DATA_ACCESSED,
              `Data service operation: ${serviceName}.${methodName}`,
              {
                serviceName,
                methodName,
                requestId,
                argsCount: args.length
              },
              AuditSeverity.INFO,
              true
            )

            // Execute the original method
            const result = await method.apply(baseService, args)
            
            const duration = Date.now() - startTime

            // Log successful completion
            await auditLogger.logEvent(
              AuditEventType.DATA_ACCESSED,
              `Data service operation completed: ${serviceName}.${methodName}`,
              {
                serviceName,
                methodName,
                requestId,
                duration,
                resultCount: Array.isArray(result) ? result.length : 1
              },
              AuditSeverity.INFO,
              true
            )

            return result
          },
          errorContext,
          (cause) => {
            // Log the error
            const auditLogger = getAuditLogger()
            auditLogger.logEvent(
              AuditEventType.API_ERROR,
              `Data service error: ${serviceName}.${methodName}`,
              {
                serviceName,
                methodName,
                requestId,
                errorMessage: cause.message
              },
              AuditSeverity.ERROR,
              false
            ).catch(console.error)

            return ErrorFactory.generic.internalServerError(
              `${serviceName}.${methodName}`,
              cause,
              errorContext
            )
          }
        )
      }) as any
    } else {
      wrappedService[methodName as keyof T] = method
    }
  }

  return wrappedService
}

/**
 * Performance monitoring middleware
 */
export function performanceMonitoringMiddleware() {
  return (req: NextApiRequest, res: NextApiResponse, next: () => void) => {
    const startTime = Date.now()
    const requestId = generateRequestId()

    // Add request ID to headers
    res.setHeader('X-Request-ID', requestId)

    // Override res.json to capture response time
    const originalJson = res.json
    res.json = function(data: any) {
      const duration = Date.now() - startTime
      
      // Log performance metrics
      const auditLogger = getAuditLogger()
      auditLogger.logEvent(
        AuditEventType.PERFORMANCE_ISSUE,
        `API performance: ${req.method} ${req.url}`,
        {
          endpoint: req.url,
          method: req.method,
          duration,
          requestId,
          responseSize: JSON.stringify(data).length
        },
        duration > 5000 ? AuditSeverity.WARNING : AuditSeverity.INFO,
        true
      ).catch(console.error)

      return originalJson.call(this, data)
    }

    next()
  }
}

/**
 * Security headers middleware
 */
export function securityHeadersMiddleware() {
  return (req: NextApiRequest, res: NextApiResponse, next: () => void) => {
    // Set security headers
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('X-XSS-Protection', '1; mode=block')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    
    // HSTS header for HTTPS
    if (req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }

    next()
  }
}

/**
 * Extract project information from request
 */
function extractProjectInfo(req: NextApiRequest): { projectId: number; projectRef: string } | null {
  // Try to get project ref from URL parameters
  const projectRef = req.query.ref as string
  if (!projectRef) {
    return null
  }

  // In a real implementation, this would query the database to get project ID
  // For now, we'll use a mock implementation
  const projectId = parseInt(projectRef.replace(/\D/g, '')) || 1

  return { projectId, projectRef }
}

/**
 * Build cache key for request
 */
function buildCacheKey(req: NextApiRequest, context: ApiHandlerContext): string {
  const parts = [
    req.url,
    req.method,
    context.projectId,
    context.userId,
    JSON.stringify(req.query),
    req.method === 'POST' ? JSON.stringify(req.body) : ''
  ]
  
  return parts.filter(Boolean).join(':')
}

/**
 * Get client IP address
 */
function getClientIp(req: NextApiRequest): string {
  return (
    req.headers['x-forwarded-for'] as string ||
    req.headers['x-real-ip'] as string ||
    req.socket?.remoteAddress ||
    'unknown'
  )
}

/**
 * Generate unique request ID
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`
}

/**
 * Health check endpoint with integrated monitoring
 */
export const healthCheckHandler = createIntegratedApiHandler({
  requiredPermission: 'canRead',
  enableCaching: false,
  auditEvent: AuditEventType.DATA_ACCESSED
})(async (req, res, context) => {
  const auditLogger = getAuditLogger()
  const queryOptimizer = getQueryOptimizer()
  const securityValidator = getSecurityValidator()

  // Get system health metrics
  const performanceStats = queryOptimizer.getPerformanceAnalytics()
  const auditStats = await auditLogger.queryLogs({ limit: 1 })
  
  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    projectId: context.projectId,
    userId: context.userId,
    metrics: {
      cache: performanceStats.cacheStats,
      queries: Object.keys(performanceStats.queryStats).length,
      auditEvents: auditStats.length,
      uptime: process.uptime()
    }
  }
})

/**
 * Export all integrated utilities
 */
export { getSecurityValidator } from './security-validations'
export { getQueryOptimizer } from './query-optimizations'
export { getAuditLogger } from './audit-logging'

export * from './query-optimizations'
export * from './audit-logging'
export * from './security-validations'