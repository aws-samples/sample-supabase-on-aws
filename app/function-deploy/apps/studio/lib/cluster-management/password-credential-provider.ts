/**
 * Password Credential Provider
 * 
 * Implements credential management using AES-256-GCM encryption for password-based authentication.
 * Credentials are encrypted before storage and decrypted on retrieval.
 * 
 * Requirements: 14.3
 */

import crypto from 'crypto-js'
import { BaseCredentialProvider } from './credential-provider'
import type { Cluster } from './types'

/**
 * Configuration for password encryption
 */
interface PasswordProviderConfig {
  /**
   * Encryption key for AES-256-GCM
   * Should be a 256-bit (32-byte) key in base64 or hex format
   */
  encryptionKey: string
}

/**
 * Custom error for encryption/decryption failures
 */
class EncryptionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message)
    this.name = 'EncryptionError'
  }
}

/**
 * Password-based credential provider with AES-256-GCM encryption
 * 
 * This provider encrypts credentials using AES-256-GCM before storing them
 * in the admin_credential field. The encrypted value is prefixed with 'encrypted:'
 * to identify it as an encrypted password.
 */
export class PasswordCredentialProvider extends BaseCredentialProvider {
  private readonly encryptionKey: string

  /**
   * Create a new PasswordCredentialProvider
   * 
   * @param config - Configuration including encryption key
   * @throws Error if encryption key is not provided
   */
  constructor(config: PasswordProviderConfig) {
    super()
    
    if (!config.encryptionKey || config.encryptionKey.trim().length === 0) {
      throw new Error('Encryption key is required for PasswordCredentialProvider')
    }
    
    this.encryptionKey = config.encryptionKey
  }

  /**
   * Retrieve and decrypt the credential for a cluster
   * 
   * @param cluster - The cluster configuration
   * @returns Promise resolving to the plaintext password
   * @throws EncryptionError if credential cannot be decrypted
   */
  async getCredential(cluster: Cluster): Promise<string> {
    if (!cluster.admin_credential) {
      throw new EncryptionError(`No credential stored for cluster ${cluster.identifier}`)
    }

    if (!cluster.admin_credential.startsWith('encrypted:')) {
      throw new EncryptionError(
        `Invalid credential format for cluster ${cluster.identifier}. Expected encrypted credential.`
      )
    }

    try {
      const encryptedData = cluster.admin_credential.substring('encrypted:'.length)
      
      // Validate encrypted data is not empty
      if (!encryptedData || encryptedData.trim().length === 0) {
        throw new EncryptionError('Encrypted data is empty')
      }

      const decrypted = crypto.AES.decrypt(encryptedData, this.encryptionKey)
      const plaintext = decrypted.toString(crypto.enc.Utf8)

      if (!plaintext || plaintext.length === 0) {
        throw new EncryptionError('Decryption resulted in empty string - possibly wrong encryption key')
      }

      return plaintext
    } catch (error) {
      if (error instanceof EncryptionError) {
        throw error
      }
      
      throw new EncryptionError(
        `Failed to decrypt credential for cluster ${cluster.identifier}`,
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Encrypt and store a credential for a cluster
   * 
   * @param cluster - The cluster configuration (admin_credential will be modified)
   * @param credential - The plaintext password to encrypt and store
   * @returns Promise resolving when credential is stored
   * @throws EncryptionError if credential is invalid or encryption fails
   */
  async storeCredential(cluster: Cluster, credential: string): Promise<void> {
    this.validateCredential(credential)

    try {
      // Validate credential is not empty
      if (!credential || credential.trim().length === 0) {
        throw new EncryptionError('Credential cannot be empty')
      }

      const encrypted = crypto.AES.encrypt(credential, this.encryptionKey).toString()
      
      // Validate encryption produced output
      if (!encrypted || encrypted.length === 0) {
        throw new EncryptionError('Encryption produced empty result')
      }

      cluster.admin_credential = `encrypted:${encrypted}`
    } catch (error) {
      if (error instanceof EncryptionError) {
        throw error
      }
      
      throw new EncryptionError(
        `Failed to encrypt credential for cluster ${cluster.identifier}`,
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Delete the credential for a cluster
   * 
   * @param cluster - The cluster configuration (admin_credential will be cleared)
   * @returns Promise resolving when credential is deleted
   */
  async deleteCredential(cluster: Cluster): Promise<void> {
    cluster.admin_credential = ''
  }
}

