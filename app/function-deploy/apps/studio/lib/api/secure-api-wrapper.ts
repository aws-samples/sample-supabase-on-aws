import { NextApiRequest, NextApiResponse } from 'next'
import { 
  withProjectIsolation, 
  withReadAccess, 
  withWriteAccess, 
  withAdminAccess,
  withApiKeyManagement,
  withJwtKeyManagement,
  ProjectIsolationContext,
  PermissionRequirements 
} from './project-isolation-middleware'
import { 
  ProjectManagementError, 
  ErrorFactory, 
  handleApiError, 
  createErrorContext 
} from './error-handling'
import {
  createErrorHandlingMiddleware,
  RequestValidationRules,
  PerformanceLimits
} from './enhanced-error-middleware'

// Re-export types for use in API handlers
export type { ProjectIsolationContext, PermissionRequirements } from './project-isolation-middleware'

/**
 * Security configuration for API endpoints
 */
export interface SecurityConfig {
  /** Permission requirements for the endpoint */
  permissions?: PermissionRequirements
  /** Whether to validate data ownership on response */
  validateDataOwnership?: boolean
  /** Custom validation function */
  customValidation?: (context: ProjectIsolationContext) => Promise<void>
}

/**
 * Enhanced security configuration with error handling
 */
export interface EnhancedSecurityConfig extends SecurityConfig {
  /** Enhanced error handling configuration */
  errorHandling?: {
    validation?: RequestValidationRules
    performance?: PerformanceLimits
    contentTypes?: string[]
  }
}

/**
 * API handler function type with project context
 */
export type SecureApiHandler<T = any> = (
  req: NextApiRequest,
  res: NextApiResponse,
  context: ProjectIsolationContext
) => Promise<T>

/**
 * Higher-order function to wrap API handlers with comprehensive security
 * 
 * This is the main security wrapper that provides:
 * - User authentication
 * - Project access validation
 * - Permission level checking
 * - Data ownership validation
 * - Security audit logging
 * 
 * @param handler - API handler function
 * @param config - Security configuration
 * @returns Wrapped API handler with security
 */
export function withSecureProjectAccess<T = any>(
  handler: SecureApiHandler<T>,
  config: SecurityConfig = {}
) {
  return withProjectIsolation(
    async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
      const errorContext = createErrorContext('withSecureProjectAccess', {
        endpoint: req.url,
        projectId: context.projectId,
        projectRef: context.projectRef,
        userId: context.userId,
        userAgent: req.headers['user-agent'],
        ip: req.headers['x-forwarded-for'] as string || req.connection.remoteAddress
      })

      try {
        // Run custom validation if provided
        if (config.customValidation) {
          await config.customValidation(context)
        }

        // Log successful access for security audit
        console.log('Secure API access granted', {
          userId: context.userId,
          projectId: context.projectId,
          projectRef: context.projectRef,
          endpoint: req.url,
          method: req.method,
          accessType: context.accessResult.accessType,
          permissions: context.permissions,
          timestamp: new Date().toISOString()
        })

        // Execute the handler
        const result = await handler(req, res, context)

        return result
      } catch (error) {
        // Log security violations
        console.warn('Secure API access violation', {
          userId: context.userId,
          projectId: context.projectId,
          projectRef: context.projectRef,
          endpoint: req.url,
          method: req.method,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        })

        throw error
      }
    },
    config.permissions
  )
}

/**
 * Wrapper for read-only endpoints (GET requests)
 * Requires read permission
 */
export function withSecureReadAccess<T = any>(
  handler: SecureApiHandler<T>,
  config: Omit<SecurityConfig, 'permissions'> = {}
) {
  return withSecureProjectAccess(handler, {
    ...config,
    permissions: { read: true }
  })
}

/**
 * Wrapper for write endpoints (POST, PUT, PATCH requests)
 * Requires read and write permissions
 */
export function withSecureWriteAccess<T = any>(
  handler: SecureApiHandler<T>,
  config: Omit<SecurityConfig, 'permissions'> = {}
) {
  return withSecureProjectAccess(handler, {
    ...config,
    permissions: { read: true, write: true }
  })
}

/**
 * Wrapper for admin endpoints (DELETE, admin operations)
 * Requires read, write, and admin permissions
 */
export function withSecureAdminAccess<T = any>(
  handler: SecureApiHandler<T>,
  config: Omit<SecurityConfig, 'permissions'> = {}
) {
  return withSecureProjectAccess(handler, {
    ...config,
    permissions: { read: true, write: true, admin: true }
  })
}

/**
 * Wrapper for API key management endpoints
 * Requires read and API key management permissions
 */
export function withSecureApiKeyAccess<T = any>(
  handler: SecureApiHandler<T>,
  config: Omit<SecurityConfig, 'permissions'> = {}
) {
  return withSecureProjectAccess(handler, {
    ...config,
    permissions: { read: true, manageApiKeys: true }
  })
}

/**
 * Wrapper for JWT key management endpoints
 * Requires read and JWT key management permissions
 */
export function withSecureJwtKeyAccess<T = any>(
  handler: SecureApiHandler<T>,
  config: Omit<SecurityConfig, 'permissions'> = {}
) {
  return withSecureProjectAccess(handler, {
    ...config,
    permissions: { read: true, manageJwtKeys: true }
  })
}

/**
 * Wrapper for delete operations
 * Requires read, write, and delete permissions
 */
export function withSecureDeleteAccess<T = any>(
  handler: SecureApiHandler<T>,
  config: Omit<SecurityConfig, 'permissions'> = {}
) {
  return withSecureProjectAccess(handler, {
    ...config,
    permissions: { read: true, write: true, delete: true }
  })
}

/**
 * Enhanced API wrapper with comprehensive security and error handling
 * 
 * This wrapper provides:
 * - All security features from withSecureProjectAccess
 * - Enhanced error handling with PostgREST compatibility
 * - Request validation
 * - Performance monitoring
 * - Content negotiation
 * 
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */
export function withSecureApiWrapper<T = any>(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<T>,
  config: EnhancedSecurityConfig & {
    requireProjectContext?: boolean
    requireDataApiAccess?: boolean
  } = {}
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    // Apply error handling middleware if configured
    if (config.errorHandling) {
      const middlewares = createErrorHandlingMiddleware(config.errorHandling)
      
      // Apply middlewares in sequence
      for (const middleware of middlewares) {
        await new Promise<void>((resolve, reject) => {
          middleware(req, res, () => {
            if (res.headersSent) {
              reject(new Error('Response already sent'))
            } else {
              resolve()
            }
          })
        })
        
        // If response was sent by middleware, stop processing
        if (res.headersSent) {
          return
        }
      }
    }

    // If project context is required, wrap with project isolation
    if (config.requireProjectContext) {
      const secureHandler = withSecureProjectAccess(
        async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
          // Inject project context into request for handler access
          ;(req as any).projectContext = context
          return handler(req, res)
        },
        config
      )
      
      return secureHandler(req, res)
    } else {
      // Execute handler directly
      return handler(req, res)
    }
  }
}
export function withMethodBasedSecurity<T = any>(
  handler: SecureApiHandler<T>,
  config: Omit<SecurityConfig, 'permissions'> = {}
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const method = req.method?.toUpperCase()
    
    let permissions: PermissionRequirements = { read: true }
    
    switch (method) {
      case 'GET':
      case 'HEAD':
        permissions = { read: true }
        break
      case 'POST':
      case 'PUT':
      case 'PATCH':
        permissions = { read: true, write: true }
        break
      case 'DELETE':
        permissions = { read: true, write: true, delete: true }
        break
      default:
        permissions = { read: true }
    }
    
    return withSecureProjectAccess(handler, {
      ...config,
      permissions
    })(req, res)
  }
}


export function hasPermission(
  context: ProjectIsolationContext,
  permission: keyof ProjectIsolationContext['permissions']
): boolean {
  return context.permissions[permission]
}

/**
 * Utility function to require specific permission
 * Throws error if permission is not granted
 */
export function requirePermission(
  context: ProjectIsolationContext,
  permission: keyof ProjectIsolationContext['permissions'],
  customMessage?: string
): void {
  if (!context.permissions[permission]) {
    const errorContext = createErrorContext('requirePermission', {
      userId: context.userId,
      projectId: context.projectId,
      projectRef: context.projectRef
    })
    
    throw ErrorFactory.auth.insufficientPermissions(
      customMessage || `permission '${permission}'`,
      errorContext
    )
  }
}

/**
 * Utility function to check if user is project owner
 */
export function isProjectOwner(context: ProjectIsolationContext): boolean {
  return context.accessResult.accessType === 'owner'
}

/**
 * Utility function to check if user is organization member
 */
export function isOrganizationMember(context: ProjectIsolationContext): boolean {
  return context.accessResult.accessType === 'organization_member'
}

/**
 * Utility function to require project ownership
 * Throws error if user is not the project owner
 */
export function requireProjectOwnership(
  context: ProjectIsolationContext,
  customMessage?: string
): void {
  if (!isProjectOwner(context)) {
    const errorContext = createErrorContext('requireProjectOwnership', {
      userId: context.userId,
      projectId: context.projectId,
      projectRef: context.projectRef
    })
    
    throw ErrorFactory.auth.insufficientPermissions(
      customMessage || 'project ownership',
      errorContext
    )
  }
}

/**
 * Create a custom security validator
 */
export function createSecurityValidator(
  validator: (context: ProjectIsolationContext) => Promise<void>
): SecurityConfig['customValidation'] {
  return validator
}

/**
 * Common security validators
 */
export const SecurityValidators = {
  /**
   * Require project ownership
   */
  requireOwnership: createSecurityValidator(async (context) => {
    requireProjectOwnership(context)
  }),

  /**
   * Require specific permission
   */
  requirePermission: (permission: keyof ProjectIsolationContext['permissions']) =>
    createSecurityValidator(async (context) => {
      requirePermission(context, permission)
    }),

  /**
   * Require multiple permissions
   */
  requirePermissions: (permissions: (keyof ProjectIsolationContext['permissions'])[]) =>
    createSecurityValidator(async (context) => {
      permissions.forEach(permission => {
        requirePermission(context, permission)
      })
    }),

  /**
   * Custom validation function
   */
  custom: (validator: (context: ProjectIsolationContext) => Promise<void>) =>
    createSecurityValidator(validator)
}

/**
 * Export commonly used security configurations
 */
export const SecurityConfigs = {
  /** Read-only access */
  readOnly: { permissions: { read: true } } as SecurityConfig,
  
  /** Write access */
  write: { permissions: { read: true, write: true } } as SecurityConfig,
  
  /** Admin access */
  admin: { permissions: { read: true, write: true, admin: true } } as SecurityConfig,
  
  /** API key management */
  apiKeys: { permissions: { read: true, manageApiKeys: true } } as SecurityConfig,
  
  /** JWT key management */
  jwtKeys: { permissions: { read: true, manageJwtKeys: true } } as SecurityConfig,
  
  /** Delete operations */
  delete: { permissions: { read: true, write: true, delete: true } } as SecurityConfig,
  
  /** Owner only */
  ownerOnly: { 
    permissions: { read: true, write: true, admin: true },
    customValidation: SecurityValidators.requireOwnership
  } as SecurityConfig
}

/**
 * Legacy alias for backward compatibility
 * @deprecated Use withSecureApiWrapper instead
 */
export const createSecureApiWrapper = withSecureApiWrapper