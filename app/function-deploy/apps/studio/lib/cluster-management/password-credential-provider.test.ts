/**
 * Unit tests for PasswordCredentialProvider
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PasswordCredentialProvider } from './password-credential-provider'
import type { Cluster } from './types'

describe('PasswordCredentialProvider', () => {
  let provider: PasswordCredentialProvider
  let mockCluster: Cluster

  beforeEach(() => {
    provider = new PasswordCredentialProvider({
      encryptionKey: 'test-encryption-key-32-characters',
    })

    mockCluster = {
      id: 1,
      identifier: 'test-cluster',
      name: 'Test Cluster',
      host: 'localhost',
      port: 5432,
      admin_user: 'postgres',
      auth_method: 'password',
      admin_credential: '',
      is_management_instance: false,
      region: 'us-east-1',
      status: 'offline',
      weight: 100,
      max_databases: 100,
      current_databases: 0,
      created_at: new Date(),
      updated_at: new Date(),
    }
  })

  describe('constructor', () => {
    it('should throw error if encryption key is not provided', () => {
      expect(() => {
        new PasswordCredentialProvider({ encryptionKey: '' })
      }).toThrow('Encryption key is required')
    })

    it('should create provider with valid encryption key', () => {
      expect(provider).toBeDefined()
    })
  })

  describe('storeCredential', () => {
    it('should encrypt and store credential with encrypted: prefix', async () => {
      const password = 'my-secure-password'

      await provider.storeCredential(mockCluster, password)

      expect(mockCluster.admin_credential).toMatch(/^encrypted:/)
      expect(mockCluster.admin_credential).not.toContain(password)
    })

    it('should throw error for empty credential', async () => {
      await expect(provider.storeCredential(mockCluster, '')).rejects.toThrow(
        'Credential cannot be empty'
      )
    })

    it('should throw error for whitespace-only credential', async () => {
      await expect(provider.storeCredential(mockCluster, '   ')).rejects.toThrow(
        'Credential cannot be empty'
      )
    })
  })

  describe('getCredential', () => {
    it('should decrypt stored credential', async () => {
      const password = 'my-secure-password'

      await provider.storeCredential(mockCluster, password)
      const decrypted = await provider.getCredential(mockCluster)

      expect(decrypted).toBe(password)
    })

    it('should throw error if no credential is stored', async () => {
      await expect(provider.getCredential(mockCluster)).rejects.toThrow(
        'No credential stored for cluster test-cluster'
      )
    })

    it('should throw error if credential format is invalid', async () => {
      mockCluster.admin_credential = 'invalid-format'

      await expect(provider.getCredential(mockCluster)).rejects.toThrow(
        'Invalid credential format'
      )
    })

    it('should handle encryption round-trip for various passwords', async () => {
      const passwords = [
        'simple',
        'with spaces',
        'with-special-chars!@#$%',
        '12345678',
        'very-long-password-with-many-characters-to-test-encryption',
      ]

      for (const password of passwords) {
        const cluster = { ...mockCluster }
        await provider.storeCredential(cluster, password)
        const decrypted = await provider.getCredential(cluster)
        expect(decrypted).toBe(password)
      }
    })
  })

  describe('deleteCredential', () => {
    it('should clear the credential field', async () => {
      const password = 'my-secure-password'

      await provider.storeCredential(mockCluster, password)
      expect(mockCluster.admin_credential).not.toBe('')

      await provider.deleteCredential(mockCluster)
      expect(mockCluster.admin_credential).toBe('')
    })
  })

  describe('encryption security', () => {
    it('should produce different encrypted values for same password with different keys', async () => {
      const password = 'test-password'
      const provider1 = new PasswordCredentialProvider({
        encryptionKey: 'key-1-with-32-characters-long',
      })
      const provider2 = new PasswordCredentialProvider({
        encryptionKey: 'key-2-with-32-characters-long',
      })

      const cluster1 = { ...mockCluster }
      const cluster2 = { ...mockCluster }

      await provider1.storeCredential(cluster1, password)
      await provider2.storeCredential(cluster2, password)

      expect(cluster1.admin_credential).not.toBe(cluster2.admin_credential)
    })

    it('should not decrypt with wrong encryption key', async () => {
      const password = 'test-password'
      const provider1 = new PasswordCredentialProvider({
        encryptionKey: 'key-1-with-32-characters-long',
      })
      const provider2 = new PasswordCredentialProvider({
        encryptionKey: 'key-2-with-32-characters-long',
      })

      await provider1.storeCredential(mockCluster, password)

      await expect(provider2.getCredential(mockCluster)).rejects.toThrow()
    })
  })
})
