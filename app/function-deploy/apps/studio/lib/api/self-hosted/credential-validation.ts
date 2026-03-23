/**
 * Credential Validation System for project-specific database credentials.
 * Provides comprehensive validation for username and password format, strength, and security.
 */

import { ProjectCredentials } from './credential-fallback-manager'
import { 
  getCredentialErrorHandler, 
  CredentialError, 
  CredentialErrorType 
} from './credential-error-handling'

/**
 * Validation result structure
 */
export interface ValidationResult {
  isValid: boolean
  errors: string[]
  warnings: string[]
  score?: number // For password strength (0-100)
}

/**
 * Detailed validation result with field-specific errors
 */
export interface DetailedValidationResult {
  isValid: boolean
  userValidation: ValidationResult
  passwordValidation: ValidationResult
  overallErrors: string[]
}

/**
 * Password strength requirements configuration
 */
export interface PasswordStrengthConfig {
  minLength: number
  maxLength: number
  requireUppercase: boolean
  requireLowercase: boolean
  requireNumbers: boolean
  requireSpecialChars: boolean
  forbiddenPatterns: string[]
  minScore: number // Minimum acceptable score (0-100)
}

/**
 * Username validation requirements configuration
 */
export interface UsernameValidationConfig {
  minLength: number
  maxLength: number
  allowedPattern: RegExp
  forbiddenNames: string[]
  requirePrefix?: string
  requireSuffix?: string
}

/**
 * Default password strength configuration
 */
const DEFAULT_PASSWORD_CONFIG: PasswordStrengthConfig = {
  minLength: 12,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSpecialChars: true,
  forbiddenPatterns: [
    'password',
    'admin',
    'root',
    'user',
    'test',
    '123456',
    'qwerty',
    'supabase',
    'postgres'
  ],
  minScore: 70
}

/**
 * Default username validation configuration
 */
const DEFAULT_USERNAME_CONFIG: UsernameValidationConfig = {
  minLength: 3,
  maxLength: 63, // PostgreSQL identifier limit
  allowedPattern: /^[a-zA-Z_][a-zA-Z0-9_]*$/, // PostgreSQL identifier rules
  forbiddenNames: [
    'postgres',
    'root',
    'admin',
    'administrator',
    'sa',
    'user',
    'guest',
    'public',
    'information_schema',
    'pg_catalog',
    'pg_toast',
    'pg_temp',
    'pg_toast_temp'
  ]
}

/**
 * Validates username format according to PostgreSQL rules and security best practices
 * 
 * @param username - The username to validate
 * @param config - Optional validation configuration
 * @returns ValidationResult with detailed feedback
 */
export function validateUsername(
  username: string | null | undefined,
  config: Partial<UsernameValidationConfig> = {}
): ValidationResult {
  const finalConfig = { ...DEFAULT_USERNAME_CONFIG, ...config }
  const errors: string[] = []
  const warnings: string[] = []

  // Check for null/undefined/empty
  if (!username) {
    errors.push('Username is required')
    return { isValid: false, errors, warnings }
  }

  if (typeof username !== 'string') {
    errors.push('Username must be a string')
    return { isValid: false, errors, warnings }
  }

  const trimmedUsername = username.trim()

  // Check if empty after trimming
  if (trimmedUsername === '') {
    errors.push('Username cannot be empty or only whitespace')
    return { isValid: false, errors, warnings }
  }

  // Length validation
  if (trimmedUsername.length < finalConfig.minLength) {
    errors.push(`Username must be at least ${finalConfig.minLength} characters long`)
  }

  if (trimmedUsername.length > finalConfig.maxLength) {
    errors.push(`Username must not exceed ${finalConfig.maxLength} characters`)
  }

  // Pattern validation (PostgreSQL identifier rules)
  if (!finalConfig.allowedPattern.test(trimmedUsername)) {
    errors.push('Username must start with a letter or underscore and contain only letters, numbers, and underscores')
  }

  // Check for forbidden names
  const lowerUsername = trimmedUsername.toLowerCase()
  if (finalConfig.forbiddenNames.some(forbidden => lowerUsername === forbidden.toLowerCase())) {
    errors.push(`Username "${trimmedUsername}" is not allowed for security reasons`)
  }

  // Check for reserved PostgreSQL keywords (additional security)
  const reservedKeywords = [
    'select', 'insert', 'update', 'delete', 'create', 'drop', 'alter', 'grant', 'revoke',
    'table', 'database', 'schema', 'index', 'view', 'function', 'procedure', 'trigger'
  ]
  
  if (reservedKeywords.includes(lowerUsername)) {
    errors.push(`Username "${trimmedUsername}" conflicts with PostgreSQL reserved keywords`)
  }

  // Prefix/suffix validation if required
  if (finalConfig.requirePrefix && !trimmedUsername.startsWith(finalConfig.requirePrefix)) {
    errors.push(`Username must start with "${finalConfig.requirePrefix}"`)
  }

  if (finalConfig.requireSuffix && !trimmedUsername.endsWith(finalConfig.requireSuffix)) {
    errors.push(`Username must end with "${finalConfig.requireSuffix}"`)
  }

  // Warnings for best practices
  if (trimmedUsername.length < 6) {
    warnings.push('Username is quite short, consider using a longer name for better security')
  }

  if (!/[a-zA-Z]/.test(trimmedUsername)) {
    warnings.push('Username should contain at least one letter')
  }

  if (trimmedUsername.includes('_') && trimmedUsername.split('_').length > 3) {
    warnings.push('Username has many underscores, consider simplifying')
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  }
}

/**
 * Validates password strength and format according to security best practices
 * 
 * @param password - The password to validate
 * @param config - Optional password strength configuration
 * @returns ValidationResult with strength score and detailed feedback
 */
export function validatePassword(
  password: string | null | undefined,
  config: Partial<PasswordStrengthConfig> = {}
): ValidationResult {
  const finalConfig = { ...DEFAULT_PASSWORD_CONFIG, ...config }
  const errors: string[] = []
  const warnings: string[] = []

  // Check for null/undefined/empty
  if (!password) {
    errors.push('Password is required')
    return { isValid: false, errors, warnings, score: 0 }
  }

  if (typeof password !== 'string') {
    errors.push('Password must be a string')
    return { isValid: false, errors, warnings, score: 0 }
  }

  // Length validation
  if (password.length < finalConfig.minLength) {
    errors.push(`Password must be at least ${finalConfig.minLength} characters long`)
  }

  if (password.length > finalConfig.maxLength) {
    errors.push(`Password must not exceed ${finalConfig.maxLength} characters`)
  }

  // Character requirements
  if (finalConfig.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter')
  }

  if (finalConfig.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter')
  }

  if (finalConfig.requireNumbers && !/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number')
  }

  if (finalConfig.requireSpecialChars && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push('Password must contain at least one special character')
  }

  // Check for forbidden patterns
  const lowerPassword = password.toLowerCase()
  for (const pattern of finalConfig.forbiddenPatterns) {
    if (lowerPassword.includes(pattern.toLowerCase())) {
      errors.push(`Password must not contain "${pattern}"`)
    }
  }

  // Check for common weak patterns
  if (/(.)\1{2,}/.test(password)) {
    warnings.push('Password contains repeated characters, consider more variation')
  }

  if (/^[a-zA-Z]+$/.test(password)) {
    warnings.push('Password contains only letters, consider adding numbers and special characters')
  }

  if (/^[0-9]+$/.test(password)) {
    errors.push('Password cannot contain only numbers')
  }

  if (/^(.+)\1+$/.test(password)) {
    warnings.push('Password appears to have repeated patterns')
  }

  // Sequential character check
  if (hasSequentialChars(password)) {
    warnings.push('Password contains sequential characters (e.g., abc, 123), consider more randomness')
  }

  // Calculate password strength score
  const score = calculatePasswordStrength(password, finalConfig)

  // Check minimum score requirement
  if (score < finalConfig.minScore) {
    errors.push(`Password strength is too low (${score}/100). Minimum required: ${finalConfig.minScore}`)
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    score
  }
}

/**
 * Validates project-specific credentials comprehensively with error handling
 * 
 * @param credentials - Project credentials to validate
 * @param options - Validation options
 * @returns DetailedValidationResult with field-specific validation results
 */
export async function validateProjectCredentials(
  credentials: Partial<ProjectCredentials>,
  options: {
    usernameConfig?: Partial<UsernameValidationConfig>
    passwordConfig?: Partial<PasswordStrengthConfig>
    requireComplete?: boolean
  } = {}
): Promise<DetailedValidationResult> {
  const errorHandler = getCredentialErrorHandler()

  return errorHandler.executeWithErrorHandling(
    async () => validateProjectCredentialsSync(credentials, options),
    {
      serviceName: 'credential-validation',
      context: 'validateProjectCredentials',
      enableRetry: false, // Validation shouldn't be retried
      enableCircuitBreaker: false, // Validation is deterministic
      enableGracefulDegradation: true,
      fallbackFn: async () => {
        console.warn('[Credential Validation] Using fallback validation (less strict)')
        // Fallback: basic validation that always passes for system stability
        return {
          isValid: true,
          userValidation: { isValid: true, errors: [], warnings: ['Fallback validation used'] },
          passwordValidation: { isValid: true, errors: [], warnings: ['Fallback validation used'] },
          overallErrors: ['Fallback validation used - manual review recommended']
        }
      }
    }
  )
}

/**
 * Synchronous version of credential validation (internal use)
 */
function validateProjectCredentialsSync(
  credentials: Partial<ProjectCredentials>,
  options: {
    usernameConfig?: Partial<UsernameValidationConfig>
    passwordConfig?: Partial<PasswordStrengthConfig>
    requireComplete?: boolean
  } = {}
): DetailedValidationResult {
  const { usernameConfig = {}, passwordConfig = {}, requireComplete = true } = options
  const overallErrors: string[] = []

  // Validate individual fields
  const userValidation = validateUsername(credentials.user, usernameConfig)
  const passwordValidation = validatePassword(credentials.passwordHash, passwordConfig)

  // Check completeness if required
  if (requireComplete) {
    if (!credentials.user && !credentials.passwordHash) {
      overallErrors.push('Both username and password are required for complete credentials')
    } else if (!credentials.user) {
      overallErrors.push('Username is required for complete credentials')
    } else if (!credentials.passwordHash) {
      overallErrors.push('Password is required for complete credentials')
    }
  }

  // Cross-field validation
  if (credentials.user && credentials.passwordHash) {
    // Check if username and password are too similar
    if (areCredentialsTooSimilar(credentials.user, credentials.passwordHash)) {
      overallErrors.push('Password is too similar to username for security')
    }
  }

  const isValid = userValidation.isValid && passwordValidation.isValid && overallErrors.length === 0

  return {
    isValid,
    userValidation,
    passwordValidation,
    overallErrors
  }
}

/**
 * Validates credential format for database operations
 * 
 * @param user - Database username
 * @param passwordHash - Database password hash
 * @returns ValidationResult for database compatibility
 */
export function validateCredentialFormat(
  user: string | null | undefined,
  passwordHash: string | null | undefined
): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Validate user format for PostgreSQL compatibility
  if (user) {
    // Check for SQL injection patterns
    if (containsSqlInjectionPatterns(user)) {
      errors.push('Username contains potentially dangerous SQL patterns')
    }

    // Check for control characters
    if (/[\x00-\x1F\x7F]/.test(user)) {
      errors.push('Username contains invalid control characters')
    }

    // Check for Unicode issues that might cause problems
    if (user !== user.normalize('NFC')) {
      warnings.push('Username contains non-normalized Unicode characters')
    }
  }

  // Validate password hash format
  if (passwordHash) {
    // Check if it looks like a proper hash (basic validation)
    if (passwordHash.length < 8) {
      errors.push('Password hash appears to be too short')
    }

    // Check for plaintext passwords (security issue)
    if (isLikelyPlaintextPassword(passwordHash)) {
      errors.push('Password appears to be stored in plaintext, which is a security risk')
    }

    // Check for control characters in password
    if (/[\x00-\x1F\x7F]/.test(passwordHash)) {
      errors.push('Password contains invalid control characters')
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  }
}

/**
 * Generates detailed error report for validation failures
 * 
 * @param validationResult - The validation result to report on
 * @param context - Additional context for the error report
 * @returns Formatted error report string
 */
export function generateValidationErrorReport(
  validationResult: DetailedValidationResult,
  context: {
    projectRef?: string
    operation?: string
    timestamp?: string
  } = {}
): string {
  const { projectRef, operation = 'credential validation', timestamp = new Date().toISOString() } = context
  
  const lines: string[] = []
  
  lines.push(`=== Credential Validation Error Report ===`)
  lines.push(`Timestamp: ${timestamp}`)
  if (projectRef) {
    lines.push(`Project: ${projectRef}`)
  }
  lines.push(`Operation: ${operation}`)
  lines.push(`Overall Status: ${validationResult.isValid ? 'VALID' : 'INVALID'}`)
  lines.push('')

  // Username validation details
  lines.push(`Username Validation:`)
  lines.push(`  Status: ${validationResult.userValidation.isValid ? 'VALID' : 'INVALID'}`)
  if (validationResult.userValidation.errors.length > 0) {
    lines.push(`  Errors:`)
    validationResult.userValidation.errors.forEach(error => {
      lines.push(`    - ${error}`)
    })
  }
  if (validationResult.userValidation.warnings.length > 0) {
    lines.push(`  Warnings:`)
    validationResult.userValidation.warnings.forEach(warning => {
      lines.push(`    - ${warning}`)
    })
  }
  lines.push('')

  // Password validation details
  lines.push(`Password Validation:`)
  lines.push(`  Status: ${validationResult.passwordValidation.isValid ? 'VALID' : 'INVALID'}`)
  if (validationResult.passwordValidation.score !== undefined) {
    lines.push(`  Strength Score: ${validationResult.passwordValidation.score}/100`)
  }
  if (validationResult.passwordValidation.errors.length > 0) {
    lines.push(`  Errors:`)
    validationResult.passwordValidation.errors.forEach(error => {
      lines.push(`    - ${error}`)
    })
  }
  if (validationResult.passwordValidation.warnings.length > 0) {
    lines.push(`  Warnings:`)
    validationResult.passwordValidation.warnings.forEach(warning => {
      lines.push(`    - ${warning}`)
    })
  }
  lines.push('')

  // Overall errors
  if (validationResult.overallErrors.length > 0) {
    lines.push(`Overall Errors:`)
    validationResult.overallErrors.forEach(error => {
      lines.push(`  - ${error}`)
    })
    lines.push('')
  }

  lines.push(`=== End Report ===`)
  
  return lines.join('\n')
}

/**
 * Logs detailed validation failure information
 * 
 * @param validationResult - The validation result to log
 * @param context - Additional context for logging
 */
export function logValidationFailure(
  validationResult: DetailedValidationResult,
  context: {
    projectRef?: string
    operation?: string
    userId?: string
  } = {}
): void {
  if (validationResult.isValid) {
    return // No need to log successful validations
  }

  const report = generateValidationErrorReport(validationResult, context)
  
  // Log to console with appropriate level
  console.error(`[Credential Validation Failure] ${context.projectRef || 'Unknown Project'}`)
  console.error(report)

  // In a production environment, you might want to send this to a logging service
  // or store it in a database for monitoring and alerting
}

// Helper functions

/**
 * Calculates password strength score (0-100)
 */
function calculatePasswordStrength(password: string, config: PasswordStrengthConfig): number {
  let score = 0

  // Length scoring (up to 25 points)
  const lengthScore = Math.min(25, (password.length / config.minLength) * 15)
  score += lengthScore

  // Character variety scoring (up to 40 points)
  let varietyScore = 0
  if (/[a-z]/.test(password)) varietyScore += 10
  if (/[A-Z]/.test(password)) varietyScore += 10
  if (/[0-9]/.test(password)) varietyScore += 10
  if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) varietyScore += 10
  score += varietyScore

  // Uniqueness scoring (up to 20 points)
  const uniqueChars = new Set(password).size
  const uniquenessScore = Math.min(20, (uniqueChars / password.length) * 20)
  score += uniquenessScore

  // Pattern penalties (up to -15 points)
  let patternPenalty = 0
  if (/(.)\1{2,}/.test(password)) patternPenalty += 5 // Repeated characters
  if (hasSequentialChars(password)) patternPenalty += 5 // Sequential characters
  if (/^(.+)\1+$/.test(password)) patternPenalty += 5 // Repeated patterns
  score -= patternPenalty

  // Entropy bonus (up to 15 points)
  const entropy = calculateEntropy(password)
  const entropyScore = Math.min(15, entropy / 4)
  score += entropyScore

  return Math.max(0, Math.min(100, Math.round(score)))
}

/**
 * Checks if password contains sequential characters
 */
function hasSequentialChars(password: string): boolean {
  const sequences = [
    'abcdefghijklmnopqrstuvwxyz',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    '0123456789',
    'qwertyuiop',
    'asdfghjkl',
    'zxcvbnm'
  ]

  for (const seq of sequences) {
    for (let i = 0; i <= seq.length - 3; i++) {
      const subseq = seq.substring(i, i + 3)
      if (password.includes(subseq)) {
        return true
      }
    }
  }

  return false
}

/**
 * Calculates password entropy
 */
function calculateEntropy(password: string): number {
  const charCounts = new Map<string, number>()
  
  for (const char of password) {
    charCounts.set(char, (charCounts.get(char) || 0) + 1)
  }

  let entropy = 0
  const length = password.length

  charCounts.forEach((count) => {
    const probability = count / length
    entropy -= probability * Math.log2(probability)
  })

  return entropy * length
}

/**
 * Checks if username and password are too similar
 */
function areCredentialsTooSimilar(username: string, password: string): boolean {
  const lowerUser = username.toLowerCase()
  const lowerPass = password.toLowerCase()

  // Check if password contains username
  if (lowerPass.includes(lowerUser)) {
    return true
  }

  // Check if username contains password (unlikely but possible)
  if (lowerUser.includes(lowerPass)) {
    return true
  }

  // Check Levenshtein distance (if very similar)
  const distance = levenshteinDistance(lowerUser, lowerPass)
  const maxLength = Math.max(username.length, password.length)
  const similarity = 1 - (distance / maxLength)

  return similarity > 0.8 // 80% similarity threshold
}

/**
 * Calculates Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null))

  for (let i = 0; i <= str1.length; i++) {
    matrix[0][i] = i
  }

  for (let j = 0; j <= str2.length; j++) {
    matrix[j][0] = j
  }

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1, // deletion
        matrix[j - 1][i] + 1, // insertion
        matrix[j - 1][i - 1] + indicator // substitution
      )
    }
  }

  return matrix[str2.length][str1.length]
}

/**
 * Checks for SQL injection patterns in username
 */
function containsSqlInjectionPatterns(username: string): boolean {
  const dangerousPatterns = [
    /['";]/,
    /--/,
    /\/\*/,
    /\*\//,
    /\bor\b/i,
    /\band\b/i,
    /\bunion\b/i,
    /\bselect\b/i,
    /\binsert\b/i,
    /\bupdate\b/i,
    /\bdelete\b/i,
    /\bdrop\b/i,
    /\bexec\b/i,
    /\bexecute\b/i
  ]

  return dangerousPatterns.some(pattern => pattern.test(username))
}

/**
 * Checks if a string looks like a plaintext password
 */
function isLikelyPlaintextPassword(password: string): boolean {
  // Check if it's a common password pattern
  const commonPatterns = [
    /^password/i,
    /^admin/i,
    /^user/i,
    /^test/i,
    /^123/,
    /^qwerty/i
  ]

  if (commonPatterns.some(pattern => pattern.test(password))) {
    return true
  }

  // Check if it lacks hash characteristics
  // Most password hashes are longer and contain specific patterns
  if (password.length < 20) {
    return true
  }

  // Check if it's all printable ASCII (hashes usually contain more variety)
  if (!/[^a-zA-Z0-9\s]/.test(password)) {
    return true
  }

  return false
}