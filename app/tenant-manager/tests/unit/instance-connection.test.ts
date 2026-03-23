/**
 * Unit tests for instance-connection module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock credential provider
vi.mock('../../src/common/crypto/credential-provider.js', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({
    getCredential: vi.fn().mockResolvedValue('decrypted-password'),
    storeCredential: vi.fn().mockResolvedValue('encrypted'),
    deleteCredential: vi.fn().mockResolvedValue(undefined),
  }),
}))

// Mock pg module
const mockPoolEnd = vi.fn().mockResolvedValue(undefined)
const mockPoolQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
const mockClientConnect = vi.fn().mockResolvedValue(undefined)
const mockClientEnd = vi.fn().mockResolvedValue(undefined)
const mockClientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

vi.mock('pg', () => {
  return {
    default: {
      Pool: vi.fn().mockImplementation(() => ({
        end: mockPoolEnd,
        query: mockPoolQuery,
      })),
      Client: vi.fn().mockImplementation(() => ({
        connect: mockClientConnect,
        end: mockClientEnd,
        query: mockClientQuery,
      })),
    },
  }
})

import type { DbInstance } from '../../src/types/rds-instance.js'

const mockInstance: DbInstance = {
  id: 1,
  identifier: 'rds-1',
  name: 'Primary',
  host: 'rds-1.example.com',
  port: 5432,
  admin_user: 'postgres',
  auth_method: 'password',
  admin_credential: 'encrypted-password',
  is_management_instance: false,
  region: 'us-east-1',
  status: 'active',
  weight: 100,
  max_databases: 100,
  current_databases: 5,
  created_at: new Date(),
  updated_at: new Date(),
}

describe('instance-connection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('resolveInstanceCredentials', () => {
    it('should resolve credentials using the credential provider', async () => {
      // Re-import to get fresh module state
      const { resolveInstanceCredentials } = await import('../../src/db/instance-connection.js')
      const conn = await resolveInstanceCredentials(mockInstance)

      expect(conn.instanceId).toBe(1)
      expect(conn.host).toBe('rds-1.example.com')
      expect(conn.port).toBe(5432)
      expect(conn.user).toBe('postgres')
      expect(conn.password).toBe('decrypted-password')
    })
  })

  describe('getInstanceSystemPool', () => {
    it('should return a pool for the given instance', async () => {
      const { getInstanceSystemPool } = await import('../../src/db/instance-connection.js')
      const conn = {
        instanceId: 99,
        host: 'test-host',
        port: 5432,
        user: 'postgres',
        password: 'test-pw',
      }

      const pool1 = getInstanceSystemPool(conn)
      const pool2 = getInstanceSystemPool(conn)

      // Same instance ID should return the same pool (cached)
      expect(pool1).toBe(pool2)
    })
  })

  describe('withInstanceTenantClient', () => {
    it('should create a client, run the function, and close the client', async () => {
      const { withInstanceTenantClient } = await import('../../src/db/instance-connection.js')
      const conn = {
        instanceId: 1,
        host: 'test-host',
        port: 5432,
        user: 'postgres',
        password: 'test-pw',
      }

      const result = await withInstanceTenantClient(conn, 'test_db', async (client) => {
        await client.query('SELECT 1')
        return 'done'
      })

      expect(result).toBe('done')
      expect(mockClientConnect).toHaveBeenCalled()
      expect(mockClientEnd).toHaveBeenCalled()
    })

    it('should close the client even if the function throws', async () => {
      const { withInstanceTenantClient } = await import('../../src/db/instance-connection.js')
      const conn = {
        instanceId: 1,
        host: 'test-host',
        port: 5432,
        user: 'postgres',
        password: 'test-pw',
      }

      await expect(
        withInstanceTenantClient(conn, 'test_db', async () => {
          throw new Error('test error')
        })
      ).rejects.toThrow('test error')

      expect(mockClientEnd).toHaveBeenCalled()
    })
  })

  describe('removeInstancePool', () => {
    it('should close and remove a cached pool', async () => {
      const { getInstanceSystemPool, removeInstancePool } = await import('../../src/db/instance-connection.js')
      const conn = {
        instanceId: 200,
        host: 'remove-test',
        port: 5432,
        user: 'postgres',
        password: 'pw',
      }

      // Create a pool first
      getInstanceSystemPool(conn)

      // Remove it
      await removeInstancePool(200)

      // Getting pool again should create a new one
      const newPool = getInstanceSystemPool(conn)
      expect(newPool).toBeDefined()
    })

    it('should handle removing a non-existent pool gracefully', async () => {
      const { removeInstancePool } = await import('../../src/db/instance-connection.js')
      // Should not throw
      await removeInstancePool(999)
    })
  })

  describe('closeAllInstancePools', () => {
    it('should close all cached pools', async () => {
      const { getInstanceSystemPool, closeAllInstancePools } = await import('../../src/db/instance-connection.js')

      // Create pools for two instances
      getInstanceSystemPool({ instanceId: 301, host: 'h1', port: 5432, user: 'u', password: 'p' })
      getInstanceSystemPool({ instanceId: 302, host: 'h2', port: 5432, user: 'u', password: 'p' })

      await closeAllInstancePools()

      // Should not throw
      expect(mockPoolEnd).toHaveBeenCalled()
    })
  })
})
