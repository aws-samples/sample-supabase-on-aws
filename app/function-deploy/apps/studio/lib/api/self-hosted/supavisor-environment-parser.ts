/**
 * Supavisor Environment Variable Parser and Validator
 * 
 * This module provides comprehensive parsing and validation for Supavisor
 * environment variables with proper error handling, default values, and
 * schema validation.
 */

export interface SupavisorEnvironmentConfig {
  POOLER_DEFAULT_POOL_SIZE: number
  POOLER_MAX_CLIENT_CONN: number
  POOLER_PROXY_PORT_TRANSACTION: number
  POOLER_TENANT_ID: string
  POOLER_DB_POOL_SIZE: number
  SUPAVISOR_VERSION?: string
  SUPAVISOR_MODE?: string
  SUPAVISOR_CLUSTER_ALIAS?: string
}

export interface ValidationResult {
  isValid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
}

export interface ValidationError {
  field: string
  message: string
  value?: any
  code: string
}

export interface ValidationWarning {
  field: string
  message: string
  value?: any
  code: string
}

export interface EnvironmentVariableSchema {
  name: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
  defaultValue?: any
  validator?: (value: any) => ValidationResult
  description: string
}

/**
 * Schema definition for Supavisor environment variables
 */
export const SUPAVISOR_ENV_SCHEMA: EnvironmentVariableSchema[] = [
  {
    name: 'POOLER_DEFAULT_POOL_SIZE',
    type: 'number',
    required: true,
    defaultValue: 20,
    validator: validatePoolSize,
    description: 'Default number of connections in the connection pool'
  },
  {
    name: 'POOLER_MAX_CLIENT_CONN',
    type: 'number',
    required: true,
    defaultValue: 100,
    validator: validateMaxClientConnections,
    description: 'Maximum number of concurrent client connections'
  },
  {
    name: 'POOLER_PROXY_PORT_TRANSACTION',
    type: 'number',
    required: true,
    defaultValue: 6543,
    validator: validatePort,
    description: 'Port for transaction-level pooling proxy'
  },
  {
    name: 'POOLER_TENANT_ID',
    type: 'string',
    required: true,
    defaultValue: 'default-tenant',
    validator: validateTenantId,
    description: 'Unique identifier for the Supavisor tenant'
  },
  {
    name: 'POOLER_DB_POOL_SIZE',
    type: 'number',
    required: true,
    defaultValue: 5,
    validator: validateDbPoolSize,
    description: 'Number of database connections per pool'
  },
  {
    name: 'SUPAVISOR_VERSION',
    type: 'string',
    required: false,
    validator: validateVersion,
    description: 'Version of Supavisor service'
  },
  {
    name: 'SUPAVISOR_MODE',
    type: 'string',
    required: false,
    validator: validateMode,
    description: 'Operating mode for Supavisor (session, transaction, statement)'
  },
  {
    name: 'SUPAVISOR_CLUSTER_ALIAS',
    type: 'string',
    required: false,
    validator: validateClusterAlias,
    description: 'Alias for the Supavisor cluster'
  }
]

/**
 * Parse and validate Supavisor environment variables
 */
export function parseSupavisorEnvironmentVariables(): {
  config: SupavisorEnvironmentConfig
  validation: ValidationResult
} {
  const config: Partial<SupavisorEnvironmentConfig> = {}
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  for (const schema of SUPAVISOR_ENV_SCHEMA) {
    try {
      const rawValue = process.env[schema.name]
      const parsedValue = parseEnvironmentVariable(rawValue, schema)
      
      if (parsedValue !== undefined) {
        // Type assertion is safe here because we control the schema
        (config as any)[schema.name] = parsedValue
        
        // Run custom validation if provided
        if (schema.validator) {
          const validationResult = schema.validator(parsedValue)
          errors.push(...validationResult.errors)
          warnings.push(...validationResult.warnings)
        }
      } else if (schema.required) {
        errors.push({
          field: schema.name,
          message: `Required environment variable ${schema.name} is missing or invalid`,
          code: 'MISSING_REQUIRED_VAR'
        })
      }
    } catch (error) {
      errors.push({
        field: schema.name,
        message: `Failed to parse ${schema.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        value: process.env[schema.name],
        code: 'PARSE_ERROR'
      })
    }
  }

  // Perform cross-field validation
  const crossValidationResult = validateConfigurationConsistency(config as SupavisorEnvironmentConfig)
  errors.push(...crossValidationResult.errors)
  warnings.push(...crossValidationResult.warnings)

  return {
    config: config as SupavisorEnvironmentConfig,
    validation: {
      isValid: errors.length === 0,
      errors,
      warnings
    }
  }
}

/**
 * Parse a single environment variable according to its schema
 */
function parseEnvironmentVariable(
  rawValue: string | undefined,
  schema: EnvironmentVariableSchema
): any {
  // Handle missing values
  if (rawValue === undefined || rawValue === '') {
    if (schema.required && schema.defaultValue === undefined) {
      return undefined
    }
    return schema.defaultValue
  }

  // Parse based on type
  switch (schema.type) {
    case 'string':
      return rawValue.trim()
    
    case 'number':
      const numValue = parseFloat(rawValue)
      if (isNaN(numValue)) {
        throw new Error(`Invalid number format: "${rawValue}"`)
      }
      return numValue
    
    case 'boolean':
      const lowerValue = rawValue.toLowerCase().trim()
      if (['true', '1', 'yes', 'on'].includes(lowerValue)) {
        return true
      }
      if (['false', '0', 'no', 'off'].includes(lowerValue)) {
        return false
      }
      throw new Error(`Invalid boolean format: "${rawValue}". Use true/false, 1/0, yes/no, or on/off`)
    
    default:
      throw new Error(`Unknown type: ${schema.type}`)
  }
}

/**
 * Validate pool size configuration
 */
function validatePoolSize(value: number): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  if (!Number.isInteger(value)) {
    errors.push({
      field: 'POOLER_DEFAULT_POOL_SIZE',
      message: 'Pool size must be an integer',
      value,
      code: 'INVALID_INTEGER'
    })
  }

  if (value <= 0) {
    errors.push({
      field: 'POOLER_DEFAULT_POOL_SIZE',
      message: 'Pool size must be greater than 0',
      value,
      code: 'INVALID_RANGE'
    })
  }

  if (value > 1000) {
    errors.push({
      field: 'POOLER_DEFAULT_POOL_SIZE',
      message: 'Pool size cannot exceed 1000 connections',
      value,
      code: 'EXCEEDS_MAXIMUM'
    })
  }

  if (value < 5) {
    warnings.push({
      field: 'POOLER_DEFAULT_POOL_SIZE',
      message: 'Pool size below 5 may cause performance issues under load',
      value,
      code: 'PERFORMANCE_WARNING'
    })
  }

  if (value > 200) {
    warnings.push({
      field: 'POOLER_DEFAULT_POOL_SIZE',
      message: 'Large pool sizes may consume significant memory resources',
      value,
      code: 'RESOURCE_WARNING'
    })
  }

  return { isValid: errors.length === 0, errors, warnings }
}

/**
 * Validate max client connections configuration
 */
function validateMaxClientConnections(value: number): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  if (!Number.isInteger(value)) {
    errors.push({
      field: 'POOLER_MAX_CLIENT_CONN',
      message: 'Max client connections must be an integer',
      value,
      code: 'INVALID_INTEGER'
    })
  }

  if (value <= 0) {
    errors.push({
      field: 'POOLER_MAX_CLIENT_CONN',
      message: 'Max client connections must be greater than 0',
      value,
      code: 'INVALID_RANGE'
    })
  }

  if (value > 10000) {
    errors.push({
      field: 'POOLER_MAX_CLIENT_CONN',
      message: 'Max client connections cannot exceed 10000',
      value,
      code: 'EXCEEDS_MAXIMUM'
    })
  }

  if (value < 10) {
    warnings.push({
      field: 'POOLER_MAX_CLIENT_CONN',
      message: 'Very low max client connections may limit concurrent access',
      value,
      code: 'PERFORMANCE_WARNING'
    })
  }

  return { isValid: errors.length === 0, errors, warnings }
}

/**
 * Validate port configuration
 */
function validatePort(value: number): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  if (!Number.isInteger(value)) {
    errors.push({
      field: 'POOLER_PROXY_PORT_TRANSACTION',
      message: 'Port must be an integer',
      value,
      code: 'INVALID_INTEGER'
    })
  }

  if (value < 1 || value > 65535) {
    errors.push({
      field: 'POOLER_PROXY_PORT_TRANSACTION',
      message: 'Port must be between 1 and 65535',
      value,
      code: 'INVALID_RANGE'
    })
  }

  if (value < 1024) {
    warnings.push({
      field: 'POOLER_PROXY_PORT_TRANSACTION',
      message: 'Using privileged port (< 1024) may require elevated permissions',
      value,
      code: 'PRIVILEGE_WARNING'
    })
  }

  // Common port conflicts
  const commonPorts = [22, 80, 443, 5432, 3000, 8000, 8080]
  if (commonPorts.includes(value)) {
    warnings.push({
      field: 'POOLER_PROXY_PORT_TRANSACTION',
      message: `Port ${value} is commonly used by other services and may cause conflicts`,
      value,
      code: 'PORT_CONFLICT_WARNING'
    })
  }

  return { isValid: errors.length === 0, errors, warnings }
}

/**
 * Validate tenant ID configuration
 */
function validateTenantId(value: string): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  if (!value || value.trim().length === 0) {
    errors.push({
      field: 'POOLER_TENANT_ID',
      message: 'Tenant ID cannot be empty',
      value,
      code: 'EMPTY_VALUE'
    })
  }

  if (value === 'default-tenant' || value === 'your-tenant-id') {
    warnings.push({
      field: 'POOLER_TENANT_ID',
      message: 'Using default tenant ID is not recommended for production',
      value,
      code: 'DEFAULT_VALUE_WARNING'
    })
  }

  // Validate format (alphanumeric, hyphens, underscores)
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    errors.push({
      field: 'POOLER_TENANT_ID',
      message: 'Tenant ID can only contain letters, numbers, hyphens, and underscores',
      value,
      code: 'INVALID_FORMAT'
    })
  }

  if (value.length > 64) {
    errors.push({
      field: 'POOLER_TENANT_ID',
      message: 'Tenant ID cannot exceed 64 characters',
      value,
      code: 'EXCEEDS_LENGTH'
    })
  }

  return { isValid: errors.length === 0, errors, warnings }
}

/**
 * Validate database pool size configuration
 */
function validateDbPoolSize(value: number): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  if (!Number.isInteger(value)) {
    errors.push({
      field: 'POOLER_DB_POOL_SIZE',
      message: 'Database pool size must be an integer',
      value,
      code: 'INVALID_INTEGER'
    })
  }

  if (value <= 0) {
    errors.push({
      field: 'POOLER_DB_POOL_SIZE',
      message: 'Database pool size must be greater than 0',
      value,
      code: 'INVALID_RANGE'
    })
  }

  if (value > 100) {
    errors.push({
      field: 'POOLER_DB_POOL_SIZE',
      message: 'Database pool size cannot exceed 100 connections',
      value,
      code: 'EXCEEDS_MAXIMUM'
    })
  }

  if (value < 2) {
    warnings.push({
      field: 'POOLER_DB_POOL_SIZE',
      message: 'Very small database pool size may cause connection bottlenecks',
      value,
      code: 'PERFORMANCE_WARNING'
    })
  }

  return { isValid: errors.length === 0, errors, warnings }
}

/**
 * Validate version string (optional)
 */
function validateVersion(value: string): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  // Semantic version pattern (e.g., 1.2.3, 1.2.3-alpha.1)
  const semverPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?$/
  
  if (value && !semverPattern.test(value)) {
    warnings.push({
      field: 'SUPAVISOR_VERSION',
      message: 'Version should follow semantic versioning format (e.g., 1.2.3)',
      value,
      code: 'FORMAT_WARNING'
    })
  }

  return { isValid: errors.length === 0, errors, warnings }
}

/**
 * Validate mode configuration (optional)
 */
function validateMode(value: string): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const validModes = ['session', 'transaction', 'statement']
  
  if (value && !validModes.includes(value.toLowerCase())) {
    errors.push({
      field: 'SUPAVISOR_MODE',
      message: `Mode must be one of: ${validModes.join(', ')}`,
      value,
      code: 'INVALID_OPTION'
    })
  }

  return { isValid: errors.length === 0, errors, warnings }
}

/**
 * Validate cluster alias (optional)
 */
function validateClusterAlias(value: string): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  if (value && !/^[a-zA-Z0-9_-]+$/.test(value)) {
    errors.push({
      field: 'SUPAVISOR_CLUSTER_ALIAS',
      message: 'Cluster alias can only contain letters, numbers, hyphens, and underscores',
      value,
      code: 'INVALID_FORMAT'
    })
  }

  if (value && value.length > 32) {
    errors.push({
      field: 'SUPAVISOR_CLUSTER_ALIAS',
      message: 'Cluster alias cannot exceed 32 characters',
      value,
      code: 'EXCEEDS_LENGTH'
    })
  }

  return { isValid: errors.length === 0, errors, warnings }
}

/**
 * Validate configuration consistency across fields
 */
function validateConfigurationConsistency(config: SupavisorEnvironmentConfig): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  // Check that max client connections is reasonable compared to pool size
  if (config.POOLER_MAX_CLIENT_CONN && config.POOLER_DEFAULT_POOL_SIZE) {
    if (config.POOLER_MAX_CLIENT_CONN < config.POOLER_DEFAULT_POOL_SIZE) {
      warnings.push({
        field: 'POOLER_MAX_CLIENT_CONN',
        message: 'Max client connections should typically be greater than or equal to pool size',
        value: {
          maxClientConnections: config.POOLER_MAX_CLIENT_CONN,
          poolSize: config.POOLER_DEFAULT_POOL_SIZE
        },
        code: 'CONFIGURATION_MISMATCH'
      })
    }

    // Warn if the ratio seems unusual
    const ratio = config.POOLER_MAX_CLIENT_CONN / config.POOLER_DEFAULT_POOL_SIZE
    if (ratio > 50) {
      warnings.push({
        field: 'POOLER_MAX_CLIENT_CONN',
        message: 'Very high client-to-pool ratio may cause excessive connection queuing',
        value: { ratio: Math.round(ratio * 10) / 10 },
        code: 'PERFORMANCE_WARNING'
      })
    }
  }

  // Check database pool size relative to default pool size
  if (config.POOLER_DB_POOL_SIZE && config.POOLER_DEFAULT_POOL_SIZE) {
    if (config.POOLER_DB_POOL_SIZE > config.POOLER_DEFAULT_POOL_SIZE) {
      warnings.push({
        field: 'POOLER_DB_POOL_SIZE',
        message: 'Database pool size is larger than default pool size, which may be inefficient',
        value: {
          dbPoolSize: config.POOLER_DB_POOL_SIZE,
          defaultPoolSize: config.POOLER_DEFAULT_POOL_SIZE
        },
        code: 'CONFIGURATION_WARNING'
      })
    }
  }

  return { isValid: errors.length === 0, errors, warnings }
}

/**
 * Get default configuration with all default values applied
 */
export function getDefaultSupavisorConfiguration(): SupavisorEnvironmentConfig {
  const config: SupavisorEnvironmentConfig = {} as SupavisorEnvironmentConfig

  for (const schema of SUPAVISOR_ENV_SCHEMA) {
    if (schema.defaultValue !== undefined) {
      (config as any)[schema.name] = schema.defaultValue
    }
  }

  return config
}

/**
 * Format validation errors for user display
 */
export function formatValidationErrors(validation: ValidationResult): string[] {
  const messages: string[] = []

  for (const error of validation.errors) {
    messages.push(`❌ ${error.field}: ${error.message}`)
  }

  for (const warning of validation.warnings) {
    messages.push(`⚠️  ${warning.field}: ${warning.message}`)
  }

  return messages
}

/**
 * Check if environment is properly configured for Supavisor
 */
export function isSupavisorEnvironmentConfigured(): boolean {
  const { validation } = parseSupavisorEnvironmentVariables()
  return validation.isValid
}