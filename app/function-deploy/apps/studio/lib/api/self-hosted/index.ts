/**
 * Self-hosted API utilities
 * 
 * This module provides utilities for managing self-hosted Supabase instances,
 * including database management, connection string generation, and naming utilities.
 */

// Database management
export {
  createDatabase,
  createDatabaseWithRetry,
  databaseExists,
  listDatabases,
  deleteDatabase,
  getTemplateDatabaseName,
  terminateConnections,
  terminateConnectionsAndWait,
  DatabaseError,
  DatabaseErrorCode,
  type CreateDatabaseOptions,
  type DatabaseInfo,
} from './database-manager'

// Database user management
export {
  createProjectUser,
  deleteProjectUser,
  validateUserCredentials,
  getUserPermissions,
  userExists,
  validateUsername,
  validatePassword,
  generateUsername,
  generateUsernameWithCollisionDetection,
  databaseUserManager,
  DatabaseUserError,
  DatabaseUserErrorCode,
  type CreateUserOptions,
  type UserPermissions,
  type DatabaseUserManager,
} from './database-user-manager'

// Database naming utilities
export {
  validateDatabaseName,
  isValidDatabaseName,
  sanitizeDatabaseName,
  generateDatabaseName,
  generateDatabaseNameWithCollisionDetection,
  DatabaseNamingError,
  DATABASE_NAMING_RULES,
} from './database-naming'

// Connection string utilities
export {
  generateConnectionString,
  generateConnectionStringWithFallback,
  generateDisplayConnectionString,
  generateDisplayConnectionStringWithFallback,
  parseConnectionString,
  parseConnectionStringWithFallback,
  generateProjectConnectionString,
  generateProjectConnectionStringWithVisibility,
  validateConnectionStringFormat,
  type ConnectionStringOptions,
  type EnhancedConnectionStringOptions,
  type ConnectionStringResult,
  type ParsedConnectionStringResult,
  type ProjectConnectionOptions,
} from './connection-string'

// Credential fallback management
export {
  CredentialFallbackManager,
  getCredentialFallbackManager,
  resetCredentialFallbackManager,
  type ProjectCredentials,
  type SystemCredentials,
  type FallbackUsageEntry,
} from './credential-fallback-manager'

export {
  CredentialMonitoringService,
  getCredentialMonitoringService,
  resetCredentialMonitoringService,
  type FallbackUsageStats,
  type ProjectCredentialStatus,
  type HealthCheckResult,
  type CredentialReport,
  type CredentialAuditLog,
} from './credential-monitoring-service'

export {
  CredentialMonitoringDatabase,
  createCredentialMonitoringDatabase,
} from './credential-monitoring-database'

// Credential validation
export {
  validateUsername as validateCredentialUsername,
  validatePassword as validateCredentialPassword,
  validateProjectCredentials,
  validateCredentialFormat,
  generateValidationErrorReport,
  logValidationFailure,
  type ValidationResult,
  type DetailedValidationResult,
  type PasswordStrengthConfig,
  type UsernameValidationConfig,
} from './credential-validation'

// Credential migration - server-side only
// These are exported as functions that return dynamic imports to avoid loading Node.js modules on client side
export const getCredentialMigrationManager = async () => {
  const module = await import('./credential-migration-manager')
  return module.getCredentialMigrationManager()
}

export const resetCredentialMigrationManager = async () => {
  const module = await import('./credential-migration-manager')
  return module.resetCredentialMigrationManager()
}

export const CredentialMigrationManager = async () => {
  const module = await import('./credential-migration-manager')
  return module.CredentialMigrationManager
}

// Re-export types only
export type { 
  MigrationResult,
  BatchMigrationResult,
  MigrationStats,
  CredentialGenerationOptions,
} from './credential-migration-manager'

// Enhanced credential generation - server-side only
export const getEnhancedCredentialGenerationService = async () => {
  const module = await import('./enhanced-credential-generation')
  return module.getEnhancedCredentialGenerationService()
}

export const generateSecureRandomString = async (...args: any[]) => {
  const module = await import('./enhanced-credential-generation')
  return module.generateSecureRandomString(...args)
}

export const validateUniqueness = async (...args: any[]) => {
  const module = await import('./enhanced-credential-generation')
  return module.validateUniqueness(...args)
}

// Re-export types and constants only
export type { 
  CredentialGenerationConfig,
  GenerationResult,
  CredentialGenerationService,
  CredentialGenerationErrorCode,
} from './enhanced-credential-generation'

export { 
  CredentialGenerationError,
  DEFAULT_CREDENTIAL_CONFIG,
} from './enhanced-credential-generation'

// Credential generation fallback strategies
export {
  generateCredentialWithFallbackSupport,
  generateCredentialWithFallback,
  DEFAULT_FALLBACK_CONFIG,
  FallbackStrategy,
  getFallbackStrategyDescription,
  type FallbackConfig,
  type FallbackResult,
} from './credential-generation-fallback'

// Credential generation error messages and user feedback
export {
  getCredentialGenerationErrorMessage,
  formatCredentialGenerationError,
  getRecoverySuggestions,
  isRetryableError,
  getRetryDelay,
  CREDENTIAL_GENERATION_ERROR_MESSAGES,
  CREDENTIAL_GENERATION_STATUS_MESSAGES,
  FALLBACK_STRATEGIES,
  type FormattedCredentialError,
} from './credential-generation-error-messages'

// Constants
export {
  getEncryptionKey,
  POSTGRES_PORT,
  POSTGRES_HOST,
  POSTGRES_DATABASE,
  POSTGRES_PASSWORD,
  POSTGRES_USER_READ_WRITE,
  POSTGRES_USER_READ_ONLY,
  TEMPLATE_DATABASE_NAME,
} from './constants'

// Utilities
export {
  assertSelfHosted,
  encryptString,
  getConnectionString,
} from './util'

// Query execution
export {
  executeQuery,
  type QueryOptions,
} from './query'

// Project store - automatically selects JSON or PostgreSQL based on environment
// Default: JSON file storage (for development/existing environments)
// Set USE_PG_PROJECT_STORE=true to use PostgreSQL storage (for new deployments)
export {
  save as saveProject,
  findAll as findAllProjects,
  findById as findProjectById,
  findByRef as findProjectByRef,
  findByDatabaseName as findProjectByDatabaseName,
  findByOrganizationId as findProjectsByOrganizationId,
  findByOwnerUserId as findProjectsByOwnerUserId,
  update as updateProject,
  deleteProject,
  ProjectStoreError,
  ProjectStoreErrorCode,
  type ProjectMetadata,
  type ProjectStatus,
} from './project-store-adapter'

// User isolation and security
export {
  verifyCrossProjectAccessDenial,
  verifyUserPermissions,
  logUserAccess,
  runIsolationVerification,
  generateIsolationVerificationScript,
  type CrossProjectAccessResult,
  type UserAccessAuditLog,
  type IsolationVerificationReport,
  type SecurityViolation,
} from './user-isolation-security'

// Types
export {
  type WrappedResult,
  type WrappedSuccessResult,
  type WrappedErrorResult,
  PgMetaDatabaseError,
} from './types'
