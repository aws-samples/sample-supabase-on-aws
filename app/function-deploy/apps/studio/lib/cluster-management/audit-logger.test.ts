/**
 * Unit tests for audit logger
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest } from 'next'
import {
  ClusterAuditLogger,
  logClusterRegistration,
  logClusterOnline,
  logClusterOffline,
  logClusterDeletion,
  logCapacityUpdate,
  logStrategyUpdate,
} from './audit-logger'

describe('ClusterAuditLogger', () => {
  let mockUser: JwtPayload
  let mockReq: Partial<NextApiRequest>
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockUser = {
      sub: 'user-123',
      email: 'admin@example.com',
    }

    mockReq = {
      headers: {
        'user-agent': 'Mozilla/5.0',
        'x-real-ip': '192.168.1.1',
      },
    }

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
  })

  describe('logAction', () => {
    it('should log action with all required fields', async () => {
      await ClusterAuditLogger.logAction({
        user: mockUser,
        action: 'cluster.register',
        resourceType: 'cluster',
        resourceId: 'cluster-1',
        organizationSlug: 'test-org',
        status: 'success',
      })

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"user_id":"user-123"')
      )
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"action":"cluster.register"')
      )
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"status":"success"')
      )
    })

    it('should include IP address from x-real-ip header', async () => {
      await ClusterAuditLogger.logAction({
        user: mockUser,
        action: 'cluster.register',
        resourceType: 'cluster',
        req: mockReq as NextApiRequest,
        status: 'success',
      })

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"ip_address":"192.168.1.1"')
      )
    })

    it('should include user agent', async () => {
      await ClusterAuditLogger.logAction({
        user: mockUser,
        action: 'cluster.register',
        resourceType: 'cluster',
        req: mockReq as NextApiRequest,
        status: 'success',
      })

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"user_agent":"Mozilla/5.0"')
      )
    })

    it('should sanitize sensitive metadata fields', async () => {
      await ClusterAuditLogger.logAction({
        user: mockUser,
        action: 'cluster.register',
        resourceType: 'cluster',
        metadata: {
          password: 'secret-password',
          credential: 'secret-credential',
          admin_credential: 'admin-secret',
          safe_field: 'visible-value',
        },
        status: 'success',
      })

      const logCall = consoleLogSpy.mock.calls[0][1]
      expect(logCall).toContain('***REDACTED***')
      expect(logCall).not.toContain('secret-password')
      expect(logCall).not.toContain('secret-credential')
      expect(logCall).not.toContain('admin-secret')
      expect(logCall).toContain('visible-value')
    })

    it('should include error message for failed actions', async () => {
      await ClusterAuditLogger.logAction({
        user: mockUser,
        action: 'cluster.delete',
        resourceType: 'cluster',
        status: 'failure',
        errorMessage: 'Cluster has active databases',
      })

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"status":"failure"')
      )
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"error_message":"Cluster has active databases"')
      )
    })

    it('should extract IP from x-forwarded-for header', async () => {
      mockReq.headers = {
        'x-forwarded-for': '10.0.0.1, 10.0.0.2',
      }

      await ClusterAuditLogger.logAction({
        user: mockUser,
        action: 'cluster.register',
        resourceType: 'cluster',
        req: mockReq as NextApiRequest,
        status: 'success',
      })

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"ip_address":"10.0.0.1"')
      )
    })

    it('should handle missing user email', async () => {
      const userWithoutEmail = { sub: 'user-456' }

      await ClusterAuditLogger.logAction({
        user: userWithoutEmail,
        action: 'cluster.register',
        resourceType: 'cluster',
        status: 'success',
      })

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"user_id":"user-456"')
      )
    })
  })

  describe('logSuccess', () => {
    it('should log successful action', async () => {
      await ClusterAuditLogger.logSuccess({
        user: mockUser,
        action: 'cluster.online',
        resourceType: 'cluster',
        resourceId: 'cluster-1',
      })

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"status":"success"')
      )
    })
  })

  describe('logFailure', () => {
    it('should log failed action with error message', async () => {
      await ClusterAuditLogger.logFailure({
        user: mockUser,
        action: 'cluster.delete',
        resourceType: 'cluster',
        resourceId: 'cluster-1',
        errorMessage: 'Cannot delete cluster with active databases',
      })

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"status":"failure"')
      )
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"error_message":"Cannot delete cluster with active databases"')
      )
    })
  })

  describe('convenience functions', () => {
    it('logClusterRegistration should log cluster registration', async () => {
      await logClusterRegistration(mockUser, 'cluster-1', 'test-org')

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"action":"cluster.register"')
      )
    })

    it('logClusterOnline should log cluster online action', async () => {
      await logClusterOnline(mockUser, 'cluster-1', 'test-org')

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"action":"cluster.online"')
      )
    })

    it('logClusterOffline should log cluster offline action', async () => {
      await logClusterOffline(mockUser, 'cluster-1', 'test-org')

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"action":"cluster.offline"')
      )
    })

    it('logClusterDeletion should log cluster deletion', async () => {
      await logClusterDeletion(mockUser, 'cluster-1', 'test-org')

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[CLUSTER_AUDIT]',
        expect.stringContaining('"action":"cluster.delete"')
      )
    })

    it('logCapacityUpdate should log capacity update with metadata', async () => {
      await logCapacityUpdate(mockUser, 'cluster-1', 100, 200, 'test-org')

      const logCall = consoleLogSpy.mock.calls[0][1]
      expect(logCall).toContain('"action":"cluster.capacity_update"')
      expect(logCall).toContain('"old_capacity":100')
      expect(logCall).toContain('"new_capacity":200')
    })

    it('logStrategyUpdate should log strategy update with metadata', async () => {
      await logStrategyUpdate(mockUser, 'production-strategy', 'weighted_round_robin', 'test-org')

      const logCall = consoleLogSpy.mock.calls[0][1]
      expect(logCall).toContain('"action":"strategy.update"')
      expect(logCall).toContain('"resource_type":"allocation_strategy"')
      expect(logCall).toContain('"strategy_type":"weighted_round_robin"')
    })
  })

  describe('metadata sanitization', () => {
    it('should sanitize all sensitive field names', async () => {
      const sensitiveMetadata = {
        password: 'pass123',
        credential: 'cred456',
        admin_credential: 'admin789',
        secret: 'secret012',
        token: 'token345',
        api_key: 'key678',
        safe_data: 'visible',
      }

      await ClusterAuditLogger.logAction({
        user: mockUser,
        action: 'test.action',
        resourceType: 'cluster',
        metadata: sensitiveMetadata,
        status: 'success',
      })

      const logCall = consoleLogSpy.mock.calls[0][1]
      
      // All sensitive fields should be redacted
      expect(logCall).not.toContain('pass123')
      expect(logCall).not.toContain('cred456')
      expect(logCall).not.toContain('admin789')
      expect(logCall).not.toContain('secret012')
      expect(logCall).not.toContain('token345')
      expect(logCall).not.toContain('key678')
      
      // Safe data should be visible
      expect(logCall).toContain('visible')
      
      // Redaction marker should be present
      expect(logCall).toContain('***REDACTED***')
    })
  })
})
