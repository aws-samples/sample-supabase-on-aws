/**
 * Unit tests for authorization middleware
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiResponse } from 'next'
import type { Permission } from 'types'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import { authorizeClusterAdmin, isOrganizationAdmin } from './authorization-middleware'
import * as useCheckPermissions from 'hooks/misc/useCheckPermissions'

// Mock the doPermissionsCheck function
vi.mock('hooks/misc/useCheckPermissions', () => ({
  doPermissionsCheck: vi.fn(),
}))

describe('authorizeClusterAdmin', () => {
  let mockUser: JwtPayload
  let mockRes: Partial<NextApiResponse>
  let statusMock: ReturnType<typeof vi.fn>
  let jsonMock: ReturnType<typeof vi.fn>
  let mockPermissions: Permission[]

  beforeEach(() => {
    vi.clearAllMocks()

    mockUser = {
      sub: 'user-123',
      email: 'admin@example.com',
    }

    jsonMock = vi.fn()
    statusMock = vi.fn(() => ({ json: jsonMock }))
    mockRes = {
      status: statusMock as any,
    }

    mockPermissions = [
      {
        actions: [PermissionAction.TENANT_SQL_ADMIN_WRITE],
        condition: null,
        organization_slug: 'test-org',
        resources: ['database.clusters'],
        project_refs: [],
      },
    ]
  })

  it('should return true when user has admin permissions', async () => {
    vi.mocked(useCheckPermissions.doPermissionsCheck).mockReturnValue(true)

    const result = await authorizeClusterAdmin(
      mockUser,
      'test-org',
      mockPermissions,
      mockRes as NextApiResponse
    )

    expect(result).toBe(true)
    expect(statusMock).not.toHaveBeenCalled()
    expect(vi.mocked(useCheckPermissions.doPermissionsCheck)).toHaveBeenCalledWith(
      mockPermissions,
      PermissionAction.TENANT_SQL_ADMIN_WRITE,
      'database.clusters',
      undefined,
      'test-org',
      undefined
    )
  })

  it('should return false and send 403 when user lacks admin permissions', async () => {
    vi.mocked(useCheckPermissions.doPermissionsCheck).mockReturnValue(false)

    const result = await authorizeClusterAdmin(
      mockUser,
      'test-org',
      mockPermissions,
      mockRes as NextApiResponse
    )

    expect(result).toBe(false)
    expect(statusMock).toHaveBeenCalledWith(403)
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'AUTHORIZATION_FAILED',
        message: 'Insufficient permissions. Administrator role required for cluster management.',
      },
    })
  })

  it('should return false and send 403 when permissions are undefined', async () => {
    vi.mocked(useCheckPermissions.doPermissionsCheck).mockReturnValue(false)

    const result = await authorizeClusterAdmin(
      mockUser,
      'test-org',
      undefined,
      mockRes as NextApiResponse
    )

    expect(result).toBe(false)
    expect(statusMock).toHaveBeenCalledWith(403)
  })

  it('should return false and send 403 when organization slug is undefined', async () => {
    vi.mocked(useCheckPermissions.doPermissionsCheck).mockReturnValue(false)

    const result = await authorizeClusterAdmin(
      mockUser,
      undefined,
      mockPermissions,
      mockRes as NextApiResponse
    )

    expect(result).toBe(false)
    expect(statusMock).toHaveBeenCalledWith(403)
  })

  it('should return false and send 403 when doPermissionsCheck throws error', async () => {
    vi.mocked(useCheckPermissions.doPermissionsCheck).mockImplementation(() => {
      throw new Error('Permission check failed')
    })

    const result = await authorizeClusterAdmin(
      mockUser,
      'test-org',
      mockPermissions,
      mockRes as NextApiResponse
    )

    expect(result).toBe(false)
    expect(statusMock).toHaveBeenCalledWith(403)
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'AUTHORIZATION_ERROR',
        message: 'Authorization check failed',
      },
    })
  })
})

describe('isOrganizationAdmin', () => {
  let mockPermissions: Permission[]

  beforeEach(() => {
    vi.clearAllMocks()

    mockPermissions = [
      {
        actions: [PermissionAction.TENANT_SQL_ADMIN_WRITE],
        condition: null,
        organization_slug: 'test-org',
        resources: ['*'],
        project_refs: [],
      },
    ]
  })

  it('should return true when user has TENANT_SQL_ADMIN_WRITE permission', () => {
    vi.mocked(useCheckPermissions.doPermissionsCheck).mockReturnValue(true)

    const result = isOrganizationAdmin(mockPermissions, 'test-org')

    expect(result).toBe(true)
  })

  it('should return true when user has INFRA_EXECUTE permission', () => {
    vi.mocked(useCheckPermissions.doPermissionsCheck)
      .mockReturnValueOnce(false) // First call for TENANT_SQL_ADMIN_WRITE
      .mockReturnValueOnce(true) // Second call for INFRA_EXECUTE

    const result = isOrganizationAdmin(mockPermissions, 'test-org')

    expect(result).toBe(true)
  })

  it('should return false when user has no admin permissions', () => {
    vi.mocked(useCheckPermissions.doPermissionsCheck).mockReturnValue(false)

    const result = isOrganizationAdmin(mockPermissions, 'test-org')

    expect(result).toBe(false)
  })

  it('should return false when permissions are undefined', () => {
    const result = isOrganizationAdmin(undefined, 'test-org')

    expect(result).toBe(false)
  })

  it('should return false when organization slug is undefined', () => {
    const result = isOrganizationAdmin(mockPermissions, undefined)

    expect(result).toBe(false)
  })
})
