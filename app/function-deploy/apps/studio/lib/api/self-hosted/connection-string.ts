/**
 * Connection string generator for PostgreSQL databases.
 * Supports dynamic database names for multi-database project management.
 */

import {
  POSTGRES_HOST,
  POSTGRES_PASSWORD,
  POSTGRES_PORT,
  POSTGRES_USER_READ_ONLY,
  POSTGRES_USER_READ_WRITE,
} from './constants'
import { getEnvironmentConfigHandler } from '../../environment-config-handler'
import { getCredentialFallbackManager, type ProjectCredentials } from './credential-fallback-manager'
import { 
  getCredentialErrorHandler, 
  CredentialError, 
  CredentialErrorType 
} from './credential-error-handling'

export interface ConnectionStringOptions {
  /**
   * The name of the database to connect to
   */
  databaseName: string
  
  /**
   * Whether to use read-only credentials
   * @default false
   */
  readOnly?: boolean
  
  /**
   * Override the default host
   */
  host?: string
  
  /**
   * Override the default port
   */
  port?: number | string
  
  /**
   * Override the default user
   */
  user?: string
  
  /**
   * Override the default password
   */
  password?: string

  /**
   * Whether to use environment defaults when parameters are missing
   * @default true
   */
  useEnvironmentDefaults?: boolean

  /**
   * Whether to mask the password in the connection string for display purposes
   * When true, password will be replaced with '[YOUR_PASSWORD]'
   * @default false
   */
  maskPassword?: boolean
}

/**
 * Enhanced connection string options with fallback support
 */
export interface EnhancedConnectionStringOptions extends ConnectionStringOptions {
  /**
   * Project reference for credential resolution
   */
  projectRef?: string
  
  /**
   * Allow fallback to system credentials when project credentials are missing
   * @default true
   */
  allowFallback?: boolean
  
  /**
   * Log fallback usage for monitoring
   * @default true
   */
  logFallbackUsage?: boolean

  /**
   * Project-specific credentials (if available)
   */
  projectCredentials?: {
    user?: string | null
    passwordHash?: string | null
  }
}

/**
 * Result of connection string generation with fallback information
 */
export interface ConnectionStringResult {
  /**
   * The generated connection string
   */
  connectionString: string
  
  /**
   * Whether fallback credentials were used
   */
  usedFallback: boolean
  
  /**
   * Reason for using fallback credentials (if applicable)
   */
  fallbackReason?: string
  
  /**
   * Type of credentials that triggered fallback
   */
  fallbackType?: 'user' | 'password' | 'both'
}

/**
 * Enhanced connection string options for project-specific database users
 */
export interface ProjectConnectionOptions {
  /**
   * Project-specific database user
   */
  projectUser: string
  
  /**
   * Project-specific database password
   */
  projectPassword: string
  
  /**
   * Project-specific database name
   */
  projectDatabase: string
  
  /**
   * Override the default host
   */
  host?: string
  
  /**
   * Override the default port
   */
  port?: number | string
  
  /**
   * Whether to reveal the actual password in the connection string
   * When false, password will be masked with '[YOUR_PASSWORD]'
   * @default false
   */
  revealPassword?: boolean

  /**
   * Whether to use environment defaults when parameters are missing
   * @default true
   */
  useEnvironmentDefaults?: boolean
}

/**
 * Validates connection parameters
 */
function validateConnectionParameters(params: {
  host: string
  port: number | string
  user: string
  password: string
  databaseName: string
}): { isValid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!params.host || params.host.trim() === '') {
    errors.push('Host cannot be empty')
  }

  if (!params.port) {
    errors.push('Port cannot be empty')
  } else {
    const portNum = typeof params.port === 'string' ? parseInt(params.port, 10) : params.port
    if (isNaN(portNum) || portNum <= 0 || portNum > 65535) {
      errors.push('Port must be a valid number between 1 and 65535')
    }
  }

  if (!params.user || params.user.trim() === '') {
    errors.push('User cannot be empty')
  }

  if (!params.password || params.password.trim() === '') {
    errors.push('Password cannot be empty')
  }

  if (!params.databaseName || params.databaseName.trim() === '') {
    errors.push('Database name cannot be empty')
  }

  return {
    isValid: errors.length === 0,
    errors
  }
}

/**
 * Determines the appropriate username based on permission level and environment
 * 
 * @param readOnly - Whether to use read-only credentials
 * @param customUser - Custom user override
 * @param useEnvironmentDefaults - Whether to use environment defaults
 * @returns The appropriate username for the connection
 */
function determineUsername(readOnly: boolean, customUser?: string, useEnvironmentDefaults: boolean = true): string | undefined {
  // If a custom user is provided, use it directly
  if (customUser !== undefined) {
    return customUser
  }

  // If not using environment defaults, return undefined to indicate missing parameter
  if (!useEnvironmentDefaults) {
    return undefined
  }

  // Select appropriate user based on permission level
  const selectedUser = readOnly ? POSTGRES_USER_READ_ONLY : POSTGRES_USER_READ_WRITE

  // Validate that the selected user is not empty or just whitespace
  if (!selectedUser || selectedUser.trim() === '') {
    throw new Error(`Invalid username configuration: ${readOnly ? 'read-only' : 'read-write'} user cannot be empty`)
  }

  return selectedUser
}

/**
 * Enhanced username determination with environment-specific configuration
 * 
 * @param readOnly - Whether to use read-only credentials
 * @param customUser - Custom user override
 * @param useEnvironmentDefaults - Whether to use environment defaults
 * @param envConfig - Environment configuration from handler
 * @returns The appropriate username for the connection
 */
function determineUsernameWithEnvironment(
  readOnly: boolean, 
  customUser?: string, 
  useEnvironmentDefaults: boolean = true,
  envConfig?: any
): string | undefined {
  // If a custom user is provided, use it directly
  if (customUser !== undefined) {
    return customUser
  }

  // If not using environment defaults, return undefined to indicate missing parameter
  if (!useEnvironmentDefaults) {
    return undefined
  }

  // Use environment configuration if available, otherwise fall back to constants
  let selectedUser: string | undefined
  
  if (envConfig) {
    selectedUser = readOnly ? envConfig.POSTGRES_USER_READ_ONLY : envConfig.POSTGRES_USER_READ_WRITE
  } else {
    selectedUser = readOnly ? POSTGRES_USER_READ_ONLY : POSTGRES_USER_READ_WRITE
  }

  // Validate that the selected user is not empty or just whitespace
  if (!selectedUser || selectedUser.trim() === '') {
    throw new Error(`Invalid username configuration: ${readOnly ? 'read-only' : 'read-write'} user cannot be empty`)
  }

  return selectedUser
}

/**
 * Validates username format according to PostgreSQL rules
 * 
 * @param username - The username to validate
 * @returns True if valid, false otherwise
 */
function isValidUsername(username: string): boolean {
  if (!username || username.trim() === '') {
    return false
  }

  const trimmedUsername = username.trim()
  
  // PostgreSQL username rules: start with letter or underscore, contain letters, numbers, underscores, and hyphens
  return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(trimmedUsername)
}

/**
 * Formats username for display in connection strings, ensuring proper format for different permission levels
 * 
 * @param username - The username to format
 * @param readOnly - Whether this is for read-only access
 * @returns Formatted username with appropriate indicators
 */
function formatUsernameForDisplay(username: string, readOnly: boolean): string {
  // Ensure username is properly formatted and not empty
  if (!username || username.trim() === '') {
    throw new Error('Username cannot be empty for connection string display')
  }

  const trimmedUsername = username.trim()

  // Validate username format
  if (!isValidUsername(trimmedUsername)) {
    throw new Error(`Invalid username format: ${trimmedUsername}. Username must start with a letter or underscore and contain only letters, numbers, underscores, and hyphens.`)
  }

  // For read-only users, ensure the username clearly indicates read-only permissions
  if (readOnly && !trimmedUsername.includes('read_only') && !trimmedUsername.includes('readonly')) {
    // If it's a generic username like 'postgres' or 'supabase_admin', 
    // but we're in read-only mode, we should use the proper read-only user
    if (trimmedUsername === 'postgres' || trimmedUsername === 'supabase_admin') {
      return POSTGRES_USER_READ_ONLY || 'supabase_read_only_user'
    }
  }

  return trimmedUsername
}

/**
 * Generates a PostgreSQL connection string with fallback support and comprehensive error handling
 * Uses project-specific credentials first, then falls back to system credentials
 * 
 * @param options - Enhanced connection string options with fallback support
 * @returns ConnectionStringResult with fallback information
 */
export async function generateConnectionStringWithFallback(options: EnhancedConnectionStringOptions): Promise<ConnectionStringResult> {
  const errorHandler = getCredentialErrorHandler()

  return errorHandler.executeWithErrorHandling(
    async () => {
      const {
        projectRef,
        allowFallback = true,
        logFallbackUsage = true,
        projectCredentials,
        ...baseOptions
      } = options

      const fallbackManager = getCredentialFallbackManager()
      let usedFallback = false
      let fallbackReason: string | undefined
      let fallbackType: 'user' | 'password' | 'both' | undefined

      // Resolve credentials with fallback logic
      let finalUser = baseOptions.user
      let finalPassword = baseOptions.password

      // If project credentials are provided or projectRef is available, try to use them
      if (allowFallback && (projectCredentials || projectRef)) {
        let projectCreds: ProjectCredentials

        if (projectCredentials) {
          // Use provided project credentials
          projectCreds = fallbackManager.getProjectCredentials(
            projectRef || 'unknown',
            projectCredentials.user,
            projectCredentials.passwordHash
          )
        } else if (projectRef) {
          // For now, we'll assume project credentials are passed via projectCredentials parameter
          // In a real implementation, this would fetch from the database
          projectCreds = { user: null, passwordHash: null, isComplete: false }
        } else {
          projectCreds = { user: null, passwordHash: null, isComplete: false }
        }

        // Check if we need to use fallback credentials
        if (fallbackManager.shouldUseFallback(projectCreds)) {
          const systemCreds = await fallbackManager.getFallbackCredentials(baseOptions.readOnly)
          
          // Determine what's missing and use fallback accordingly
          const missingUser = !projectCreds.user && !finalUser
          const missingPassword = !projectCreds.passwordHash && !finalPassword

          if (missingUser && missingPassword) {
            finalUser = systemCreds.user
            finalPassword = systemCreds.password
            usedFallback = true
            fallbackReason = 'Both user and password missing from project credentials'
            fallbackType = 'both'
          } else if (missingUser) {
            finalUser = systemCreds.user
            finalPassword = finalPassword || projectCreds.passwordHash || systemCreds.password
            usedFallback = true
            fallbackReason = 'User missing from project credentials'
            fallbackType = 'user'
          } else if (missingPassword) {
            finalUser = finalUser || projectCreds.user || systemCreds.user
            finalPassword = systemCreds.password
            usedFallback = true
            fallbackReason = 'Password missing from project credentials'
            fallbackType = 'password'
          } else {
            // Use project credentials
            finalUser = finalUser || projectCreds.user || undefined
            finalPassword = finalPassword || projectCreds.passwordHash || undefined
          }

          // Log fallback usage if enabled
          if (usedFallback && logFallbackUsage && projectRef) {
            fallbackManager.logFallbackUsage(projectRef, fallbackReason!, fallbackType!)
          }
        } else {
          // Use complete project credentials
          finalUser = finalUser || projectCreds.user || undefined
          finalPassword = finalPassword || projectCreds.passwordHash || undefined
        }
      }

      // Generate the connection string using the resolved credentials
      const connectionString = await generateConnectionStringWithErrorHandling({
        ...baseOptions,
        user: finalUser,
        password: finalPassword,
      })

      return {
        connectionString,
        usedFallback,
        fallbackReason,
        fallbackType,
      }
    },
    {
      serviceName: 'connection-string-generation',
      context: `generateConnectionStringWithFallback-${options.projectRef || 'unknown'}`,
      enableRetry: true,
      enableCircuitBreaker: true,
      enableGracefulDegradation: true,
      fallbackFn: async () => {
        // Fallback: generate basic connection string with environment defaults
        console.warn('[Connection String] Using fallback connection string generation')
        const basicConnectionString = generateConnectionString({
          databaseName: options.databaseName,
          host: options.host,
          port: options.port,
          user: options.user,
          password: options.password,
          readOnly: options.readOnly,
          maskPassword: options.maskPassword,
          useEnvironmentDefaults: true
        })
        
        return {
          connectionString: basicConnectionString,
          usedFallback: true,
          fallbackReason: 'Primary connection string generation failed, using environment defaults',
          fallbackType: 'both' as const
        }
      }
    }
  )
}

/**
 * Generates a PostgreSQL connection string with comprehensive error handling
 * 
 * @param options - Connection string options
 * @returns A PostgreSQL connection string
 */
async function generateConnectionStringWithErrorHandling(options: ConnectionStringOptions): Promise<string> {
  const errorHandler = getCredentialErrorHandler()

  return errorHandler.executeWithErrorHandling(
    async () => generateConnectionString(options),
    {
      serviceName: 'connection-string-basic',
      context: `generateConnectionString-${options.databaseName}`,
      enableRetry: true,
      enableCircuitBreaker: false, // Basic string generation shouldn't need circuit breaker
      enableGracefulDegradation: true,
      fallbackFn: async () => {
        // Fallback: try with minimal validation
        console.warn('[Connection String] Using minimal validation fallback')
        return generateConnectionStringMinimal(options)
      }
    }
  )
}

/**
 * Generates a PostgreSQL connection string with minimal validation (fallback)
 */
function generateConnectionStringMinimal(options: ConnectionStringOptions): string {
  const {
    databaseName,
    readOnly = false,
    host = POSTGRES_HOST,
    port = POSTGRES_PORT,
    user = readOnly ? POSTGRES_USER_READ_ONLY : POSTGRES_USER_READ_WRITE,
    password = POSTGRES_PASSWORD,
    maskPassword = false,
  } = options

  // Use defaults for any missing values
  const finalHost = host || 'localhost'
  const finalPort = port || 5432
  const finalUser = user || 'postgres'
  const finalPassword = password || 'password'
  const finalDatabase = databaseName || 'postgres'

  const displayPassword = maskPassword ? '[YOUR_PASSWORD]' : finalPassword
  
  return `postgresql://${finalUser}:${displayPassword}@${finalHost}:${finalPort}/${finalDatabase}`
}

/**
 * Generates a PostgreSQL connection string with auto-generated credentials
 * Uses environment-specific configuration when available
 * Requirements 2.1, 2.2, 2.3, 2.5: Generate connection strings with auto-generated credentials
 * 
 * @param options - Connection string options
 * @returns A PostgreSQL connection string with auto-generated credentials
 * @throws Error if required parameters are missing and no fallback is available
 */
export function generateConnectionString(options: ConnectionStringOptions): string {
  const {
    databaseName,
    readOnly = false,
    host,
    port,
    user,
    password,
    useEnvironmentDefaults = true,
    maskPassword = false,
  } = options

  // Try to use environment configuration handler for environment-specific values
  let envConfig: any = null
  try {
    // Only use environment config handler if it's explicitly requested or available
    if (useEnvironmentDefaults) {
      const configHandler = getEnvironmentConfigHandler()
      envConfig = configHandler.getCurrentConfig()
    }
  } catch (error) {
    // Fall back to direct environment variables if handler is not available
    // This ensures backward compatibility with existing code
    envConfig = null
  }

  // Use provided values or fall back to environment configuration, then to direct environment variables
  const finalHost = host !== undefined ? host : 
    (envConfig?.POSTGRES_HOST || (useEnvironmentDefaults ? POSTGRES_HOST : undefined))
  
  const finalPort = port !== undefined ? port : 
    (envConfig?.POSTGRES_PORT || (useEnvironmentDefaults ? POSTGRES_PORT : undefined))
  
  const finalPassword = password !== undefined ? password : 
    (envConfig?.POSTGRES_PASSWORD || (useEnvironmentDefaults ? POSTGRES_PASSWORD : undefined))
  
  // Use enhanced username determination logic with environment-specific configuration
  const finalUser = determineUsernameWithEnvironment(readOnly, user, useEnvironmentDefaults, envConfig)

  // Check for missing parameters (undefined or null)
  if (finalHost === undefined || finalHost === null || 
      finalPort === undefined || finalPort === null || 
      finalUser === undefined || finalUser === null || 
      finalPassword === undefined || finalPassword === null) {
    const missing = []
    if (finalHost === undefined || finalHost === null) missing.push('host')
    if (finalPort === undefined || finalPort === null) missing.push('port')
    if (finalUser === undefined || finalUser === null) missing.push('user')
    if (finalPassword === undefined || finalPassword === null) missing.push('password')
    
    throw CredentialError.configuration(
      `Missing required connection parameters: ${missing.join(', ')}. ` +
      `Either provide these values directly or ensure environment variables are set.`,
      { missing, useEnvironmentDefaults, readOnly }
    )
  }

  // Validate connection parameters (including empty strings)
  const validation = validateConnectionParameters({
    host: finalHost,
    port: finalPort,
    user: finalUser,
    password: finalPassword,
    databaseName
  })

  if (!validation.isValid) {
    throw CredentialError.validation(
      `Invalid connection parameters: ${validation.errors.join(', ')}`,
      { 
        validationErrors: validation.errors,
        host: finalHost,
        port: finalPort,
        user: finalUser,
        databaseName,
        readOnly
      }
    )
  }

  // Format username appropriately for the connection string
  const formattedUser = formatUsernameForDisplay(finalUser, readOnly)

  // Use masked password for display purposes if requested
  const displayPassword = maskPassword ? '[YOUR_PASSWORD]' : finalPassword
  
  return `postgresql://${formattedUser}:${displayPassword}@${finalHost}:${finalPort}/${databaseName}`
}

/**
 * Generates a PostgreSQL connection string for display purposes with masked password
 * This function should be used when showing connection strings to users in the UI
 * 
 * @param options - Connection string options
 * @returns A PostgreSQL connection string with masked password
 */
export function generateDisplayConnectionString(options: Omit<ConnectionStringOptions, 'maskPassword'>): string {
  return generateConnectionString({ ...options, maskPassword: true })
}

/**
 * Generates a display connection string with fallback support
 * 
 * @param options - Enhanced connection string options
 * @returns ConnectionStringResult with masked password
 */
export async function generateDisplayConnectionStringWithFallback(
  options: Omit<EnhancedConnectionStringOptions, 'maskPassword'>
): Promise<ConnectionStringResult> {
  return generateConnectionStringWithFallback({ ...options, maskPassword: true })
}



/**
 * Validates project-specific connection parameters
 */
function validateProjectConnectionParameters(params: {
  projectUser: string
  projectPassword: string
  projectDatabase: string
  host: string
  port: number | string
}): { isValid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!params.host || params.host.trim() === '') {
    errors.push('Host cannot be empty')
  }

  if (!params.port) {
    errors.push('Port cannot be empty')
  } else {
    const portNum = typeof params.port === 'string' ? parseInt(params.port, 10) : params.port
    if (isNaN(portNum) || portNum <= 0 || portNum > 65535) {
      errors.push('Port must be a valid number between 1 and 65535')
    }
  }

  if (!params.projectUser || params.projectUser.trim() === '') {
    errors.push('Project user cannot be empty')
  } else if (!isValidUsername(params.projectUser)) {
    errors.push('Invalid project username format')
  }

  if (!params.projectPassword || params.projectPassword.trim() === '') {
    errors.push('Project password cannot be empty')
  }

  if (!params.projectDatabase || params.projectDatabase.trim() === '') {
    errors.push('Project database cannot be empty')
  }

  return {
    isValid: errors.length === 0,
    errors
  }
}

/**
 * Generates project-specific connection strings with both masked and actual password versions
 * 
 * @param options - Project connection options
 * @returns Object containing both masked and actual connection strings
 * @throws Error if required parameters are missing or invalid
 */
export function generateProjectConnectionString(options: ProjectConnectionOptions): {
  masked: string
  actual: string
} {
  const {
    projectUser,
    projectPassword,
    projectDatabase,
    host,
    port,
    revealPassword = false,
    useEnvironmentDefaults = true,
  } = options

  // Get environment configuration for host and port defaults
  let envConfig: any = null
  try {
    if (useEnvironmentDefaults) {
      const configHandler = getEnvironmentConfigHandler()
      envConfig = configHandler.getCurrentConfig()
    }
  } catch (error) {
    envConfig = null
  }

  // Use provided values or fall back to environment configuration
  const finalHost = host !== undefined ? host : 
    (envConfig?.POSTGRES_HOST || (useEnvironmentDefaults ? POSTGRES_HOST : undefined))
  
  const finalPort = port !== undefined ? port : 
    (envConfig?.POSTGRES_PORT || (useEnvironmentDefaults ? POSTGRES_PORT : undefined))

  // Check for missing host/port parameters
  if (finalHost === undefined || finalHost === null || 
      finalPort === undefined || finalPort === null) {
    const missing = []
    if (finalHost === undefined || finalHost === null) missing.push('host')
    if (finalPort === undefined || finalPort === null) missing.push('port')
    
    throw new Error(`Missing required connection parameters: ${missing.join(', ')}. ` +
      `Either provide these values directly or ensure environment variables are set.`)
  }

  // Validate project-specific parameters
  const validation = validateProjectConnectionParameters({
    projectUser,
    projectPassword,
    projectDatabase,
    host: finalHost,
    port: finalPort
  })

  if (!validation.isValid) {
    throw new Error(`Invalid project connection parameters: ${validation.errors.join(', ')}`)
  }

  // Generate both masked and actual connection strings
  const maskedConnectionString = `postgresql://${projectUser}:[YOUR_PASSWORD]@${finalHost}:${finalPort}/${projectDatabase}`
  const actualConnectionString = `postgresql://${projectUser}:${projectPassword}@${finalHost}:${finalPort}/${projectDatabase}`

  return {
    masked: maskedConnectionString,
    actual: actualConnectionString
  }
}

/**
 * Generates a project-specific connection string with password visibility control
 * 
 * @param options - Project connection options
 * @returns A PostgreSQL connection string with password masked or revealed based on revealPassword option
 */
export function generateProjectConnectionStringWithVisibility(options: ProjectConnectionOptions): string {
  const { revealPassword = false } = options
  const connectionStrings = generateProjectConnectionString(options)
  
  return revealPassword ? connectionStrings.actual : connectionStrings.masked
}

/**
 * Validates connection string format and parameter substitution
 * 
 * @param connectionString - The connection string to validate
 * @returns Validation result with details
 */
export function validateConnectionStringFormat(connectionString: string): {
  isValid: boolean
  errors: string[]
  components?: {
    user?: string
    password?: string
    host?: string
    port?: number
    database?: string
  }
} {
  const errors: string[] = []

  if (!connectionString || connectionString.trim() === '') {
    errors.push('Connection string cannot be empty')
    return { isValid: false, errors }
  }

  try {
    const url = new URL(connectionString)
    
    // Check protocol
    if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
      errors.push('Connection string must use postgresql:// or postgres:// protocol')
    }

    // Check required components
    if (!url.hostname) {
      errors.push('Connection string must include a hostname')
    }

    if (!url.username) {
      errors.push('Connection string must include a username')
    }

    if (!url.pathname || url.pathname === '/') {
      errors.push('Connection string must include a database name')
    }

    // Validate username format if present
    if (url.username && !isValidUsername(url.username)) {
      errors.push(`Invalid username format in connection string: ${url.username}`)
    }

    // Check for masked password placeholder
    const hasMaskedPassword = url.password === '[YOUR_PASSWORD]'
    const hasActualPassword = url.password && url.password !== '[YOUR_PASSWORD]'

    if (!hasMaskedPassword && !hasActualPassword) {
      errors.push('Connection string must include either a password or [YOUR_PASSWORD] placeholder')
    }

    // Validate port if present
    if (url.port) {
      const portNum = parseInt(url.port, 10)
      if (isNaN(portNum) || portNum <= 0 || portNum > 65535) {
        errors.push('Port must be a valid number between 1 and 65535')
      }
    }

    const components = {
      user: url.username || undefined,
      password: url.password || undefined,
      host: url.hostname || undefined,
      port: url.port ? parseInt(url.port, 10) : undefined,
      database: url.pathname.slice(1) || undefined,
    }

    return {
      isValid: errors.length === 0,
      errors,
      components
    }
  } catch (error) {
    errors.push('Invalid connection string format')
    return { isValid: false, errors }
  }
}

/**
 * Enhanced parsing result with fallback information
 */
export interface ParsedConnectionStringResult {
  user?: string
  password?: string
  host?: string
  port?: number
  database?: string
  hasMaskedPassword?: boolean
  isValid?: boolean
  errors?: string[]
}

/**
 * Parses a PostgreSQL connection string with enhanced fallback scenario handling
 * 
 * @param connectionString - The connection string to parse
 * @param options - Parsing options
 * @returns Enhanced parsed connection string components with validation
 */
export function parseConnectionStringWithFallback(
  connectionString: string,
  options: {
    validateFormat?: boolean
    allowMaskedPassword?: boolean
  } = {}
): ParsedConnectionStringResult {
  const { validateFormat = true, allowMaskedPassword = true } = options

  if (!connectionString || connectionString.trim() === '') {
    return {
      isValid: false,
      errors: ['Connection string cannot be empty']
    }
  }

  try {
    const url = new URL(connectionString)
    
    const decodedPassword = url.password ? decodeURIComponent(url.password) : undefined
    
    const result: ParsedConnectionStringResult = {
      user: url.username || undefined,
      password: decodedPassword,
      host: url.hostname || undefined,
      port: url.port ? parseInt(url.port, 10) : undefined,
      database: url.pathname.slice(1) || undefined, // Remove leading slash
      hasMaskedPassword: decodedPassword === '[YOUR_PASSWORD]',
      isValid: true,
      errors: []
    }

    // Perform validation if requested
    if (validateFormat) {
      const validation = validateConnectionStringFormat(connectionString)
      result.isValid = validation.isValid
      result.errors = validation.errors

      // Allow masked passwords if specified
      if (!validation.isValid && allowMaskedPassword && result.hasMaskedPassword) {
        // Remove password-related errors when masked password is allowed
        result.errors = validation.errors.filter(error => 
          !error.includes('password') && !error.includes('PASSWORD')
        )
        result.isValid = result.errors.length === 0
      }
    }

    return result
  } catch (error) {
    return {
      isValid: false,
      errors: ['Invalid connection string format']
    }
  }
}

/**
 * Parses a PostgreSQL connection string to extract database name and other components
 * 
 * @param connectionString - The connection string to parse
 * @returns Parsed connection string components
 */
export function parseConnectionString(connectionString: string): {
  user?: string
  password?: string
  host?: string
  port?: number
  database?: string
} {
  try {
    const url = new URL(connectionString)
    
    return {
      user: url.username || undefined,
      password: url.password || undefined,
      host: url.hostname || undefined,
      port: url.port ? parseInt(url.port, 10) : undefined,
      database: url.pathname.slice(1) || undefined, // Remove leading slash
    }
  } catch {
    return {}
  }
}
