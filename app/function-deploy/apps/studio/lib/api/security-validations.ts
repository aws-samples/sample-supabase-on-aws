/**
 * Enhanced security validations for project access
 * 
 * This module provides comprehensive security validations including:
 * - Enhanced authentication and authorization
 * - Project access control with role-based permissions
 * - Rate limiting and request validation
 * - Security audit logging
 * 
 * Requirements: Security and performance considerations
 */

import { NextApiRequest } from 'next'
import { getCurrentUserId, validateUserProjectAccess, getUserProjectPermissions } from './auth-helpers'
import { 
  ProjectManagementError, 
  ErrorFactory, 
  createErrorContext,
  withErrorHandling 
} from './error-handling'

/**
 * User permissions for project operations
 */
export interface ProjectPermissions {
  canRead: boolean
  canWrite: boolean
  canAdmin: boolean
  canDelete: boolean
  canViewLogs: boolean
  canViewMonitoring: boolean
  canViewAdvisor: boolean
}

/**
 * Security validation result
 */
export interface SecurityValidationResult {
  isValid: boolean
  userId: string
  permissions: ProjectPermissions
  reason?: string
}

/**
 * Rate limiting configuration
 */
interface RateLimitConfig {
  windowMs: number  // Time window in milliseconds
  maxRequests: number  // Maximum requests per window
  skipSuccessfulRequests?: boolean
}

/**
 * Request validation result
 */
interface RequestValidationResult {
  isValid: boolean
  reason?: string
  remainingRequests?: number
}

/**
 * Enhanced security validator class
 */
export class SecurityValidator {
  private rateLimitStore = new Map<string, { count: number; resetTime: number }>()
  
  /**
   * Validate comprehensive project access with enhanced security checks
   * 
   * @param req - API request object
   * @param projectId - Project ID to validate access for
   * @param requiredPermission - Required permission level
   * @returns Security validation result
   * @throws ProjectManagementError if validation fails
   */
  async validateProjectAccess(
    req: NextApiRequest,
    projectId: number,
    requiredPermission: keyof ProjectPermissions = 'canRead'
  ): Promise<SecurityValidationResult> {
    const errorContext = createErrorContext('validateProjectAccess', {
      projectId,
      endpoint: req.url,
      userAgent: req.headers['user-agent'] as string,
      ip: this.getClientIp(req)
    })

    return withErrorHandling(
      async () => {
        // 1. Validate request format and headers
        const requestValidation = this.validateRequest(req)
        if (!requestValidation.isValid) {
          throw ErrorFactory.validation.invalidInput('request', requestValidation.reason || 'Invalid request format', errorContext)
        }

        // 2. Check rate limiting
        const rateLimitValidation = this.checkRateLimit(req, {
          windowMs: 60000, // 1 minute
          maxRequests: 100, // 100 requests per minute
          skipSuccessfulRequests: true
        })
        
        if (!rateLimitValidation.isValid) {
          throw ErrorFactory.generic.networkError(rateLimitValidation.reason || 'Rate limit exceeded', errorContext)
        }

        // 3. Authenticate user
        const userId = await getCurrentUserId(req)
        if (!userId) {
          throw ErrorFactory.auth.notAuthenticated(errorContext)
        }

        // 4. Validate project access
        const hasAccess = await validateUserProjectAccess(userId, projectId)
        if (!hasAccess) {
          throw ErrorFactory.dataIsolation.accessDenied(`${projectId}`, errorContext)
        }

        // 5. Get detailed permissions
        const permissions = await this.getEnhancedProjectPermissions(userId, projectId)
        
        // 6. Check specific permission requirement
        if (!permissions[requiredPermission]) {
          throw ErrorFactory.auth.insufficientPermissions(
            `${requiredPermission} permission for project ${projectId}`,
            errorContext
          )
        }

        // 7. Additional security checks
        await this.performAdditionalSecurityChecks(req, userId, projectId)

        return {
          isValid: true,
          userId,
          permissions
        }
      },
      errorContext,
      (cause) => ErrorFactory.generic.internalServerError('security validation', cause, errorContext)
    )
  }

  /**
   * Validate API request format and headers
   * 
   * @param req - API request object
   * @returns Validation result
   */
  private validateRequest(req: NextApiRequest): RequestValidationResult {
    // Check for required headers
    if (!req.headers['user-agent']) {
      return {
        isValid: false,
        reason: 'Missing User-Agent header'
      }
    }

    // Validate Content-Type for POST/PUT/PATCH requests
    if (['POST', 'PUT', 'PATCH'].includes(req.method || '')) {
      const contentType = req.headers['content-type']
      if (!contentType || !contentType.includes('application/json')) {
        return {
          isValid: false,
          reason: 'Invalid or missing Content-Type header for write operations'
        }
      }
    }

    // Check for suspicious patterns in headers
    const suspiciousPatterns = [
      /script/i,
      /javascript/i,
      /vbscript/i,
      /onload/i,
      /onerror/i
    ]

    for (const [headerName, headerValue] of Object.entries(req.headers)) {
      if (typeof headerValue === 'string') {
        for (const pattern of suspiciousPatterns) {
          if (pattern.test(headerValue)) {
            return {
              isValid: false,
              reason: `Suspicious content detected in ${headerName} header`
            }
          }
        }
      }
    }

    return { isValid: true }
  }

  /**
   * Check rate limiting for requests
   * 
   * @param req - API request object
   * @param config - Rate limit configuration
   * @returns Rate limit validation result
   */
  private checkRateLimit(req: NextApiRequest, config: RateLimitConfig): RequestValidationResult {
    const clientId = this.getClientIdentifier(req)
    const now = Date.now()
    const windowStart = now - config.windowMs

    // Clean up expired entries
    for (const [key, value] of this.rateLimitStore.entries()) {
      if (value.resetTime < now) {
        this.rateLimitStore.delete(key)
      }
    }

    // Get or create rate limit entry
    let rateLimitEntry = this.rateLimitStore.get(clientId)
    
    if (!rateLimitEntry || rateLimitEntry.resetTime < now) {
      rateLimitEntry = {
        count: 0,
        resetTime: now + config.windowMs
      }
      this.rateLimitStore.set(clientId, rateLimitEntry)
    }

    // Check if limit exceeded
    if (rateLimitEntry.count >= config.maxRequests) {
      return {
        isValid: false,
        reason: `Rate limit exceeded: ${config.maxRequests} requests per ${config.windowMs}ms`,
        remainingRequests: 0
      }
    }

    // Increment counter
    rateLimitEntry.count++
    
    return {
      isValid: true,
      remainingRequests: config.maxRequests - rateLimitEntry.count
    }
  }

  /**
   * Get enhanced project permissions with role-based access control
   * 
   * @param userId - User ID
   * @param projectId - Project ID
   * @returns Enhanced project permissions
   */
  private async getEnhancedProjectPermissions(userId: string, projectId: number): Promise<ProjectPermissions> {
    const errorContext = createErrorContext('getEnhancedProjectPermissions', { userId, projectId })

    return withErrorHandling(
      async () => {
        // Get base permissions
        const basePermissions = await getUserProjectPermissions(userId, projectId)
        
        // In a real implementation, this would query user roles and project-specific permissions
        // For now, we'll enhance the base permissions with additional checks
        
        // Enhanced permissions based on user role and project settings
        const enhancedPermissions: ProjectPermissions = {
          canRead: basePermissions.canRead,
          canWrite: basePermissions.canWrite,
          canAdmin: basePermissions.canAdmin,
          canDelete: basePermissions.canDelete,
          canViewLogs: basePermissions.canRead, // Logs require read permission
          canViewMonitoring: basePermissions.canRead, // Monitoring requires read permission
          canViewAdvisor: basePermissions.canRead, // Advisor requires read permission
        }

        // Additional role-based restrictions could be applied here
        // For example, only admin users can view certain sensitive data
        
        return enhancedPermissions
      },
      errorContext,
      (cause) => ErrorFactory.generic.internalServerError('permission check', cause, errorContext)
    )
  }

  /**
   * Perform additional security checks
   * 
   * @param req - API request object
   * @param userId - User ID
   * @param projectId - Project ID
   */
  private async performAdditionalSecurityChecks(
    req: NextApiRequest,
    userId: string,
    projectId: number
  ): Promise<void> {
    const errorContext = createErrorContext('performAdditionalSecurityChecks', { userId, projectId })

    return withErrorHandling(
      async () => {
        // 1. Check for suspicious IP addresses (in real implementation, this would check against a blacklist)
        const clientIp = this.getClientIp(req)
        if (this.isSuspiciousIp(clientIp)) {
          throw ErrorFactory.dataIsolation.ownershipViolation(`Suspicious IP address: ${clientIp}`, errorContext)
        }

        // 2. Check for unusual request patterns
        const userAgent = req.headers['user-agent'] as string
        if (this.isSuspiciousUserAgent(userAgent)) {
          throw ErrorFactory.dataIsolation.ownershipViolation(`Suspicious User-Agent: ${userAgent}`, errorContext)
        }

        // 3. Validate request timing (prevent replay attacks)
        const timestamp = req.headers['x-timestamp'] as string
        if (timestamp && this.isStaleRequest(timestamp)) {
          throw ErrorFactory.routing.sessionExpired(errorContext)
        }

        // 4. Check for concurrent session limits (in real implementation)
        // This would check if the user has too many active sessions
        
        // 5. Validate project status (ensure project is not suspended/deleted)
        const isProjectActive = await this.validateProjectStatus(projectId)
        if (!isProjectActive) {
          throw ErrorFactory.dataIsolation.invalidProjectId(projectId, errorContext)
        }
      },
      errorContext,
      (cause) => ErrorFactory.generic.internalServerError('security check', cause, errorContext)
    )
  }

  /**
   * Get client IP address from request
   * 
   * @param req - API request object
   * @returns Client IP address
   */
  private getClientIp(req: NextApiRequest): string {
    return (
      req.headers['x-forwarded-for'] as string ||
      req.headers['x-real-ip'] as string ||
      req.socket?.remoteAddress ||
      'unknown'
    )
  }

  /**
   * Get unique client identifier for rate limiting
   * 
   * @param req - API request object
   * @returns Client identifier
   */
  private getClientIdentifier(req: NextApiRequest): string {
    // Combine IP and User-Agent for more accurate rate limiting
    const ip = this.getClientIp(req)
    const userAgent = req.headers['user-agent'] || 'unknown'
    return `${ip}:${userAgent.substring(0, 50)}` // Limit length to prevent memory issues
  }

  /**
   * Check if IP address is suspicious
   * 
   * @param ip - IP address to check
   * @returns True if suspicious
   */
  private isSuspiciousIp(ip: string): boolean {
    // In a real implementation, this would check against:
    // - Known malicious IP databases
    // - Geographic restrictions
    // - Corporate IP whitelist/blacklist
    
    // For now, just check for obviously invalid IPs
    if (ip === 'unknown' || ip === '0.0.0.0') {
      return false // Don't block unknown IPs in development
    }
    
    // Block localhost in production (example)
    if (process.env.NODE_ENV === 'production' && (ip === '127.0.0.1' || ip === '::1')) {
      return true
    }
    
    return false
  }

  /**
   * Check if User-Agent is suspicious
   * 
   * @param userAgent - User-Agent string to check
   * @returns True if suspicious
   */
  private isSuspiciousUserAgent(userAgent: string): boolean {
    if (!userAgent) return true
    
    // Check for common bot patterns
    const botPatterns = [
      /bot/i,
      /crawler/i,
      /spider/i,
      /scraper/i,
      /curl/i,
      /wget/i,
      /python/i,
      /java/i
    ]
    
    // Allow legitimate bots but flag obvious scrapers
    const suspiciousPatterns = [
      /scraper/i,
      /hack/i,
      /exploit/i,
      /attack/i
    ]
    
    return suspiciousPatterns.some(pattern => pattern.test(userAgent))
  }

  /**
   * Check if request timestamp is stale (replay attack prevention)
   * 
   * @param timestamp - Request timestamp
   * @returns True if request is stale
   */
  private isStaleRequest(timestamp: string): boolean {
    try {
      const requestTime = new Date(timestamp).getTime()
      const now = Date.now()
      const maxAge = 5 * 60 * 1000 // 5 minutes
      
      return (now - requestTime) > maxAge
    } catch {
      return true // Invalid timestamp format
    }
  }

  /**
   * Validate project status
   * 
   * @param projectId - Project ID to validate
   * @returns True if project is active
   */
  private async validateProjectStatus(projectId: number): Promise<boolean> {
    // In a real implementation, this would query the database
    // to check if the project is active, not suspended, etc.
    
    // Mock implementation - assume all projects are active
    return projectId > 0
  }

  /**
   * Clear rate limit data (useful for testing)
   */
  clearRateLimitData(): void {
    this.rateLimitStore.clear()
  }

  /**
   * Get rate limit status for a client
   * 
   * @param req - API request object
   * @returns Rate limit status
   */
  getRateLimitStatus(req: NextApiRequest): { count: number; resetTime: number } | null {
    const clientId = this.getClientIdentifier(req)
    return this.rateLimitStore.get(clientId) || null
  }
}

/**
 * Singleton instance of the security validator
 */
let securityValidatorInstance: SecurityValidator | null = null

/**
 * Get the singleton SecurityValidator instance
 * 
 * @returns SecurityValidator instance
 */
export function getSecurityValidator(): SecurityValidator {
  if (!securityValidatorInstance) {
    securityValidatorInstance = new SecurityValidator()
  }
  return securityValidatorInstance
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetSecurityValidator(): void {
  securityValidatorInstance = null
}

/**
 * Higher-order function to wrap API handlers with enhanced security validation
 * 
 * @param requiredPermission - Required permission level
 * @returns Wrapped API handler with security validation
 */
export function withEnhancedSecurity<T = any>(
  requiredPermission: keyof ProjectPermissions = 'canRead'
) {
  return function(
    handler: (
      req: NextApiRequest,
      res: any,
      context: { projectId: number; userId: string; permissions: ProjectPermissions }
    ) => Promise<T>
  ) {
    return async (req: NextApiRequest, res: any, context: { projectId: number }): Promise<void> => {
      const errorContext = createErrorContext('withEnhancedSecurity', {
        projectId: context.projectId,
        endpoint: req.url
      })

      try {
        const validator = getSecurityValidator()
        const validation = await validator.validateProjectAccess(req, context.projectId, requiredPermission)
        
        if (!validation.isValid) {
          throw ErrorFactory.generic.internalServerError('Security validation failed', undefined, errorContext)
        }

        // Add security context to the handler
        const securityContext = {
          ...context,
          userId: validation.userId,
          permissions: validation.permissions
        }

        const result = await handler(req, res, securityContext)
        
        // If result is not already sent by handler, send it
        if (result !== undefined && !res.headersSent) {
          res.status(200).json(result)
        }
      } catch (error) {
        if (error instanceof ProjectManagementError) {
          // Handle security errors appropriately
          const statusCode = error.code.startsWith('AUTH') ? 401 : 
                           error.code.startsWith('PERM') ? 403 : 500
          
          res.status(statusCode).json({
            error: error.code,
            message: error.message,
            timestamp: new Date().toISOString()
          })
          return
        }
        
        // Handle unexpected errors
        res.status(500).json({
          error: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred',
          timestamp: new Date().toISOString()
        })
      }
    }
  }
}