/**
 * Credential Provider Interface and Base Implementation
 * 
 * This module defines the interface for managing database cluster credentials
 * with support for both password-based and Secrets Manager authentication methods.
 */

import type { Cluster } from './types'

/**
 * Interface for credential management providers
 * 
 * Implementations must handle credential storage, retrieval, and deletion
 * according to their specific authentication method (password or secrets_manager).
 */
export interface CredentialProvider {
  /**
   * Retrieve the credential for a cluster
   * 
   * @param cluster - The cluster configuration
   * @returns Promise resolving to the plaintext credential
   * @throws Error if credential cannot be retrieved
   */
  getCredential(cluster: Cluster): Promise<string>

  /**
   * Store a credential for a cluster
   * 
   * @param cluster - The cluster configuration (will be modified)
   * @param credential - The plaintext credential to store
   * @returns Promise resolving when credential is stored
   * @throws Error if credential cannot be stored
   */
  storeCredential(cluster: Cluster, credential: string): Promise<void>

  /**
   * Delete a credential for a cluster
   * 
   * @param cluster - The cluster configuration
   * @returns Promise resolving when credential is deleted
   * @throws Error if credential cannot be deleted
   */
  deleteCredential(cluster: Cluster): Promise<void>
}

/**
 * Base implementation providing common functionality for credential providers
 */
export abstract class BaseCredentialProvider implements CredentialProvider {
  abstract getCredential(cluster: Cluster): Promise<string>
  abstract storeCredential(cluster: Cluster, credential: string): Promise<void>
  abstract deleteCredential(cluster: Cluster): Promise<void>

  /**
   * Mask a credential for safe logging
   * 
   * @param credential - The credential to mask
   * @returns Masked credential string
   */
  protected maskCredential(credential: string): string {
    if (!credential || credential.length === 0) {
      return '***'
    }
    return '***'
  }

  /**
   * Validate that a credential is not empty
   * 
   * @param credential - The credential to validate
   * @throws Error if credential is empty
   */
  protected validateCredential(credential: string): void {
    if (!credential || credential.trim().length === 0) {
      throw new Error('Credential cannot be empty')
    }
  }
}
