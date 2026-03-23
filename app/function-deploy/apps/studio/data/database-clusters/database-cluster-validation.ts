/**
 * Database Cluster Validation
 * 
 * Validates cluster data according to requirements 2.3, 2.4, 4.1, 8.1
 */

import type {
  Cluster,
  ClusterCreatePayload,
  ClusterUpdatePayload,
  ClusterValidationError,
  ClusterValidationResult,
  ClusterStatus,
  ClusterAuthMethod,
} from './database-cluster.types'

const VALID_STATUSES: ClusterStatus[] = ['online', 'offline', 'maintenance']
const VALID_AUTH_METHODS: ClusterAuthMethod[] = ['password', 'secrets_manager']

/**
 * Validates cluster status value
 * Property 1: Status Value Validation
 * Validates: Requirements 2.3
 */
export function validateStatus(status: string): boolean {
  return VALID_STATUSES.includes(status as ClusterStatus)
}

/**
 * Validates cluster auth_method value
 * Property 2: Auth Method Validation
 * Validates: Requirements 2.4
 */
export function validateAuthMethod(authMethod: string): boolean {
  return VALID_AUTH_METHODS.includes(authMethod as ClusterAuthMethod)
}

/**
 * Validates required fields for cluster creation
 * Property 8: Required Fields Validation
 * Validates: Requirements 4.1
 */
export function validateClusterCreate(payload: ClusterCreatePayload): ClusterValidationResult {
  const errors: ClusterValidationError[] = []

  // Required fields validation
  if (!payload.identifier || payload.identifier.trim() === '') {
    errors.push({
      field: 'identifier',
      message: 'Identifier is required',
    })
  }

  if (!payload.name || payload.name.trim() === '') {
    errors.push({
      field: 'name',
      message: 'Name is required',
    })
  }

  if (!payload.host || payload.host.trim() === '') {
    errors.push({
      field: 'host',
      message: 'Host is required',
    })
  }

  if (!payload.auth_method) {
    errors.push({
      field: 'auth_method',
      message: 'Auth method is required',
    })
  } else if (!validateAuthMethod(payload.auth_method)) {
    errors.push({
      field: 'auth_method',
      message: `Auth method must be one of: ${VALID_AUTH_METHODS.join(', ')}`,
    })
  }

  if (!payload.credential || payload.credential.trim() === '') {
    errors.push({
      field: 'credential',
      message: 'Credential is required',
    })
  }

  // Port validation
  if (payload.port !== undefined) {
    if (payload.port < 1 || payload.port > 65535) {
      errors.push({
        field: 'port',
        message: 'Port must be between 1 and 65535',
      })
    }
  }

  // Weight validation
  if (payload.weight !== undefined) {
    if (payload.weight < 0) {
      errors.push({
        field: 'weight',
        message: 'Weight must be a non-negative number',
      })
    }
  }

  // Max databases validation
  if (payload.max_databases !== undefined) {
    if (payload.max_databases < 1) {
      errors.push({
        field: 'max_databases',
        message: 'Max databases must be at least 1',
      })
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Validates cluster update payload
 * Validates: Requirements 2.3, 8.1
 */
export function validateClusterUpdate(
  payload: ClusterUpdatePayload,
  currentCluster?: Cluster
): ClusterValidationResult {
  const errors: ClusterValidationError[] = []

  // Identifier is required for updates
  if (!payload.identifier || payload.identifier.trim() === '') {
    errors.push({
      field: 'identifier',
      message: 'Identifier is required',
    })
  }

  // Status validation
  if (payload.status !== undefined && !validateStatus(payload.status)) {
    errors.push({
      field: 'status',
      message: `Status must be one of: ${VALID_STATUSES.join(', ')}`,
    })
  }

  // Weight validation
  if (payload.weight !== undefined && payload.weight < 0) {
    errors.push({
      field: 'weight',
      message: 'Weight must be a non-negative number',
    })
  }

  // Max databases validation
  // Property 20: Capacity Increase Validation
  // Validates: Requirements 8.1, 8.2, 8.3
  if (payload.max_databases !== undefined) {
    if (payload.max_databases < 1) {
      errors.push({
        field: 'max_databases',
        message: 'Max databases must be at least 1',
      })
    }

    if (currentCluster && payload.max_databases <= currentCluster.current_databases) {
      errors.push({
        field: 'max_databases',
        message: `Max databases (${payload.max_databases}) must be greater than current databases (${currentCluster.current_databases})`,
      })
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Validates cluster deletion
 * Property 15: Deletion Validation
 * Validates: Requirements 6.1, 6.2, 6.3
 */
export function validateClusterDelete(cluster: Cluster): ClusterValidationResult {
  const errors: ClusterValidationError[] = []

  if (cluster.current_databases > 0) {
    errors.push({
      field: 'current_databases',
      message: `Cannot delete cluster with active databases. Current databases: ${cluster.current_databases}`,
    })
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Calculates cluster utilization percentage
 * Property 23: Utilization Calculation
 * Validates: Requirements 9.3, 11.2
 */
export function calculateUtilization(currentDatabases: number, maxDatabases: number): number {
  if (maxDatabases === 0) return 0
  return (currentDatabases / maxDatabases) * 100
}

/**
 * Calculates cluster metrics from cluster data
 */
export function calculateClusterMetrics(cluster: Cluster) {
  return {
    identifier: cluster.identifier,
    max_databases: cluster.max_databases,
    current_databases: cluster.current_databases,
    utilization_percentage: calculateUtilization(cluster.current_databases, cluster.max_databases),
    available_capacity: cluster.max_databases - cluster.current_databases,
  }
}
