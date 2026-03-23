/**
 * Database Cluster Types
 * 
 * These types define the structure for database cluster management,
 * including cluster configuration, metrics, and validation.
 */

export type ClusterStatus = 'online' | 'offline' | 'maintenance'
export type ClusterAuthMethod = 'password' | 'secrets_manager'

/**
 * Cluster represents a managed database instance that can host multiple tenant databases
 */
export interface Cluster {
  id: number
  identifier: string
  name: string
  host: string
  port: number
  admin_user: string
  auth_method: ClusterAuthMethod
  admin_credential: string // Encrypted password or secret reference
  is_management_instance: boolean
  region: string
  status: ClusterStatus
  weight: number
  max_databases: number
  current_databases: number
  created_at: string
  updated_at: string
}

/**
 * ClusterMetrics provides capacity and utilization information for a cluster
 */
export interface ClusterMetrics {
  identifier: string
  max_databases: number
  current_databases: number
  utilization_percentage: number
  available_capacity: number
}

/**
 * ClusterCreatePayload defines the required fields for registering a new cluster
 */
export interface ClusterCreatePayload {
  identifier: string
  name: string
  host: string
  port?: number
  admin_user?: string
  auth_method: ClusterAuthMethod
  credential: string // Password or secret reference
  region?: string
  weight?: number
  max_databases?: number
}

/**
 * ClusterUpdatePayload defines fields that can be updated for an existing cluster
 */
export interface ClusterUpdatePayload {
  identifier: string
  name?: string
  status?: ClusterStatus
  weight?: number
  max_databases?: number
}

/**
 * ClusterValidationError represents validation errors for cluster operations
 */
export interface ClusterValidationError {
  field: string
  message: string
}

/**
 * ClusterValidationResult contains validation results
 */
export interface ClusterValidationResult {
  valid: boolean
  errors: ClusterValidationError[]
}
