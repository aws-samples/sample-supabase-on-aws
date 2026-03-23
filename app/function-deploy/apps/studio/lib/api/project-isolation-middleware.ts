import { NextApiRequest, NextApiResponse } from 'next'
import { 
  getCurrentUserId, 
  validateUserProjectAccess,
  validateUserProjectAccessByRef,
  getUserProjectPermissions,
  ProjectAccessResult 
} from './auth-helpers'
import { 
  ProjectManagementError, 
  ErrorFactory, 
  handleApiError, 
  createErrorContext,
  withErrorHandling 
} from './error-handling'

/**
 * Project isolation context extracted from request
 */
export interface ProjectIsolationContext {
  projectRef: string
  projectId: number
  userId: string
  accessResult: ProjectAccessResult
  permissions: {
    canRead: boolean
    canWrite: boolean
    canAdmin: boolean
    canDelete: boolean
    canManageApiKeys: boolean
    canManageJwtKeys: boolean
  }
}

/**
 * Permission level requirements for API endpoints
 */
export interface PermissionRequirements {
  read?: boolean
  write?: boolean
  admin?: boolean
  delete?: boolean
  manageApiKeys?: boolean
  manageJwtKeys?: boolean
}

/**
 * Query with project filtering applied
 */
export interface IsolatedQuery {
  baseQuery: string
  projectFilter: string
  params: any[]
}

/**
 * Data validation result
 */
export interface DataOwnershipResult {
  isValid: boolean
  reason?: string
  details?: {
    totalItems?: number
    invalidCount?: number
    validCount?: number
    leakedProjects?: number[]
    leakedItemsCount?: number
  }
}

/**
 * Project isolation middleware for ensuring multi-tenant data isolation
 * 
 * This middleware provides:
 * - Project context extraction from requests
 * - Automatic project_id filtering for database queries
 * - Data ownership validation
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */
export class ProjectIsolationMiddleware {
  /**
   * Extract project context from API request with permission validation
   * 
   * @param req - Next.js API request object
   * @param permissionRequirements - Optional permission requirements to validate
   * @returns Project context including ref, ID, user ID, access result, and permissions
   * @throws ProjectManagementError if project context cannot be extracted or permissions are insufficient
   */
  async extractProjectContext(
    req: NextApiRequest, 
    permissionRequirements?: PermissionRequirements
  ): Promise<ProjectIsolationContext> {
    const errorContext = createErrorContext('extractProjectContext', {
      endpoint: req.url,
      userAgent: req.headers['user-agent'],
      ip: req.headers['x-forwarded-for'] as string || req.connection.remoteAddress
    })

    return withErrorHandling(
      async () => {
        console.log('[ProjectIsolation] Starting context extraction', {
          endpoint: req.url,
          method: req.method,
          hasAuthHeader: !!req.headers.authorization,
          hasApikey: !!req.headers.apikey,
          hasCookies: !!req.cookies && Object.keys(req.cookies).length > 0
        })

        // Extract project ref from URL path or query parameters
        const projectRef = this.extractProjectRef(req)
        if (!projectRef) {
          console.error('[ProjectIsolation] Failed to extract project ref from request', {
            url: req.url,
            query: req.query
          })
          throw ErrorFactory.routing.invalidProjectRef('', errorContext)
        }

        console.log('[ProjectIsolation] Extracted project ref:', projectRef)

        // Check for no-auth mode
        const noAuthMode = process.env.STUDIO_NO_AUTH_MODE === 'true'
        if (noAuthMode) {
          console.log('[ProjectIsolation] No-auth mode enabled, bypassing authentication')
          const projectId = await this.getProjectIdFromRef(projectRef)
          if (!projectId) {
            throw ErrorFactory.projectDeletion.projectNotFound(projectRef, errorContext)
          }
          return {
            projectRef,
            projectId,
            userId: 'system',
            accessResult: {
              hasAccess: true,
              accessType: 'owner' as const,
              reason: 'No-auth mode enabled'
            },
            permissions: {
              canRead: true,
              canWrite: true,
              canAdmin: true,
              canDelete: true,
              canManageApiKeys: true,
              canManageJwtKeys: true
            }
          }
        }

        // Get authenticated user ID
        // Note: We no longer require project_ref claim in JWT (GoTrue doesn't include it)
        // Project access is verified via database queries below
        const userId = await getCurrentUserId(req, projectRef)
        
        console.log('[ProjectIsolation] Authentication result:', {
          userId: userId ? (userId === 'service_role' ? 'service_role' : 'authenticated_user') : 'null',
          projectRef
        })
        
        // Check if this is a SERVICE_ROLE_KEY request
        if (userId === 'service_role') {
          console.log('[ProjectIsolation] SERVICE_ROLE_KEY detected, bypassing project isolation checks')
          
          // For SERVICE_ROLE_KEY, we still need to get the project ID but skip user validation
          const projectId = await this.getProjectIdFromRef(projectRef)
          if (!projectId) {
            console.error('[ProjectIsolation] Project not found for SERVICE_ROLE_KEY request:', projectRef)
            throw ErrorFactory.projectDeletion.projectNotFound(projectRef, errorContext)
          }

          console.log('[ProjectIsolation] SERVICE_ROLE_KEY context created successfully')
          
          // Return context with service role permissions (full access)
          return {
            projectRef,
            projectId,
            userId: 'service_role',
            accessResult: {
              hasAccess: true,
              accessType: 'owner' as const,
              reason: 'SERVICE_ROLE_KEY access'
            },
            permissions: {
              canRead: true,
              canWrite: true,
              canAdmin: true,
              canDelete: true,
              canManageApiKeys: true,
              canManageJwtKeys: true
            }
          }
        }
        
        if (!userId) {
          console.error('[ProjectIsolation] Authentication failed - no valid user ID', {
            projectRef,
            endpoint: req.url,
            hasAuthHeader: !!req.headers.authorization,
            hasApikey: !!req.headers.apikey
          })
          throw ErrorFactory.auth.notAuthenticated(errorContext)
        }

        console.log('[ProjectIsolation] Validating user project access')

        // Validate user access to the project using database-based verification
        // This queries the studio_projects table to check user-project relationships
        // Requirements: 11.7, 11.8
        const accessResult = await validateUserProjectAccessByRef(userId, projectRef)
        if (!accessResult.hasAccess) {
          console.error('[ProjectIsolation] User access validation failed', {
            userId,
            projectRef,
            accessType: accessResult.accessType,
            reason: accessResult.reason
          })
          throw ErrorFactory.auth.insufficientPermissions(
            `project ${projectRef}`,
            errorContext
          )
        }

        console.log('[ProjectIsolation] User access validated:', {
          userId,
          projectRef,
          accessType: accessResult.accessType
        })

        // Get project ID from project ref (needed for permissions and data access)
        const projectId = await this.getProjectIdFromRef(projectRef)
        if (!projectId) {
          console.error('[ProjectIsolation] Failed to get project ID from ref:', projectRef)
          throw ErrorFactory.projectDeletion.projectNotFound(projectRef, errorContext)
        }

        console.log('[ProjectIsolation] Project ID resolved:', projectId)

        // Get user permissions for the project
        const permissions = await getUserProjectPermissions(userId, projectId)

        console.log('[ProjectIsolation] User permissions retrieved:', {
          userId,
          projectId,
          permissions
        })

        // Validate permission requirements if specified
        if (permissionRequirements) {
          console.log('[ProjectIsolation] Validating permission requirements:', permissionRequirements)
          this.validatePermissionRequirements(permissions, permissionRequirements, errorContext)
        }

        console.log('[ProjectIsolation] Context extraction completed successfully')

        return {
          projectRef,
          projectId,
          userId,
          accessResult,
          permissions
        }
      },
      errorContext,
      (cause) => {
        console.error('[ProjectIsolation] Context extraction failed with error:', {
          cause: cause instanceof Error ? cause.message : cause,
          stack: cause instanceof Error ? cause.stack : undefined,
          endpoint: req.url,
          projectRef: this.extractProjectRef(req)
        })
        return ErrorFactory.dataIsolation.isolationFailed('extractProjectContext', cause, errorContext)
      }
    )
  }

  /**
   * Validate that user has required permissions
   * 
   * @param permissions - User's actual permissions
   * @param requirements - Required permissions
   * @param errorContext - Error context for logging
   * @throws ProjectManagementError if permissions are insufficient
   */
  private validatePermissionRequirements(
    permissions: {
      canRead: boolean
      canWrite: boolean
      canAdmin: boolean
      canDelete: boolean
      canManageApiKeys: boolean
      canManageJwtKeys: boolean
    },
    requirements: PermissionRequirements,
    errorContext: any
  ): void {
    const missingPermissions: string[] = []

    if (requirements.read && !permissions.canRead) {
      missingPermissions.push('read')
    }
    if (requirements.write && !permissions.canWrite) {
      missingPermissions.push('write')
    }
    if (requirements.admin && !permissions.canAdmin) {
      missingPermissions.push('admin')
    }
    if (requirements.delete && !permissions.canDelete) {
      missingPermissions.push('delete')
    }
    if (requirements.manageApiKeys && !permissions.canManageApiKeys) {
      missingPermissions.push('manageApiKeys')
    }
    if (requirements.manageJwtKeys && !permissions.canManageJwtKeys) {
      missingPermissions.push('manageJwtKeys')
    }

    if (missingPermissions.length > 0) {
      throw ErrorFactory.auth.insufficientPermissions(
        `permissions: ${missingPermissions.join(', ')}`,
        errorContext
      )
    }
  }

  /**
   * Add project filtering conditions to SQL query
   * 
   * @param query - Base SQL query
   * @param projectId - Project ID to filter by
   * @returns Query with project filtering applied
   */
  addProjectFilter(query: string, projectId: number): IsolatedQuery {
    // Normalize query by removing extra whitespace
    const normalizedQuery = query.trim().replace(/\s+/g, ' ')
    
    // Check if query already has WHERE clause
    const hasWhere = /\bWHERE\b/i.test(normalizedQuery)
    
    // Count existing parameters to determine parameter number
    const paramCount = (normalizedQuery.match(/\$\d+/g) || []).length
    const paramNumber = paramCount + 1
    
    // Add project filter condition
    const projectFilter = hasWhere 
      ? ` AND project_id = $${paramNumber}`
      : ` WHERE project_id = $${paramNumber}`
    
    return {
      baseQuery: normalizedQuery,
      projectFilter: projectFilter,
      params: [projectId]
    }
  }

  /**
   * Validate that data belongs to the specified project
   * 
   * Enhanced validation with cross-project data leakage detection
   * and comprehensive project attribution verification.
   * 
   * @param data - Data object or array to validate
   * @param projectId - Expected project ID
   * @returns Validation result
   * @throws ProjectManagementError if validation fails
   */
  validateDataOwnership(data: any, projectId: number): DataOwnershipResult {
    try {
      if (!data) {
        return { isValid: true } // Empty data is valid
      }

      // Validate project ID
      if (!projectId || typeof projectId !== 'number' || projectId <= 0) {
        throw ErrorFactory.dataIsolation.invalidProjectId(projectId)
      }

      // Enhanced validation with detailed tracking
      const validationResult = this.performEnhancedDataValidation(data, projectId)
      
      if (!validationResult.isValid) {
        // Log security violation for audit
        console.warn('[Data Ownership Validation] Cross-project data leakage detected', {
          projectId,
          invalidItemsCount: validationResult.invalidItems?.length || 0,
          reason: validationResult.reason,
          timestamp: new Date().toISOString()
        })

        throw ErrorFactory.dataIsolation.ownershipViolation(
          validationResult.reason || 'Data ownership validation failed',
          createErrorContext('validateDataOwnership', { projectId })
        )
      }

      return validationResult
    } catch (error) {
      if (error instanceof ProjectManagementError) {
        throw error
      }
      
      throw ErrorFactory.dataIsolation.isolationFailed(
        'validateDataOwnership',
        error as Error,
        createErrorContext('validateDataOwnership', { projectId })
      )
    }
  }

  /**
   * Perform enhanced data validation with cross-project leakage detection
   * 
   * @param data - Data to validate (single object or array)
   * @param projectId - Expected project ID
   * @returns Enhanced validation result with detailed information
   */
  private performEnhancedDataValidation(data: any, projectId: number): DataOwnershipResult & { invalidItems?: any[] } {
    const invalidItems: any[] = []
    let totalItems = 0

    // Handle array of data objects
    if (Array.isArray(data)) {
      totalItems = data.length
      
      for (const item of data) {
        const result = this.validateSingleDataItemEnhanced(item, projectId)
        if (!result.isValid) {
          invalidItems.push(item)
        }
      }
    } else {
      // Handle single data object
      totalItems = 1
      const result = this.validateSingleDataItemEnhanced(data, projectId)
      if (!result.isValid) {
        invalidItems.push(data)
      }
    }

    if (invalidItems.length > 0) {
      return {
        isValid: false,
        invalidItems,
        reason: `${invalidItems.length} of ${totalItems} items do not belong to project ${projectId}`,
        details: {
          totalItems,
          invalidCount: invalidItems.length,
          validCount: totalItems - invalidItems.length
        }
      }
    }

    return { 
      isValid: true,
      details: {
        totalItems,
        invalidCount: 0,
        validCount: totalItems
      }
    }
  }

  /**
   * Enhanced validation for a single data item with comprehensive project attribution checks
   * 
   * @param item - Data item to validate
   * @param projectId - Expected project ID
   * @returns Validation result with detailed information
   */
  private validateSingleDataItemEnhanced(item: any, projectId: number): DataOwnershipResult {
    if (!item || typeof item !== 'object') {
      return { isValid: true } // Non-object data is considered valid
    }

    // Check multiple possible project identifier fields
    const projectIdentifierFields = [
      'project_id',
      'projectId', 
      'project_ref',
      'projectRef',
      'ref'
    ]

    let foundProjectIdentifier = false
    let projectMismatch = false
    let mismatchDetails: string[] = []

    for (const field of projectIdentifierFields) {
      if (field in item && item[field] !== null && item[field] !== undefined) {
        foundProjectIdentifier = true

        // Handle numeric project ID fields
        if (field === 'project_id' || field === 'projectId') {
          const itemProjectId = typeof item[field] === 'string' ? parseInt(item[field], 10) : item[field]
          
          if (itemProjectId !== projectId) {
            projectMismatch = true
            mismatchDetails.push(`${field}: expected ${projectId}, got ${itemProjectId}`)
          }
        }
        
        // Handle project reference fields (would need resolution to project ID)
        // For now, we'll perform a basic validation
        else if (field === 'project_ref' || field === 'projectRef' || field === 'ref') {
          // In a full implementation, we would resolve the project ref to project ID
          // For now, we'll assume it's valid if it's a non-empty string
          if (typeof item[field] !== 'string' || item[field].trim() === '') {
            projectMismatch = true
            mismatchDetails.push(`${field}: invalid or empty project reference`)
          }
        }
      }
    }

    // If no project identifier found, check if this is a nested object with project data
    if (!foundProjectIdentifier) {
      const nestedValidation = this.validateNestedProjectData(item, projectId)
      if (!nestedValidation.isValid) {
        return nestedValidation
      }
    }

    if (projectMismatch) {
      return {
        isValid: false,
        reason: `Project ownership mismatch: ${mismatchDetails.join(', ')}`
      }
    }

    return { isValid: true }
  }

  /**
   * Validate nested project data in complex objects
   * 
   * @param item - Data item that might contain nested project information
   * @param projectId - Expected project ID
   * @returns Validation result
   */
  private validateNestedProjectData(item: any, projectId: number): DataOwnershipResult {
    // Check for common nested structures that might contain project information
    const nestedFields = ['project', 'metadata', 'config', 'settings']
    
    for (const field of nestedFields) {
      if (field in item && typeof item[field] === 'object' && item[field] !== null) {
        const nestedResult = this.validateSingleDataItemEnhanced(item[field], projectId)
        if (!nestedResult.isValid) {
          return {
            isValid: false,
            reason: `Nested project data validation failed in ${field}: ${nestedResult.reason}`
          }
        }
      }
    }

    // Check for arrays of nested objects
    for (const [key, value] of Object.entries(item)) {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (typeof value[i] === 'object' && value[i] !== null) {
            const nestedResult = this.validateSingleDataItemEnhanced(value[i], projectId)
            if (!nestedResult.isValid) {
              return {
                isValid: false,
                reason: `Nested array item validation failed in ${key}[${i}]: ${nestedResult.reason}`
              }
            }
          }
        }
      }
    }

    return { isValid: true }
  }

  /**
   * Detect and prevent cross-project data leakage
   * 
   * This method performs additional checks to ensure that data from different
   * projects is not accidentally mixed in the response.
   * 
   * @param data - Data to check for cross-project leakage
   * @param expectedProjectId - The project ID that all data should belong to
   * @returns Detection result with details about any leakage found
   */
  detectCrossProjectDataLeakage(data: any, expectedProjectId: number): {
    hasLeakage: boolean
    leakedProjects: number[]
    leakedItems: any[]
    summary: string
  } {
    const leakedProjects = new Set<number>()
    const leakedItems: any[] = []

    const checkItem = (item: any) => {
      if (!item || typeof item !== 'object') return

      // Check for project_id field
      if ('project_id' in item && typeof item.project_id === 'number') {
        if (item.project_id !== expectedProjectId) {
          leakedProjects.add(item.project_id)
          leakedItems.push(item)
        }
      }

      // Recursively check nested objects
      for (const value of Object.values(item)) {
        if (Array.isArray(value)) {
          value.forEach(checkItem)
        } else if (typeof value === 'object' && value !== null) {
          checkItem(value)
        }
      }
    }

    if (Array.isArray(data)) {
      data.forEach(checkItem)
    } else {
      checkItem(data)
    }

    const hasLeakage = leakedProjects.size > 0
    const leakedProjectsArray = Array.from(leakedProjects)

    return {
      hasLeakage,
      leakedProjects: leakedProjectsArray,
      leakedItems,
      summary: hasLeakage 
        ? `Found data from ${leakedProjectsArray.length} unauthorized projects: ${leakedProjectsArray.join(', ')}`
        : 'No cross-project data leakage detected'
    }
  }

  /**
   * Validate that returned data belongs to the requesting project
   * 
   * This is an additional security layer that can be called after data retrieval
   * to ensure no cross-project data leakage occurred.
   * 
   * @param data - Data returned from database query
   * @param projectId - Project ID that made the request
   * @param userId - User ID for audit logging
   * @returns Validation result
   */
  validateReturnedDataOwnership(data: any, projectId: number, userId?: string): DataOwnershipResult {
    try {
      // Perform standard ownership validation
      const ownershipResult = this.validateDataOwnership(data, projectId)
      
      if (!ownershipResult.isValid) {
        return ownershipResult
      }

      // Perform cross-project leakage detection
      const leakageResult = this.detectCrossProjectDataLeakage(data, projectId)
      
      if (leakageResult.hasLeakage) {
        // Log security incident
        console.error('[Data Ownership Validation] Cross-project data leakage detected', {
          userId,
          projectId,
          leakedProjects: leakageResult.leakedProjects,
          leakedItemsCount: leakageResult.leakedItems.length,
          summary: leakageResult.summary,
          timestamp: new Date().toISOString()
        })

        return {
          isValid: false,
          reason: `Cross-project data leakage detected: ${leakageResult.summary}`,
          details: {
            leakedProjects: leakageResult.leakedProjects,
            leakedItemsCount: leakageResult.leakedItems.length
          }
        }
      }

      return { isValid: true }

    } catch (error) {
      console.error('[Data Ownership Validation] Error during returned data validation:', error)
      return {
        isValid: false,
        reason: 'Data ownership validation failed due to internal error'
      }
    }
  }

  /**
   * Extract project reference from request URL or query parameters
   * 
   * @param req - Next.js API request object
   * @returns Project reference string or null if not found
   */
  private extractProjectRef(req: NextApiRequest): string | null {
    // Try to extract from URL path (e.g., /api/projects/[ref]/monitoring)
    const urlParts = req.url?.split('/') || []
    
    // Handle REST API path: /api/v1/projects/rest/[ref]/...
    const restIndex = urlParts.findIndex(part => part === 'rest')
    if (restIndex !== -1 && restIndex + 1 < urlParts.length) {
      const ref = urlParts[restIndex + 1]
      // Remove query parameters if present
      return ref.split('?')[0]
    }
    
    // Handle regular project paths: /api/projects/[ref]/...
    const projectIndex = urlParts.findIndex(part => part === 'projects')
    if (projectIndex !== -1 && projectIndex + 1 < urlParts.length) {
      const ref = urlParts[projectIndex + 1]
      // Skip if the next part is 'rest' (REST API path)
      if (ref === 'rest' && projectIndex + 2 < urlParts.length) {
        // For REST API paths, take the part after 'rest'
        const actualRef = urlParts[projectIndex + 2]
        return actualRef.split('?')[0]
      }
      // Remove query parameters if present
      return ref.split('?')[0]
    }

    // Try to extract from query parameters
    if (req.query.ref && typeof req.query.ref === 'string') {
      return req.query.ref
    }

    // Try alternative query parameter names
    if (req.query.projectRef && typeof req.query.projectRef === 'string') {
      return req.query.projectRef
    }

    if (req.query.project_ref && typeof req.query.project_ref === 'string') {
      return req.query.project_ref
    }

    return null
  }

  /**
   * Get project ID from project reference
   * 
   * @param projectRef - Project reference string
   * @returns Project ID or null if not found
   * @throws ProjectManagementError if project lookup fails
   */
  private async getProjectIdFromRef(projectRef: string): Promise<number | null> {
    const errorContext = createErrorContext('getProjectIdFromRef', { projectRef })

    // No-auth mode: return dummy project ID
    const noAuthMode = process.env.STUDIO_NO_AUTH_MODE === 'true'
    if (noAuthMode) {
      console.log('[getProjectIdFromRef] No-auth mode: returning dummy project ID')
      return 1 // Return a dummy project ID
    }

    return withErrorHandling(
      async () => {
        // Validate project ref format
        if (!projectRef || typeof projectRef !== 'string' || projectRef.trim().length === 0) {
          throw ErrorFactory.routing.invalidProjectRef(projectRef, errorContext)
        }

        // Query the studio_projects table to get the project ID
        const { findByRef } = await import('./self-hosted/project-store-pg')
        const result = await findByRef(projectRef)
        
        if (result.error) {
          console.error('[ProjectIsolationMiddleware] Error querying project:', result.error)
          throw ErrorFactory.projectDeletion.projectNotFound(projectRef, errorContext)
        }
        
        if (!result.data) {
          throw ErrorFactory.projectDeletion.projectNotFound(projectRef, errorContext)
        }
        
        return result.data.id
      },
      errorContext,
      (cause) => ErrorFactory.dataIsolation.isolationFailed('getProjectIdFromRef', cause, errorContext)
    )
  }


}

/**
 * Singleton instance of the middleware
 */
let middlewareInstance: ProjectIsolationMiddleware | null = null

/**
 * Get the singleton ProjectIsolationMiddleware instance
 * 
 * @returns ProjectIsolationMiddleware instance
 */
export function getProjectIsolationMiddleware(): ProjectIsolationMiddleware {
  if (!middlewareInstance) {
    middlewareInstance = new ProjectIsolationMiddleware()
  }
  return middlewareInstance
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetProjectIsolationMiddleware(): void {
  middlewareInstance = null
}

/**
 * Higher-order function to wrap API handlers with project isolation
 * 
 * @param handler - API handler function that receives project context
 * @param permissionRequirements - Optional permission requirements to validate
 * @returns Wrapped API handler with project isolation
 */
export function withProjectIsolation<T = any>(
  handler: (
    req: NextApiRequest,
    res: NextApiResponse,
    context: ProjectIsolationContext
  ) => Promise<T>,
  permissionRequirements?: PermissionRequirements
) {
  return async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
    const errorContext = createErrorContext('withProjectIsolation', {
      endpoint: req.url,
      userAgent: req.headers['user-agent'],
      ip: req.headers['x-forwarded-for'] as string || req.connection.remoteAddress
    })

    try {
      const middleware = getProjectIsolationMiddleware()
      const context = await middleware.extractProjectContext(req, permissionRequirements)
      
      // Add project context to error context
      errorContext.projectId = context.projectId
      errorContext.projectRef = context.projectRef
      errorContext.userId = context.userId
      
      const result = await handler(req, res, context)
      
      // If handler returns data, validate it belongs to the project
      if (result && typeof result === 'object') {
        try {
          middleware.validateDataOwnership(result, context.projectId)
        } catch (validationError) {
          if (validationError instanceof ProjectManagementError) {
            return handleApiError(validationError, res, errorContext)
          }
          
          const error = ErrorFactory.dataIsolation.ownershipViolation(
            'Data validation failed',
            errorContext
          )
          return handleApiError(error, res, errorContext)
        }
      }
      
      // If result is not already sent by handler, send it
      if (result !== undefined && !res.headersSent) {
        res.status(200).json(result)
      }
    } catch (error) {
      if (error instanceof ProjectManagementError) {
        return handleApiError(error, res, errorContext)
      }
      
      // Handle unexpected errors
      const managementError = ErrorFactory.generic.internalServerError(
        'Project isolation middleware',
        error as Error,
        errorContext
      )
      
      return handleApiError(managementError, res, errorContext)
    }
  }
}

/**
 * Convenience function for read-only endpoints
 */
export function withReadAccess<T = any>(
  handler: (
    req: NextApiRequest,
    res: NextApiResponse,
    context: ProjectIsolationContext
  ) => Promise<T>
) {
  return withProjectIsolation(handler, { read: true })
}

/**
 * Convenience function for write endpoints
 */
export function withWriteAccess<T = any>(
  handler: (
    req: NextApiRequest,
    res: NextApiResponse,
    context: ProjectIsolationContext
  ) => Promise<T>
) {
  return withProjectIsolation(handler, { read: true, write: true })
}

/**
 * Convenience function for admin endpoints
 */
export function withAdminAccess<T = any>(
  handler: (
    req: NextApiRequest,
    res: NextApiResponse,
    context: ProjectIsolationContext
  ) => Promise<T>
) {
  return withProjectIsolation(handler, { read: true, write: true, admin: true })
}

/**
 * Convenience function for API key management endpoints
 */
export function withApiKeyManagement<T = any>(
  handler: (
    req: NextApiRequest,
    res: NextApiResponse,
    context: ProjectIsolationContext
  ) => Promise<T>
) {
  return withProjectIsolation(handler, { read: true, manageApiKeys: true })
}

/**
 * Convenience function for JWT key management endpoints
 */
export function withJwtKeyManagement<T = any>(
  handler: (
    req: NextApiRequest,
    res: NextApiResponse,
    context: ProjectIsolationContext
  ) => Promise<T>
) {
  return withProjectIsolation(handler, { read: true, manageJwtKeys: true })
}