import type { JwtPayload } from '@supabase/supabase-js'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { NextApiResponse } from 'next'
import type { Permission } from 'types'
import { doPermissionsCheck } from 'hooks/misc/useCheckPermissions'

/**
 * Authorization middleware for cluster management API endpoints.
 * Verifies that the user has administrator privileges.
 * 
 * Requirements: 13.2, 13.4
 * 
 * @param user - Authenticated user claims
 * @param organizationSlug - Organization slug for permission check
 * @param permissions - User's permissions
 * @param res - Next.js API response
 * @returns true if authorized, false otherwise (sends 403 response)
 */
export async function authorizeClusterAdmin(
  user: JwtPayload,
  organizationSlug: string | undefined,
  permissions: Permission[] | undefined,
  res: NextApiResponse
): Promise<boolean> {
  try {
    // Check if user has admin permissions for cluster management
    // We check for TENANT_SQL_ADMIN_WRITE which is typically granted to org owners/admins
    const hasAdminPermission = doPermissionsCheck(
      permissions,
      PermissionAction.TENANT_SQL_ADMIN_WRITE,
      'database.clusters',
      undefined,
      organizationSlug,
      undefined
    )

    if (!hasAdminPermission) {
      res.status(403).json({
        error: {
          code: 'AUTHORIZATION_FAILED',
          message: 'Insufficient permissions. Administrator role required for cluster management.',
        },
      })
      return false
    }

    return true
  } catch (error) {
    console.error('Authorization error:', error)
    res.status(403).json({
      error: {
        code: 'AUTHORIZATION_ERROR',
        message: 'Authorization check failed',
      },
    })
    return false
  }
}

/**
 * Helper function to check if user is an organization owner or administrator.
 * This is a simplified check based on common permission patterns.
 * 
 * @param permissions - User's permissions
 * @param organizationSlug - Organization slug
 * @returns true if user has admin-level permissions
 */
export function isOrganizationAdmin(
  permissions: Permission[] | undefined,
  organizationSlug: string | undefined
): boolean {
  if (!permissions || !organizationSlug) {
    return false
  }

  // Check for various admin-level permissions
  const adminActions = [
    PermissionAction.TENANT_SQL_ADMIN_WRITE,
    PermissionAction.INFRA_EXECUTE,
  ]

  return adminActions.some((action) =>
    doPermissionsCheck(
      permissions,
      action,
      '*',
      undefined,
      organizationSlug,
      undefined
    )
  )
}
