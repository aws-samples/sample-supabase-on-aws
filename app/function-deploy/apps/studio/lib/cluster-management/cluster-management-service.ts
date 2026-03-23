/**
 * Cluster Management Service
 * 
 * Business logic layer for database cluster management operations.
 * Handles cluster registration, lifecycle management, capacity updates, and validation.
 */

import type { Cluster, ClusterMetrics } from './types'
import type { ClusterRepository } from './cluster-repository'
import type { CredentialProvider } from './credential-provider'
import { PasswordCredentialProvider } from './password-credential-provider'
import { SecretsManagerCredentialProvider } from './secrets-manager-credential-provider'

export interface RegisterClusterInput {
  identifier: string
  name: string
  host: string
  port: number
  admin_user: string
  auth_method: 'password' | 'secrets_manager'
  credential: string
  region: string
  weight: number
  max_databases: number
  is_management_instance?: boolean
}

export interface PlatformMetrics {
  total_clusters: number
  online_clusters: number
  offline_clusters: number
  maintenance_clusters: number
  total_capacity: number
  total_allocated: number
  platform_utilization_percentage: number
  max_utilized_cluster: {
    identifier: string
    name: string
    utilization_percentage: number
  } | null
  min_utilized_cluster: {
    identifier: string
    name: string
    utilization_percentage: number
  } | null
}

export interface ClusterStatusResponse {
  clusters: Array<Cluster & { utilization_percentage: number }>
  summary: PlatformMetrics
}

/**
 * Cluster Management Service
 * 
 * Provides high-level operations for managing database clusters including:
 * - Registration with credential handling
 * - Lifecycle management (online/offline)
 * - Deletion with validation
 * - Capacity management
 * - Status and metrics queries
 */
export class ClusterManagementService {
  private repository: ClusterRepository
  private passwordProvider: PasswordCredentialProvider
  private secretsManagerProvider: SecretsManagerCredentialProvider

  constructor(
    repository: ClusterRepository,
    encryptionKey: string,
    secretsManagerConfig?: {
      region?: string
      maxRetries?: number
    }
  ) {
    this.repository = repository
    this.passwordProvider = new PasswordCredentialProvider({ encryptionKey })
    this.secretsManagerProvider = new SecretsManagerCredentialProvider(secretsManagerConfig)
  }

  /**
   * Register a new database cluster
   * 
   * Validates input, handles credential storage based on auth_method,
   * and creates the cluster record with initial status 'offline'.
   * 
   * Requirements: 4.1, 4.2, 4.3, 4.4
   */
  async registerCluster(
    input: RegisterClusterInput,
    connectionString: string
  ): Promise<Cluster> {
    // Validate required fields
    this.validateRequiredFields(input)
    
    // Validate enum values
    this.validateAuthMethod(input.auth_method)
    
    // Check for duplicate identifier
    const existing = await this.repository.findByIdentifier(
      input.identifier,
      connectionString
    )
    if (existing) {
      throw new Error(`Cluster with identifier '${input.identifier}' already exists`)
    }

    // Handle credential storage based on auth_method
    let storedCredential: string
    
    if (input.auth_method === 'password') {
      // Encrypt password
      const tempCluster = {
        ...input,
        id: 0,
        status: 'offline' as const,
        current_databases: 0,
        created_at: new Date(),
        updated_at: new Date(),
        admin_credential: '',
        is_management_instance: input.is_management_instance ?? false,
      }
      await this.passwordProvider.storeCredential(tempCluster, input.credential)
      storedCredential = tempCluster.admin_credential
    } else {
      // Validate secret reference exists
      const tempCluster = {
        ...input,
        id: 0,
        status: 'offline' as const,
        current_databases: 0,
        created_at: new Date(),
        updated_at: new Date(),
        admin_credential: input.credential,
        is_management_instance: input.is_management_instance ?? false,
      }
      
      try {
        // Attempt to retrieve the secret to validate it exists
        await this.secretsManagerProvider.getCredential(tempCluster)
      } catch (error) {
        throw new Error(`Invalid secret reference: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
      
      storedCredential = input.credential
    }

    // Create cluster with status='offline'
    const cluster = await this.repository.create(
      {
        identifier: input.identifier,
        name: input.name,
        host: input.host,
        port: input.port,
        admin_user: input.admin_user,
        auth_method: input.auth_method,
        admin_credential: storedCredential,
        is_management_instance: input.is_management_instance ?? false,
        region: input.region,
        status: 'offline',
        weight: input.weight,
        max_databases: input.max_databases,
        current_databases: 0,
      },
      connectionString
    )

    return cluster
  }

  /**
   * Bring a cluster online
   * 
   * Updates cluster status to 'online', making it available for project allocation.
   * 
   * Requirements: 5.1
   */
  async bringOnline(
    identifier: string,
    connectionString: string
  ): Promise<Cluster> {
    const cluster = await this.repository.findByIdentifier(identifier, connectionString)
    if (!cluster) {
      throw new Error(`Cluster with identifier '${identifier}' not found`)
    }

    return await this.repository.updateStatus(identifier, 'online', connectionString)
  }

  /**
   * Take a cluster offline
   * 
   * Updates cluster status to 'offline', preventing new project allocations.
   * 
   * Requirements: 5.2
   */
  async takeOffline(
    identifier: string,
    connectionString: string
  ): Promise<Cluster> {
    const cluster = await this.repository.findByIdentifier(identifier, connectionString)
    if (!cluster) {
      throw new Error(`Cluster with identifier '${identifier}' not found`)
    }

    return await this.repository.updateStatus(identifier, 'offline', connectionString)
  }

  /**
   * Delete a cluster
   * 
   * Validates that the cluster has no active databases before deletion.
   * Optionally deletes the associated secret from Secrets Manager.
   * 
   * Requirements: 6.1, 6.2, 6.3
   */
  async deleteCluster(
    identifier: string,
    deleteSecret: boolean,
    connectionString: string
  ): Promise<void> {
    const cluster = await this.repository.findByIdentifier(identifier, connectionString)
    if (!cluster) {
      throw new Error(`Cluster with identifier '${identifier}' not found`)
    }

    // Validate cluster has zero current_databases
    if (cluster.current_databases > 0) {
      throw new Error(
        `Cannot delete cluster '${identifier}': cluster has ${cluster.current_databases} active databases`
      )
    }

    // Optionally delete secret from Secrets Manager
    if (deleteSecret && cluster.auth_method === 'secrets_manager') {
      try {
        await this.secretsManagerProvider.deleteCredential(cluster)
      } catch (error) {
        // Log error but don't fail deletion
        console.error(`Failed to delete secret for cluster '${identifier}':`, error)
      }
    }

    // Delete cluster record
    await this.repository.delete(cluster.id, connectionString)
  }

  /**
   * Update cluster capacity
   * 
   * Validates that new max_databases is greater than current_databases.
   * 
   * Requirements: 8.1, 8.2, 8.3
   */
  async updateCapacity(
    identifier: string,
    maxDatabases: number,
    connectionString: string
  ): Promise<Cluster> {
    const cluster = await this.repository.findByIdentifier(identifier, connectionString)
    if (!cluster) {
      throw new Error(`Cluster with identifier '${identifier}' not found`)
    }

    // Validate new capacity is greater than current allocation
    if (maxDatabases <= cluster.current_databases) {
      throw new Error(
        `Cannot update capacity: new max_databases (${maxDatabases}) must be greater than current_databases (${cluster.current_databases})`
      )
    }

    return await this.repository.updateCapacity(identifier, maxDatabases, connectionString)
  }

  /**
   * Get credential provider for a cluster
   */
  private getCredentialProvider(cluster: Cluster): CredentialProvider {
    return cluster.auth_method === 'password'
      ? this.passwordProvider
      : this.secretsManagerProvider
  }

  /**
   * Test cluster credentials
   * 
   * Validates that credentials for a cluster are accessible and valid.
   * This is useful after credential rotation to ensure the system can
   * still access the cluster.
   * 
   * Requirements: 15.5 (Credential Rotation Support)
   * 
   * @param identifier - Cluster identifier
   * @param connectionString - Database connection string
   * @returns Promise resolving to true if credentials are valid
   * @throws Error if cluster not found or credentials invalid
   */
  async testClusterCredentials(
    identifier: string,
    connectionString: string
  ): Promise<boolean> {
    const cluster = await this.repository.findByIdentifier(identifier, connectionString)
    if (!cluster) {
      throw new Error(`Cluster with identifier '${identifier}' not found`)
    }

    try {
      const provider = this.getCredentialProvider(cluster)
      await provider.getCredential(cluster)
      return true
    } catch (error) {
      throw new Error(
        `Failed to retrieve credentials for cluster '${identifier}': ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      )
    }
  }

  /**
   * Handle invalid secret reference
   * 
   * When a secret reference becomes invalid or inaccessible, this method:
   * 1. Marks the cluster status as 'offline'
   * 2. Logs an error with details
   * 
   * This prevents the system from attempting to use clusters with
   * inaccessible credentials.
   * 
   * Requirements: 15.6 (Invalid Secret Handling)
   * 
   * @param identifier - Cluster identifier
   * @param error - The error that occurred
   * @param connectionString - Database connection string
   * @returns Promise resolving when cluster is marked offline
   */
  async handleInvalidSecret(
    identifier: string,
    error: Error,
    connectionString: string
  ): Promise<void> {
    try {
      // Mark cluster offline
      await this.repository.updateStatus(identifier, 'offline', connectionString)

      // Log error with masked credentials
      const maskedMessage = error.message
        .replace(/arn:aws:secretsmanager:[^:]+:[^:]+:secret:[^\s]+/g, 'arn:aws:secretsmanager:***')
        .replace(/secret[=:]\s*['"]?[^'"}\s]+['"]?/gi, 'secret=***')

      console.error(
        `Invalid secret reference for cluster '${identifier}': ${maskedMessage}. Cluster marked offline.`
      )
    } catch (updateError) {
      // Log error if we can't update the cluster status
      console.error(
        `Failed to mark cluster '${identifier}' offline after invalid secret:`,
        updateError
      )
      throw updateError
    }
  }

  /**
   * Validate cluster credentials and handle invalid secrets
   * 
   * Attempts to retrieve credentials for a cluster. If the secret reference
   * is invalid or inaccessible, marks the cluster offline and logs an error.
   * 
   * Requirements: 15.6 (Invalid Secret Handling)
   * 
   * @param identifier - Cluster identifier
   * @param connectionString - Database connection string
   * @returns Promise resolving to true if credentials are valid, false if invalid
   */
  async validateAndHandleCredentials(
    identifier: string,
    connectionString: string
  ): Promise<boolean> {
    try {
      await this.testClusterCredentials(identifier, connectionString)
      return true
    } catch (error) {
      // Check if error is related to invalid secret
      if (
        error instanceof Error &&
        (error.message.includes('Secret not found') ||
          error.message.includes('Invalid secret reference') ||
          error.message.includes('ResourceNotFoundException'))
      ) {
        await this.handleInvalidSecret(identifier, error, connectionString)
        return false
      }

      // Re-throw other errors
      throw error
    }
  }

  /**
   * Validate required fields
   */
  private validateRequiredFields(input: RegisterClusterInput): void {
    const requiredFields: (keyof RegisterClusterInput)[] = [
      'identifier',
      'name',
      'host',
      'port',
      'admin_user',
      'auth_method',
    ]

    for (const field of requiredFields) {
      if (input[field] === undefined || input[field] === null || input[field] === '') {
        throw new Error(`Required field '${field}' is missing`)
      }
    }
  }

  /**
   * Validate auth_method value
   */
  private validateAuthMethod(authMethod: string): void {
    const validMethods = ['password', 'secrets_manager']
    if (!validMethods.includes(authMethod)) {
      throw new Error(`Invalid auth_method: must be one of ${validMethods.join(', ')}`)
    }
  }

  /**
   * Validate status value
   */
  private validateStatus(status: string): void {
    const validStatuses = ['online', 'offline', 'maintenance']
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status: must be one of ${validStatuses.join(', ')}`)
    }
  }

  /**
   * Get cluster status with metrics
   * 
   * Returns all clusters with calculated utilization metrics.
   * Optionally filters by region and/or status.
   * Results are ordered by utilization percentage descending.
   * 
   * Requirements: 9.1, 9.2, 9.3, 9.4
   */
  async getClusterStatus(
    connectionString: string,
    filters?: {
      region?: string
      status?: string
    }
  ): Promise<ClusterStatusResponse> {
    let clusters: Cluster[]

    // Apply filters
    if (filters?.region && filters?.status) {
      // Need to filter by both - fetch all and filter in memory
      const allClusters = await this.repository.findAll(connectionString)
      clusters = allClusters.filter(
        (c) => c.region === filters.region && c.status === filters.status
      )
    } else if (filters?.region) {
      clusters = await this.repository.findByRegion(filters.region, connectionString)
    } else if (filters?.status) {
      clusters = await this.repository.findByStatus(filters.status, connectionString)
    } else {
      clusters = await this.repository.findAll(connectionString)
    }

    // Calculate utilization for each cluster
    const clustersWithMetrics = clusters.map((cluster) => ({
      ...cluster,
      utilization_percentage: this.calculateUtilization(cluster),
    }))

    // Sort by utilization descending
    clustersWithMetrics.sort((a, b) => b.utilization_percentage - a.utilization_percentage)

    // Calculate platform metrics
    const summary = this.calculatePlatformMetrics(clustersWithMetrics)

    return {
      clusters: clustersWithMetrics,
      summary,
    }
  }

  /**
   * Get platform-level metrics
   * 
   * Calculates aggregated metrics across all clusters.
   * 
   * Requirements: 10.1, 10.2, 10.3
   */
  async getPlatformMetrics(
    connectionString: string
  ): Promise<PlatformMetrics> {
    const clusters = await this.repository.findAll(connectionString)
    
    const clustersWithMetrics = clusters.map((cluster) => ({
      ...cluster,
      utilization_percentage: this.calculateUtilization(cluster),
    }))

    return this.calculatePlatformMetrics(clustersWithMetrics)
  }

  /**
   * Calculate utilization percentage for a cluster
   * 
   * Formula: (current_databases / max_databases) * 100
   * 
   * Requirements: 9.3, 11.2
   */
  private calculateUtilization(cluster: Cluster): number {
    if (cluster.max_databases === 0) return 0
    return (cluster.current_databases / cluster.max_databases) * 100
  }

  /**
   * Calculate platform-wide metrics
   * 
   * Requirements: 10.1, 10.2, 10.3
   */
  private calculatePlatformMetrics(
    clusters: Array<Cluster & { utilization_percentage: number }>
  ): PlatformMetrics {
    const onlineClusters = clusters.filter((c) => c.status === 'online')
    const offlineClusters = clusters.filter((c) => c.status === 'offline')
    const maintenanceClusters = clusters.filter((c) => c.status === 'maintenance')

    // Total capacity from online clusters only
    const totalCapacity = onlineClusters.reduce((sum, c) => sum + c.max_databases, 0)
    const totalAllocated = clusters.reduce((sum, c) => sum + c.current_databases, 0)

    const platformUtilization = totalCapacity > 0 ? (totalAllocated / totalCapacity) * 100 : 0

    // Find max and min utilized clusters
    let maxUtilizedCluster: PlatformMetrics['max_utilized_cluster'] = null
    let minUtilizedCluster: PlatformMetrics['min_utilized_cluster'] = null

    if (clusters.length > 0) {
      const sortedByUtilization = [...clusters].sort(
        (a, b) => b.utilization_percentage - a.utilization_percentage
      )

      maxUtilizedCluster = {
        identifier: sortedByUtilization[0].identifier,
        name: sortedByUtilization[0].name,
        utilization_percentage: sortedByUtilization[0].utilization_percentage,
      }

      minUtilizedCluster = {
        identifier: sortedByUtilization[sortedByUtilization.length - 1].identifier,
        name: sortedByUtilization[sortedByUtilization.length - 1].name,
        utilization_percentage: sortedByUtilization[sortedByUtilization.length - 1].utilization_percentage,
      }
    }

    return {
      total_clusters: clusters.length,
      online_clusters: onlineClusters.length,
      offline_clusters: offlineClusters.length,
      maintenance_clusters: maintenanceClusters.length,
      total_capacity: totalCapacity,
      total_allocated: totalAllocated,
      platform_utilization_percentage: platformUtilization,
      max_utilized_cluster: maxUtilizedCluster,
      min_utilized_cluster: minUtilizedCluster,
    }
  }
}
