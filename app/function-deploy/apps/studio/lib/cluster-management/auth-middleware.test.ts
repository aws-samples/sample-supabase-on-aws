/**
 * Unit tests for authentication middleware
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextApiResponse } from 'next'
import { authenticateClusterRequest, type AuthenticatedRequest } from './auth-middleware'
import * as gotrue from 'lib/gotrue'

// Mock the getUserClaims function
vi.mock('lib/gotrue', () => ({
  getUserClaims: vi.fn(),
}))

describe('authenticateClusterRequest', () => {
  let mockReq: Partial<AuthenticatedRequest>
  let mockRes: Partial<NextApiResponse>
  let statusMock: ReturnType<typeof vi.fn>
  let jsonMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks()

    // Setup mock response
    jsonMock = vi.fn()
    statusMock = vi.fn(() => ({ json: jsonMock }))
    mockRes = {
      status: statusMock as any,
    }

    // Setup mock request
    mockReq = {
      headers: {},
    }
  })

  it('should return null and send 401 when Authorization header is missing', async () => {
    const result = await authenticateClusterRequest(
      mockReq as AuthenticatedRequest,
      mockRes as NextApiResponse
    )

    expect(result).toBeNull()
    expect(statusMock).toHaveBeenCalledWith(401)
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Missing authentication token',
      },
    })
  })

  it('should return null and send 401 when token is empty after Bearer prefix', async () => {
    mockReq.headers = { authorization: 'Bearer ' }

    const result = await authenticateClusterRequest(
      mockReq as AuthenticatedRequest,
      mockRes as NextApiResponse
    )

    expect(result).toBeNull()
    expect(statusMock).toHaveBeenCalledWith(401)
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Invalid authentication token format',
      },
    })
  })

  it('should return null and send 401 when getUserClaims returns error', async () => {
    mockReq.headers = { authorization: 'Bearer invalid-token' }
    vi.mocked(gotrue.getUserClaims).mockResolvedValue({
      claims: null,
      error: new Error('Invalid token'),
    })

    const result = await authenticateClusterRequest(
      mockReq as AuthenticatedRequest,
      mockRes as NextApiResponse
    )

    expect(result).toBeNull()
    expect(statusMock).toHaveBeenCalledWith(401)
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'AUTHENTICATION_FAILED',
        message: 'Invalid or expired authentication token',
      },
    })
  })

  it('should return null and send 401 when getUserClaims returns null claims', async () => {
    mockReq.headers = { authorization: 'Bearer invalid-token' }
    vi.mocked(gotrue.getUserClaims).mockResolvedValue({
      claims: null,
      error: null,
    })

    const result = await authenticateClusterRequest(
      mockReq as AuthenticatedRequest,
      mockRes as NextApiResponse
    )

    expect(result).toBeNull()
    expect(statusMock).toHaveBeenCalledWith(401)
  })

  it('should return claims and attach user to request when authentication succeeds', async () => {
    const mockClaims = {
      sub: 'user-123',
      email: 'admin@example.com',
      role: 'authenticated',
    }

    mockReq.headers = { authorization: 'Bearer valid-token' }
    vi.mocked(gotrue.getUserClaims).mockResolvedValue({
      claims: mockClaims,
      error: null,
    })

    const result = await authenticateClusterRequest(
      mockReq as AuthenticatedRequest,
      mockRes as NextApiResponse
    )

    expect(result).toEqual(mockClaims)
    expect(mockReq.user).toEqual(mockClaims)
    expect(statusMock).not.toHaveBeenCalled()
  })

  it('should handle Bearer prefix case-insensitively', async () => {
    const mockClaims = {
      sub: 'user-123',
      email: 'admin@example.com',
    }

    // Test with lowercase 'bearer'
    mockReq.headers = { authorization: 'bearer valid-token' }
    vi.mocked(gotrue.getUserClaims).mockResolvedValue({
      claims: mockClaims,
      error: null,
    })

    const result = await authenticateClusterRequest(
      mockReq as AuthenticatedRequest,
      mockRes as NextApiResponse
    )

    expect(result).toEqual(mockClaims)
    expect(vi.mocked(gotrue.getUserClaims)).toHaveBeenCalledWith('valid-token')
  })

  it('should handle token without Bearer prefix', async () => {
    const mockClaims = {
      sub: 'user-123',
      email: 'admin@example.com',
    }

    mockReq.headers = { authorization: 'raw-token' }
    vi.mocked(gotrue.getUserClaims).mockResolvedValue({
      claims: mockClaims,
      error: null,
    })

    const result = await authenticateClusterRequest(
      mockReq as AuthenticatedRequest,
      mockRes as NextApiResponse
    )

    expect(result).toEqual(mockClaims)
    expect(vi.mocked(gotrue.getUserClaims)).toHaveBeenCalledWith('raw-token')
  })

  it('should return null and send 401 when getUserClaims throws exception', async () => {
    mockReq.headers = { authorization: 'Bearer error-token' }
    vi.mocked(gotrue.getUserClaims).mockRejectedValue(new Error('Network error'))

    const result = await authenticateClusterRequest(
      mockReq as AuthenticatedRequest,
      mockRes as NextApiResponse
    )

    expect(result).toBeNull()
    expect(statusMock).toHaveBeenCalledWith(401)
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'AUTHENTICATION_ERROR',
        message: 'Authentication failed',
      },
    })
  })
})
