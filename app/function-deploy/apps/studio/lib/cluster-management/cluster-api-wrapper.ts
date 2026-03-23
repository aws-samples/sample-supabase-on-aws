import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'
import { getPermissions } from 'data/permissions/permissions-query'
import { authenticateClusterRequest, type AuthenticatedRequest } from './auth-middleware'
import { authorizeClusterAdmin } from './authorization-middleware'
import { ClusterAuditLogger } from './audit-logger'

export interface ClusterApiContext {
  user: JwtPayload
  organizationSlug?: string
}

/**
 * Wrapper for cluster management API endpoints that handles:
 * - Authentication (JWT verification)
 * - Authorization (admin permission check)
 * - Audit logging (action tracking)
 * 
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
 * 
 * @param req - Next.js API request
 * @param res - Next.js API response
 * @param handler - API handler function that receives authenticated context
 * @param options - Configuration options
 * @returns Promise that resolves when handler completes
 */
export async function withClusterAuth(
  req: NextApiRequest,
  res: NextApiResponse,
  handler: (req: AuthenticatedRequest, res: NextApiResponse, context: ClusterApiContext) => Promise<void>,
  options?: {
    requireOrganization?: boolean
    action?: string
    resourceType?: 'cluster' | 'allocation_strategy'
  }
): Promise<void> {
  const { requireOrganization = false, action, resourceType } = options || {}

  try {
    // Step 1: Authenticate the request
    const user = await authenticateClusterRequest(req as AuthenticatedRequest, res)
    if (!user) {
      // Authentication middleware already sent 401 response
      return
    }

    // Step 2: Extract organization slug from query or body
    const organizationSlug = 
      (req.query.organizationSlug as string) || 
      (req.body?.organizationSlug as string)

    if (requireOrganization && !organizationSlug) {
      res.status(400).json({
        error: {
          code: 'MISSING_ORGANIZATION',
          message: 'Organization slug is required',
        },
      })
      return
    }

    // Step 3: Check if user is service_role (bypass permission checks)
    if (user.role === 'service_role') {
      // Service role has full admin access, skip permission checks
      const context: ClusterApiContext = {
        user,
        organizationSlug,
      }

      await handler(req as AuthenticatedRequest, res, context)

      // Log successful action (if action specified)
      if (action && resourceType && res.statusCode >= 200 && res.statusCode < 300) {
        await ClusterAuditLogger.logSuccess({
          user,
          action,
          resourceType,
          organizationSlug,
          req,
        })
      }
      return
    }

    // Step 4: Fetch user permissions (for non-service_role users)
    let permissions
    try {
      permissions = await getPermissions()
    } catch (error) {
      console.error('Failed to fetch permissions:', error)
      res.status(500).json({
        error: {
          code: 'PERMISSION_FETCH_FAILED',
          message: 'Failed to fetch user permissions',
        },
      })
      return
    }

    // Step 5: Authorize the request
    const isAuthorized = await authorizeClusterAdmin(
      user,
      organizationSlug,
      permissions,
      res
    )
    if (!isAuthorized) {
      // Authorization middleware already sent 403 response
      // Log failed authorization attempt
      if (action && resourceType) {
        await ClusterAuditLogger.logFailure({
          user,
          action,
          resourceType,
          organizationSlug,
          req,
          errorMessage: 'Authorization failed',
        })
      }
      return
    }

    // Step 6: Execute the handler
    const context: ClusterApiContext = {
      user,
      organizationSlug,
    }

    await handler(req as AuthenticatedRequest, res, context)

    // Step 7: Log successful action (if action specified)
    if (action && resourceType && res.statusCode >= 200 && res.statusCode < 300) {
      await ClusterAuditLogger.logSuccess({
        user,
        action,
        resourceType,
        organizationSlug,
        req,
      })
    }
  } catch (error) {
    console.error('Cluster API error:', error)

    // Log the error
    if (action && resourceType && (req as AuthenticatedRequest).user) {
      await ClusterAuditLogger.logFailure({
        user: (req as AuthenticatedRequest).user!,
        action,
        resourceType,
        organizationSlug: 
          (req.query.organizationSlug as string) || 
          (req.body?.organizationSlug as string),
        req,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      })
    }

    // Send error response if not already sent
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An internal error occurred',
        },
      })
    }
  }
}

/**
 * Simplified wrapper for endpoints that don't require organization context
 */
export async function withClusterAuthSimple(
  req: NextApiRequest,
  res: NextApiResponse,
  handler: (req: AuthenticatedRequest, res: NextApiResponse, context: ClusterApiContext) => Promise<void>
): Promise<void> {
  return withClusterAuth(req, res, handler, { requireOrganization: false })
}
