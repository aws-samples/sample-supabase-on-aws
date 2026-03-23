/**
 * Credential provider system for RDS instance authentication
 * Supports both password (AES-256-CBC encrypted) and AWS Secrets Manager modes
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  DescribeSecretCommand,
  DeleteSecretCommand,
  ResourceNotFoundException,
  InvalidParameterException,
  InvalidRequestException,
  DecryptionFailure,
} from '@aws-sdk/client-secrets-manager'
import { encryptSecret, decryptSecret } from './encryption.js'
import { getEnv } from '../../config/index.js'
import type { DbInstance } from '../../types/rds-instance.js'

/**
 * Credential provider interface
 */
export interface CredentialProvider {
  getCredential(instance: DbInstance): Promise<string>
  storeCredential(credential: string): Promise<string>
  deleteCredential(instance: DbInstance): Promise<void>
}

/**
 * Password-based credential provider using existing AES-256-CBC encryption
 */
export class PasswordCredentialProvider implements CredentialProvider {
  async getCredential(instance: DbInstance): Promise<string> {
    if (!instance.admin_credential) {
      throw new Error(`No credential stored for instance ${instance.identifier}`)
    }
    return decryptSecret(instance.admin_credential)
  }

  async storeCredential(credential: string): Promise<string> {
    if (!credential || credential.trim().length === 0) {
      throw new Error('Credential cannot be empty')
    }
    return encryptSecret(credential)
  }

  async deleteCredential(_instance: DbInstance): Promise<void> {
    // Nothing to clean up for password mode - credential is stored in DB column
  }
}

/**
 * AWS Secrets Manager credential provider with exponential backoff retry
 */
export class SecretsManagerCredentialProvider implements CredentialProvider {
  private readonly client: SecretsManagerClient
  private readonly maxRetries: number

  constructor() {
    const env = getEnv()
    this.maxRetries = env.AWS_SM_MAX_RETRIES
    this.client = new SecretsManagerClient({
      region: env.AWS_SM_REGION ?? env.AWS_REGION,
      maxAttempts: this.maxRetries,
      ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
    })
  }

  async getCredential(instance: DbInstance): Promise<string> {
    if (!instance.admin_credential) {
      throw new Error(`No secret reference stored for instance ${instance.identifier}`)
    }

    try {
      const response = await this.retryWithBackoff(() =>
        this.client.send(new GetSecretValueCommand({ SecretId: instance.admin_credential! }))
      )

      if (response.SecretString) {
        return response.SecretString
      } else if (response.SecretBinary) {
        return Buffer.from(response.SecretBinary).toString('utf-8')
      }
      throw new Error('Secret value is empty')
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        throw new Error(`Secret not found for instance ${instance.identifier}: ${instance.admin_credential}`)
      }
      if (error instanceof InvalidParameterException || error instanceof InvalidRequestException) {
        throw new Error(`Invalid secret reference for instance ${instance.identifier}: ${instance.admin_credential}`)
      }
      if (error instanceof DecryptionFailure) {
        throw new Error(`Failed to decrypt secret for instance ${instance.identifier}`)
      }
      throw error
    }
  }

  async storeCredential(secretReference: string): Promise<string> {
    if (!secretReference || secretReference.trim().length === 0) {
      throw new Error('Secret reference cannot be empty')
    }

    // Validate the secret exists and is accessible
    try {
      await this.retryWithBackoff(() =>
        this.client.send(new DescribeSecretCommand({ SecretId: secretReference }))
      )
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        throw new Error(`Secret not found: ${secretReference}`)
      }
      if (error instanceof InvalidParameterException || error instanceof InvalidRequestException) {
        throw new Error(`Invalid secret reference: ${secretReference}`)
      }
      throw error
    }

    // Return the reference as-is (no encryption needed)
    return secretReference
  }

  async deleteCredential(instance: DbInstance): Promise<void> {
    if (!instance.admin_credential) return

    try {
      await this.retryWithBackoff(() =>
        this.client.send(
          new DeleteSecretCommand({
            SecretId: instance.admin_credential!,
            ForceDeleteWithoutRecovery: true,
          })
        )
      )
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        return // Already deleted
      }
      throw error
    }
  }

  private async retryWithBackoff<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await operation()
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error')

        // Don't retry non-retryable errors
        if (
          error instanceof ResourceNotFoundException ||
          error instanceof InvalidParameterException ||
          error instanceof InvalidRequestException ||
          error instanceof DecryptionFailure
        ) {
          throw error
        }

        if (attempt < this.maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)))
        }
      }
    }

    throw lastError ?? new Error('Operation failed after retries')
  }
}

// Singleton instances
let passwordProvider: PasswordCredentialProvider | null = null
let secretsManagerProvider: SecretsManagerCredentialProvider | null = null

/**
 * Factory function to get the appropriate credential provider
 */
export function getCredentialProvider(authMethod: string): CredentialProvider {
  if (authMethod === 'secrets_manager') {
    if (!secretsManagerProvider) {
      secretsManagerProvider = new SecretsManagerCredentialProvider()
    }
    return secretsManagerProvider
  }

  // Default to password mode
  if (!passwordProvider) {
    passwordProvider = new PasswordCredentialProvider()
  }
  return passwordProvider
}
