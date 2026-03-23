/**
 * Unit tests for SecretsManagerCredentialProvider
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  DescribeSecretCommand,
  DeleteSecretCommand,
} from '@aws-sdk/client-secrets-manager'
import { SecretsManagerCredentialProvider } from './secrets-manager-credential-provider'
import type { Cluster } from './types'

// Mock AWS SDK
vi.mock('@aws-sdk/client-secrets-manager', () => {
  const mockSend = vi.fn()
  return {
    SecretsManagerClient: vi.fn(() => ({
      send: mockSend,
    })),
    GetSecretValueCommand: vi.fn(),
    DescribeSecretCommand: vi.fn(),
    DeleteSecretCommand: vi.fn(),
  }
})

describe('SecretsManagerCredentialProvider', () => {
  let provider: SecretsManagerCredentialProvider
  let mockCluster: Cluster
  let mockClient: any

  beforeEach(() => {
    vi.clearAllMocks()

    provider = new SecretsManagerCredentialProvider({
      region: 'us-east-1',
      maxRetries: 2,
      timeout: 1000,
    })

    mockCluster = {
      id: 1,
      identifier: 'test-cluster',
      name: 'Test Cluster',
      host: 'localhost',
      port: 5432,
      admin_user: 'postgres',
      auth_method: 'secrets_manager',
      admin_credential: 'arn:aws:secretsmanager:us-east-1:123456789:secret:test-secret',
      is_management_instance: false,
      region: 'us-east-1',
      status: 'offline',
      weight: 100,
      max_databases: 100,
      current_databases: 0,
      created_at: new Date(),
      updated_at: new Date(),
    }

    // Get the mock client instance
    mockClient = (SecretsManagerClient as any).mock.results[0].value
  })

  describe('constructor', () => {
    it('should create provider with default configuration', () => {
      const defaultProvider = new SecretsManagerCredentialProvider()
      expect(defaultProvider).toBeDefined()
    })

    it('should create provider with custom configuration', () => {
      expect(provider).toBeDefined()
    })
  })

  describe('getCredential', () => {
    it('should retrieve string secret from Secrets Manager', async () => {
      const secretValue = 'my-secret-password'
      mockClient.send.mockResolvedValueOnce({
        SecretString: secretValue,
      })

      const result = await provider.getCredential(mockCluster)

      expect(result).toBe(secretValue)
      expect(GetSecretValueCommand).toHaveBeenCalledWith({
        SecretId: mockCluster.admin_credential,
      })
    })

    it('should retrieve binary secret from Secrets Manager', async () => {
      const secretValue = 'my-secret-password'
      const binarySecret = Buffer.from(secretValue, 'utf-8')
      mockClient.send.mockResolvedValueOnce({
        SecretBinary: binarySecret,
      })

      const result = await provider.getCredential(mockCluster)

      expect(result).toBe(secretValue)
    })

    it('should throw error if no credential reference is stored', async () => {
      mockCluster.admin_credential = ''

      await expect(provider.getCredential(mockCluster)).rejects.toThrow(
        'No secret reference stored for cluster test-cluster'
      )
    })

    it('should throw error if secret value is empty', async () => {
      mockClient.send.mockResolvedValueOnce({})

      await expect(provider.getCredential(mockCluster)).rejects.toThrow('Secret value is empty')
    })

    it('should throw error on Secrets Manager API failure', async () => {
      mockClient.send.mockRejectedValueOnce(new Error('API Error'))

      await expect(provider.getCredential(mockCluster)).rejects.toThrow(
        'Failed to retrieve secret for cluster test-cluster'
      )
    })

    it('should retry on transient failures', async () => {
      const secretValue = 'my-secret-password'
      mockClient.send
        .mockRejectedValueOnce(new Error('Transient error'))
        .mockResolvedValueOnce({
          SecretString: secretValue,
        })

      const result = await provider.getCredential(mockCluster)

      expect(result).toBe(secretValue)
      expect(mockClient.send).toHaveBeenCalledTimes(2)
    })

    it('should not retry on non-retryable errors', async () => {
      const error = new Error('Access denied')
      error.name = 'AccessDeniedException'
      mockClient.send.mockRejectedValueOnce(error)

      await expect(provider.getCredential(mockCluster)).rejects.toThrow()
      expect(mockClient.send).toHaveBeenCalledTimes(1)
    })
  })

  describe('storeCredential', () => {
    it('should validate and store secret reference', async () => {
      const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789:secret:new-secret'
      mockClient.send.mockResolvedValueOnce({
        ARN: secretArn,
        Name: 'new-secret',
      })

      await provider.storeCredential(mockCluster, secretArn)

      expect(mockCluster.admin_credential).toBe(secretArn)
      expect(DescribeSecretCommand).toHaveBeenCalledWith({
        SecretId: secretArn,
      })
    })

    it('should throw error for empty secret reference', async () => {
      await expect(provider.storeCredential(mockCluster, '')).rejects.toThrow(
        'Credential cannot be empty'
      )
    })

    it('should throw error if secret validation fails', async () => {
      const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789:secret:invalid'
      const error = new Error('Secret not found')
      error.name = 'ResourceNotFoundException'
      mockClient.send.mockRejectedValueOnce(error)

      await expect(provider.storeCredential(mockCluster, secretArn)).rejects.toThrow(
        'Failed to validate secret reference'
      )
    })

    it('should retry validation on transient failures', async () => {
      const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789:secret:new-secret'
      mockClient.send
        .mockRejectedValueOnce(new Error('Transient error'))
        .mockResolvedValueOnce({
          ARN: secretArn,
          Name: 'new-secret',
        })

      await provider.storeCredential(mockCluster, secretArn)

      expect(mockCluster.admin_credential).toBe(secretArn)
      expect(mockClient.send).toHaveBeenCalledTimes(2)
    })
  })

  describe('deleteCredential', () => {
    it('should delete secret from Secrets Manager', async () => {
      mockClient.send.mockResolvedValueOnce({})

      await provider.deleteCredential(mockCluster)

      expect(DeleteSecretCommand).toHaveBeenCalledWith({
        SecretId: mockCluster.admin_credential,
        ForceDeleteWithoutRecovery: true,
      })
    })

    it('should handle empty credential reference gracefully', async () => {
      mockCluster.admin_credential = ''

      await provider.deleteCredential(mockCluster)

      expect(mockClient.send).not.toHaveBeenCalled()
    })

    it('should throw error on deletion failure', async () => {
      mockClient.send.mockRejectedValueOnce(new Error('Deletion failed'))

      await expect(provider.deleteCredential(mockCluster)).rejects.toThrow(
        'Failed to delete secret for cluster test-cluster'
      )
    })

    it('should retry deletion on transient failures', async () => {
      mockClient.send.mockRejectedValueOnce(new Error('Transient error')).mockResolvedValueOnce({})

      await provider.deleteCredential(mockCluster)

      expect(mockClient.send).toHaveBeenCalledTimes(2)
    })
  })

  describe('retry logic', () => {
    it('should respect maxRetries configuration', async () => {
      const provider = new SecretsManagerCredentialProvider({
        maxRetries: 3,
      })
      const mockClient = (SecretsManagerClient as any).mock.results[
        (SecretsManagerClient as any).mock.results.length - 1
      ].value

      mockClient.send.mockRejectedValue(new Error('Always fails'))

      await expect(provider.getCredential(mockCluster)).rejects.toThrow()
      expect(mockClient.send).toHaveBeenCalledTimes(3)
    })

    it('should use exponential backoff between retries', async () => {
      const startTime = Date.now()
      mockClient.send.mockRejectedValue(new Error('Always fails'))

      await expect(provider.getCredential(mockCluster)).rejects.toThrow()

      const endTime = Date.now()
      const elapsed = endTime - startTime

      // With 2 retries and exponential backoff (100ms, 200ms), should take at least 300ms
      expect(elapsed).toBeGreaterThanOrEqual(250)
    })
  })
})
