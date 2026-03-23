/**
 * Database Cluster Management
 * 
 * This module provides credential management services for database clusters
 * with support for password-based and Secrets Manager authentication,
 * as well as allocation strategies for distributing projects across clusters.
 */

export * from './types'
export * from './credential-provider'
export * from './password-credential-provider'
export * from './secrets-manager-credential-provider'
export * from './allocation-strategy'
// Strategy implementations removed - use tenant-manager service instead
export * from './cluster-repository'
export * from './cluster-management-service'
export * from './auth-middleware'
export * from './authorization-middleware'
export * from './audit-logger'
export * from './cluster-api-wrapper'

