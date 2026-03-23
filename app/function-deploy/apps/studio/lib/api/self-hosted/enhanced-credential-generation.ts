/**
 * Enhanced credential generation service with collision detection and retry logic.
 * Implements cryptographically secure random string generation and uniqueness checking.
 */

import { randomBytes } from 'crypto'
import { generateDatabaseName, validateDatabaseName } from './database-naming'
import { generateUsername, validateUsername, userExists } from './database-user-manager'
import { databaseExists } from './database-manager'
import { WrappedResult } from './types'

/**
 * Configuration for credential generation
 */
export interface CredentialGenerationConfig {
  maxRetries: number
  randomStringLength: number
  useTimestamp: boolean
  conflictCheckEnabled: boolean
}

/**
 * Default configuration for credential generation
 */
export const DEFAULT_CREDENTIAL_CONFIG: CredentialGenerationConfig = {
  maxRetries: 5,
  randomStringLength: 4, // Shorter random strings for new naming format
  useTimestamp: false, // No timestamp needed with new format
  conflictCheckEnabled: true,
}

/**
 * Result of credential generation attempt
 */
export interface GenerationResult {
  name: string
  attempts: number
  isUnique: boolean
}

/**
 * Error codes for credential generation
 */
export enum CredentialGenerationErrorCode {
  RETRY_EXHAUSTED = 'RETRY_EXHAUSTED',
  INVALID_PROJECT_NAME = 'INVALID_PROJECT_NAME',
  GENERATION_FAILED = 'GENERATION_FAILED',
  UNIQUENESS_CHECK_FAILED = 'UNIQUENESS_CHECK_FAILED',
}

/**
 * Custom error class for credential generation operations
 */
export class CredentialGenerationError extends Error {
  constructor(
    public code: CredentialGenerationErrorCode,
    message: string,
    public details?: any
  ) {
    super(message)
    this.name = 'CredentialGenerationError'
  }
}

/**
 * Enhanced credential generation service interface
 */
export interface CredentialGenerationService {
  generateDatabaseName(projectName: string, existingNames?: string[]): Promise<string>
  generateUsername(projectName: string, existingUsernames?: string[]): Promise<string>
  validateUniqueness(name: string, type: 'database' | 'username'): Promise<boolean>
  generateSecureRandomString(length: number): string
}

/**
 * Generates a cryptographically secure random string
 * 
 * @param length - Length of the random string to generate
 * @returns Cryptographically secure random string using lowercase letters and numbers
 */
export function generateSecureRandomString(length: number): string {
  if (length <= 0) {
    throw new Error('Length must be positive')
  }

  // Use crypto.randomBytes for cryptographically secure randomness
  const bytes = randomBytes(Math.ceil(length * 0.75)) // Need more bytes than final length due to base36 encoding
  
  // Convert to base36 (0-9, a-z) and take only the required length
  const randomString = bytes.toString('hex').slice(0, length)
  
  // Ensure we have exactly the requested length by padding with secure random if needed
  if (randomString.length < length) {
    const additionalBytes = randomBytes(length - randomString.length)
    return randomString + additionalBytes.toString('hex').slice(0, length - randomString.length)
  }
  
  return randomString.slice(0, length)
}

/**
 * Sanitizes a project name for use in credential generation
 * 
 * @param projectName - The project name to sanitize
 * @returns Sanitized project name suitable for credential generation
 */
function sanitizeProjectName(projectName: string): string {
  if (!projectName || typeof projectName !== 'string') {
    throw new CredentialGenerationError(
      CredentialGenerationErrorCode.INVALID_PROJECT_NAME,
      'Project name is required and must be a string'
    )
  }

  let sanitized = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // Replace non-alphanumeric with underscore
    .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
    .replace(/_+/g, '_') // Replace multiple underscores with single

  // Ensure it doesn't start with a number
  if (/^[0-9]/.test(sanitized)) {
    sanitized = 'proj_' + sanitized
  }

  // If sanitization resulted in empty string, use default
  if (!sanitized) {
    sanitized = 'proj'
  }

  return sanitized
}

/**
 * Validates uniqueness of a credential name
 * 
 * @param name - The name to check for uniqueness
 * @param type - Type of credential ('database' or 'username')
 * @returns Promise resolving to true if unique, false if conflict exists
 */
export async function validateUniqueness(
  name: string,
  type: 'database' | 'username'
): Promise<boolean> {
  try {
    if (type === 'database') {
      const existsResult = await databaseExists(name)
      if (existsResult.error) {
        throw new CredentialGenerationError(
          CredentialGenerationErrorCode.UNIQUENESS_CHECK_FAILED,
          `Failed to check database uniqueness: ${existsResult.error.message}`,
          { name, type }
        )
      }
      return !existsResult.data
    } else if (type === 'username') {
      const existsResult = await userExists(name)
      if (existsResult.error) {
        throw new CredentialGenerationError(
          CredentialGenerationErrorCode.UNIQUENESS_CHECK_FAILED,
          `Failed to check username uniqueness: ${existsResult.error.message}`,
          { name, type }
        )
      }
      return !existsResult.data
    }
    
    return false
  } catch (error) {
    if (error instanceof CredentialGenerationError) {
      throw error
    }
    throw new CredentialGenerationError(
      CredentialGenerationErrorCode.UNIQUENESS_CHECK_FAILED,
      `Unexpected error during uniqueness check: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { name, type }
    )
  }
}

/**
 * Enhanced database name generation with collision detection and retry logic
 * Uses format: db_projectname_xxxx
 * 
 * @param projectName - The project name to base the database name on
 * @param existingNames - Optional array of existing names to avoid (for additional conflict checking)
 * @param config - Configuration options for generation
 * @returns Promise resolving to unique database name
 */
export async function generateDatabaseNameWithCollisionDetection(
  projectName: string,
  existingNames: string[] = [],
  config: CredentialGenerationConfig = DEFAULT_CREDENTIAL_CONFIG
): Promise<string> {
  const sanitizedProjectName = sanitizeProjectName(projectName)
  let attempts = 0

  while (attempts < config.maxRetries) {
    attempts++

    try {
      // Generate short random component (4-6 characters)
      const randomComponent = generateSecureRandomString(4)
      
      // Calculate available space for project name
      // Format: db_projectname_xxxx
      // Total length limit: 63 characters
      // Used: 'db_' (3) + '_' (1) + random (4) = 8 characters
      const maxProjectNameLength = 63 - 8
      
      // Truncate project name if necessary
      const truncatedProjectName = sanitizedProjectName.length > maxProjectNameLength 
        ? sanitizedProjectName.substring(0, maxProjectNameLength)
        : sanitizedProjectName
      
      // Create database name with new format: db_projectname_xxxx
      const candidateName = `db_${truncatedProjectName}_${randomComponent}`
      
      // Ensure the name meets PostgreSQL naming requirements
      validateDatabaseName(candidateName)
      
      // Check against provided existing names
      if (existingNames.includes(candidateName)) {
        console.log(`Database name collision with provided list on attempt ${attempts}: ${candidateName}`)
        continue
      }
      
      // Check uniqueness in the database if conflict checking is enabled
      if (config.conflictCheckEnabled) {
        const isUnique = await validateUniqueness(candidateName, 'database')
        if (!isUnique) {
          console.log(`Database name collision detected on attempt ${attempts}: ${candidateName}`)
          continue
        }
      }
      
      console.log(`Generated unique database name on attempt ${attempts}: ${candidateName}`)
      return candidateName
      
    } catch (error) {
      console.error(`Database name generation attempt ${attempts} failed:`, error)
      
      // If this is a validation error and we're on the last attempt, throw it
      if (attempts >= config.maxRetries) {
        if (error instanceof Error && error.message.includes('Database name')) {
          throw new CredentialGenerationError(
            CredentialGenerationErrorCode.GENERATION_FAILED,
            `Failed to generate valid database name after ${attempts} attempts: ${error.message}`,
            { projectName, attempts }
          )
        }
      }
      
      // Continue to next attempt for other errors
    }
  }

  // If we've exhausted all retries
  throw new CredentialGenerationError(
    CredentialGenerationErrorCode.RETRY_EXHAUSTED,
    `Failed to generate unique database name after ${config.maxRetries} attempts`,
    { projectName, attempts: config.maxRetries }
  )
}

/**
 * Enhanced username generation with collision detection and retry logic
 * Uses format: user_projectname_xxxx
 * 
 * @param projectName - The project name to base the username on
 * @param existingUsernames - Optional array of existing usernames to avoid (for additional conflict checking)
 * @param config - Configuration options for generation
 * @returns Promise resolving to unique username
 */
export async function generateUsernameWithCollisionDetection(
  projectName: string,
  existingUsernames: string[] = [],
  config: CredentialGenerationConfig = DEFAULT_CREDENTIAL_CONFIG
): Promise<string> {
  const sanitizedProjectName = sanitizeProjectName(projectName)
  let attempts = 0

  while (attempts < config.maxRetries) {
    attempts++

    try {
      // Generate short random component (4-6 characters)
      const randomComponent = generateSecureRandomString(4)
      
      // Calculate available space for project name
      // Format: user_projectname_xxxx
      // Total length limit: 63 characters
      // Used: 'user_' (5) + '_' (1) + random (4) = 10 characters
      const maxProjectNameLength = 63 - 10
      
      // Truncate project name if necessary
      const truncatedProjectName = sanitizedProjectName.length > maxProjectNameLength 
        ? sanitizedProjectName.substring(0, maxProjectNameLength)
        : sanitizedProjectName
      
      // Create username with new format: user_projectname_xxxx
      const candidateUsername = `user_${truncatedProjectName}_${randomComponent}`
      
      // Ensure the username meets PostgreSQL naming requirements
      validateUsername(candidateUsername)
      
      // Check against provided existing usernames
      if (existingUsernames.includes(candidateUsername)) {
        console.log(`Username collision with provided list on attempt ${attempts}: ${candidateUsername}`)
        continue
      }
      
      // Check uniqueness in the database if conflict checking is enabled
      if (config.conflictCheckEnabled) {
        const isUnique = await validateUniqueness(candidateUsername, 'username')
        if (!isUnique) {
          console.log(`Username collision detected on attempt ${attempts}: ${candidateUsername}`)
          continue
        }
      }
      
      console.log(`Generated unique username on attempt ${attempts}: ${candidateUsername}`)
      return candidateUsername
      
    } catch (error) {
      console.error(`Username generation attempt ${attempts} failed:`, error)
      
      // If this is a validation error and we're on the last attempt, throw it
      if (attempts >= config.maxRetries) {
        if (error instanceof Error && error.message.includes('Username')) {
          throw new CredentialGenerationError(
            CredentialGenerationErrorCode.GENERATION_FAILED,
            `Failed to generate valid username after ${attempts} attempts: ${error.message}`,
            { projectName, attempts }
          )
        }
      }
      
      // Continue to next attempt for other errors
    }
  }

  // If we've exhausted all retries
  throw new CredentialGenerationError(
    CredentialGenerationErrorCode.RETRY_EXHAUSTED,
    `Failed to generate unique username after ${config.maxRetries} attempts`,
    { projectName, attempts: config.maxRetries }
  )
}

/**
 * Enhanced credential generation service implementation
 */
export class EnhancedCredentialGenerationService implements CredentialGenerationService {
  constructor(private config: CredentialGenerationConfig = DEFAULT_CREDENTIAL_CONFIG) {}

  /**
   * Generates a unique database name with collision detection
   */
  async generateDatabaseName(projectName: string, existingNames?: string[]): Promise<string> {
    return generateDatabaseNameWithCollisionDetection(projectName, existingNames, this.config)
  }

  /**
   * Generates a unique username with collision detection
   */
  async generateUsername(projectName: string, existingUsernames?: string[]): Promise<string> {
    return generateUsernameWithCollisionDetection(projectName, existingUsernames, this.config)
  }

  /**
   * Validates uniqueness of a credential name
   */
  async validateUniqueness(name: string, type: 'database' | 'username'): Promise<boolean> {
    return validateUniqueness(name, type)
  }

  /**
   * Generates a cryptographically secure random string
   */
  generateSecureRandomString(length: number): string {
    return generateSecureRandomString(length)
  }
}

/**
 * Default instance of the enhanced credential generation service
 */
export const enhancedCredentialGenerationService = new EnhancedCredentialGenerationService()

/**
 * Convenience function to get the enhanced credential generation service
 */
export function getEnhancedCredentialGenerationService(
  config?: CredentialGenerationConfig
): EnhancedCredentialGenerationService {
  if (config) {
    return new EnhancedCredentialGenerationService(config)
  }
  return enhancedCredentialGenerationService
}