/**
 * Database naming utilities for PostgreSQL database name validation and generation.
 * Implements naming rules according to PostgreSQL standards and project requirements.
 */

/**
 * PostgreSQL database naming rules
 */
export const DATABASE_NAMING_RULES = {
  // Maximum length for PostgreSQL identifiers
  maxLength: 63,

  // Pattern: must start with lowercase letter, contain only lowercase letters, numbers, and underscores
  pattern: /^[a-z][a-z0-9_]*$/,

  // Reserved database names that cannot be used
  reserved: [
    'postgres',
    'template0',
    'template1',
    'supabase',
    'auth',
    'storage',
    'realtime',
  ],
} as const

/**
 * Error thrown when database name validation fails
 */
export class DatabaseNamingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseNamingError'
  }
}

/**
 * Validates a database name according to PostgreSQL naming rules
 *
 * @param name - The database name to validate
 * @throws {DatabaseNamingError} If the name is invalid
 */
export function validateDatabaseName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new DatabaseNamingError('Database name cannot be empty')
  }

  if (name.length > DATABASE_NAMING_RULES.maxLength) {
    throw new DatabaseNamingError(
      `Database name cannot exceed ${DATABASE_NAMING_RULES.maxLength} characters`
    )
  }

  if (!DATABASE_NAMING_RULES.pattern.test(name)) {
    throw new DatabaseNamingError(
      'Database name must start with a lowercase letter and contain only lowercase letters, numbers, and underscores'
    )
  }

  if (DATABASE_NAMING_RULES.reserved.includes(name.toLowerCase() as any)) {
    throw new DatabaseNamingError(`Database name "${name}" is reserved and cannot be used`)
  }
}

/**
 * Checks if a database name is valid without throwing an error
 *
 * @param name - The database name to check
 * @returns true if the name is valid, false otherwise
 */
export function isValidDatabaseName(name: string): boolean {
  try {
    validateDatabaseName(name)
    return true
  } catch {
    return false
  }
}

/**
 * Sanitizes a string to create a valid database name
 *
 * @param input - The input string to sanitize
 * @returns A sanitized database name
 */
export function sanitizeDatabaseName(input: string): string {
  let result = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // Replace non-alphanumeric with underscore
    .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
    .replace(/_+/g, '_') // Replace multiple underscores with single

  // Prefix with 'db_' if starts with number
  if (/^[0-9]/.test(result)) {
    result = 'db_' + result
  }

  return result
}

/**
 * Generates a unique database name based on a project name
 * Uses format: db_projectname_xxxx
 *
 * @param projectName - The project name to base the database name on
 * @returns A unique, valid database name
 */
export function generateDatabaseName(projectName: string): string {
  const sanitized = sanitizeDatabaseName(projectName)

  // Generate short random suffix for uniqueness (4 characters)
  const randomSuffix = Math.random().toString(36).substring(2, 6)
  
  // Calculate available space for project name
  // Format: db_projectname_xxxx
  // Total length limit: 63 characters
  // Used: 'db_' (3) + '_' (1) + random (4) = 8 characters
  const maxProjectNameLength = DATABASE_NAMING_RULES.maxLength - 8
  
  // Truncate project name if necessary
  const truncatedProjectName = sanitized.length > maxProjectNameLength 
    ? sanitized.substring(0, maxProjectNameLength)
    : sanitized
  
  // Create database name with new format
  const name = truncatedProjectName ? `db_${truncatedProjectName}_${randomSuffix}` : `db_proj_${randomSuffix}`

  return name
}

/**
 * Enhanced database name generation with collision detection
 * This is a wrapper around the enhanced credential generation service
 * 
 * @param projectName - The project name to base the database name on
 * @param existingNames - Optional array of existing names to avoid
 * @returns Promise resolving to unique database name
 */
export async function generateDatabaseNameWithCollisionDetection(
  projectName: string,
  existingNames?: string[]
): Promise<string> {
  const { generateDatabaseNameWithCollisionDetection } = await import('./enhanced-credential-generation')
  return generateDatabaseNameWithCollisionDetection(projectName, existingNames)
}
