/**
 * Secrets Manager Credential Provider
 * 
 * Implements credential management using AWS Secrets Manager (or compatible service).
 * Credentials are stored externally and referenced by ARN or secret ID.
 * 
 * Requirements: 14.3, 15.4
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  ResourceNotFoundException,
  InvalidParameterException,
  InvalidRequestException,
  DecryptionFailure,
  InternalServiceError,
} from '@aws-sdk/client-secrets-manager'
import { BaseCredentialProvider } from './credential-provider'
import type { Cluster } from './types'

/**
 * Configuration for Secrets Manager integration
 */
interface SecretsManagerProviderConfig {
  /**
   * AWS region for Secrets Manager
   */
  region?: string

  /**
   * Maximum number of retry attempts for API calls
   */
  maxRetries?: number

  /**
   * Timeout for API calls in milliseconds
   */
  timeout?: number
}

/**
 * Custom error for Secrets Manager operations
 */
class SecretsManagerError extends Error {
  constructor(
    message: string,
    public readonly isRetryable: boolean = true,
    public readonly cause?: Error
  ) {
    super(message)
    this.name = 'SecretsManagerError'
  }
}

/**
 * Secrets Manager credential provider with retry logic
 * 
 * This provider integrates with AWS Secrets Manager to retrieve credentials
 * using secret references (ARN or ID) stored in the admin_credential field.
 * 
 * Implements exponential backoff retry for transient failures.
 */
export class SecretsManagerCredentialProvider extends BaseCredentialProvider {
  private readonly client: SecretsManagerClient
  private readonly maxRetries: number
  private readonly timeout: number

  /**
   * Create a new SecretsManagerCredentialProvider
   * 
   * @param config - Configuration for Secrets Manager client
   */
  constructor(config: SecretsManagerProviderConfig = {}) {
    super()

    this.maxRetries = config.maxRetries ?? 3
    this.timeout = config.timeout ?? 5000

    this.client = new SecretsManagerClient({
      region: config.region ?? process.env.AWS_REGION ?? 'us-east-1',
      maxAttempts: this.maxRetries,
      requestHandler: {
        requestTimeout: this.timeout,
      },
    })
  }

  /**
   * Retrieve the credential from Secrets Manager
   * 
   * @param cluster - The cluster configuration
   * @returns Promise resolving to the plaintext credential
   * @throws SecretsManagerError if secret cannot be retrieved
   */
  async getCredential(cluster: Cluster): Promise<string> {
    if (!cluster.admin_credential) {
      throw new SecretsManagerError(
        `No secret reference stored for cluster ${cluster.identifier}`,
        false
      )
    }

    const secretId = cluster.admin_credential

    try {
      const command = new GetSecretValueCommand({
        SecretId: secretId,
      })

      const response = await this.retryWithBackoff(async () => {
        return await this.client.send(command)
      })

      if (response.SecretString) {
        return response.SecretString
      } else if (response.SecretBinary) {
        // Handle binary secrets by converting to string
        const buffer = Buffer.from(response.SecretBinary)
        return buffer.toString('utf-8')
      } else {
        throw new SecretsManagerError('Secret value is empty', false)
      }
    } catch (error) {
      // Handle specific AWS SDK errors
      if (error instanceof ResourceNotFoundException) {
        throw new SecretsManagerError(
          `Secret not found for cluster ${cluster.identifier}: ${secretId}`,
          false,
          error
        )
      }

      if (error instanceof InvalidParameterException || error instanceof InvalidRequestException) {
        throw new SecretsManagerError(
          `Invalid secret reference for cluster ${cluster.identifier}: ${secretId}`,
          false,
          error
        )
      }

      if (error instanceof DecryptionFailure) {
        throw new SecretsManagerError(
          `Failed to decrypt secret for cluster ${cluster.identifier}`,
          false,
          error
        )
      }

      if (error instanceof InternalServiceError) {
        throw new SecretsManagerError(
          `Secrets Manager service error for cluster ${cluster.identifier}`,
          true,
          error instanceof Error ? error : undefined
        )
      }

      if (error instanceof SecretsManagerError) {
        throw error
      }

      throw new SecretsManagerError(
        `Failed to retrieve secret for cluster ${cluster.identifier}`,
        true,
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Store a secret reference for a cluster
   * 
   * This method validates that the secret exists and is accessible,
   * then stores the reference in the cluster configuration.
   * 
   * Note: This does not create the secret in Secrets Manager.
   * The secret must already exist.
   * 
   * @param cluster - The cluster configuration (admin_credential will be modified)
   * @param secretReference - The secret ARN or ID
   * @returns Promise resolving when reference is validated and stored
   * @throws SecretsManagerError if secret reference is invalid or inaccessible
   */
  async storeCredential(cluster: Cluster, secretReference: string): Promise<void> {
    this.validateCredential(secretReference)

    // Validate that the secret exists and is accessible
    try {
      const command = new DescribeSecretCommand({
        SecretId: secretReference,
      })

      await this.retryWithBackoff(async () => {
        return await this.client.send(command)
      })

      // If validation succeeds, store the reference
      cluster.admin_credential = secretReference
    } catch (error) {
      // Handle specific AWS SDK errors
      if (error instanceof ResourceNotFoundException) {
        throw new SecretsManagerError(
          `Secret not found: ${secretReference}`,
          false,
          error
        )
      }

      if (error instanceof InvalidParameterException || error instanceof InvalidRequestException) {
        throw new SecretsManagerError(
          `Invalid secret reference: ${secretReference}`,
          false,
          error
        )
      }

      if (error instanceof SecretsManagerError) {
        throw error
      }

      throw new SecretsManagerError(
        `Failed to validate secret reference for cluster ${cluster.identifier}`,
        true,
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Delete the secret from Secrets Manager
   * 
   * This is an optional operation that should only be called when
   * the delete_secret flag is set during cluster deletion.
   * 
   * @param cluster - The cluster configuration
   * @returns Promise resolving when secret is deleted
   * @throws SecretsManagerError if secret cannot be deleted
   */
  async deleteCredential(cluster: Cluster): Promise<void> {
    if (!cluster.admin_credential) {
      return // Nothing to delete
    }

    const secretId = cluster.admin_credential

    try {
      const command = new DeleteSecretCommand({
        SecretId: secretId,
        ForceDeleteWithoutRecovery: true,
      })

      await this.retryWithBackoff(async () => {
        return await this.client.send(command)
      })
    } catch (error) {
      // Handle specific AWS SDK errors
      if (error instanceof ResourceNotFoundException) {
        // Secret already deleted or doesn't exist - not an error
        return
      }

      if (error instanceof InvalidParameterException || error instanceof InvalidRequestException) {
        throw new SecretsManagerError(
          `Invalid secret reference for cluster ${cluster.identifier}: ${secretId}`,
          false,
          error
        )
      }

      if (error instanceof SecretsManagerError) {
        throw error
      }

      throw new SecretsManagerError(
        `Failed to delete secret for cluster ${cluster.identifier}`,
        true,
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Test credential retrieval and validate secret is accessible
   * 
   * This method can be used to verify that a secret reference is still valid
   * and accessible after credential rotation. It retrieves the credential
   * without caching, ensuring the latest value is fetched.
   * 
   * Requirements: 15.5 (Credential Rotation Support)
   * 
   * @param cluster - The cluster configuration
   * @returns Promise resolving to true if credential is accessible
   * @throws SecretsManagerError if secret cannot be retrieved
   */
  async testCredential(cluster: Cluster): Promise<boolean> {
    try {
      // Attempt to retrieve the credential
      await this.getCredential(cluster)
      return true
    } catch (error) {
      // Re-throw to allow caller to handle
      throw error
    }
  }

  /**
   * Retry an operation with exponential backoff
   * 
   * Implements exponential backoff: 100ms, 200ms, 400ms, etc.
   * Only retries on transient errors.
   * 
   * @param operation - The async operation to retry
   * @returns Promise resolving to the operation result
   * @throws Error if all retries are exhausted or error is non-retryable
   */
  private async retryWithBackoff<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await operation()
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error')

        // Don't retry on certain error types
        if (this.isNonRetryableError(lastError)) {
          throw lastError
        }

        // Calculate backoff delay: 100ms * 2^attempt
        const delay = 100 * Math.pow(2, attempt)

        // Wait before retrying (except on last attempt)
        if (attempt < this.maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    throw lastError ?? new Error('Operation failed after retries')
  }

  /**
   * Check if an error should not be retried
   * 
   * Non-retryable errors include:
   * - ResourceNotFoundException: Secret doesn't exist
   * - InvalidParameterException: Invalid input
   * - InvalidRequestException: Malformed request
   * - DecryptionFailure: Cannot decrypt secret
   * 
   * @param error - The error to check
   * @returns true if error should not be retried
   */
  private isNonRetryableError(error: Error): boolean {
    return (
      error instanceof ResourceNotFoundException ||
      error instanceof InvalidParameterException ||
      error instanceof InvalidRequestException ||
      error instanceof DecryptionFailure
    )
  }
}

