/**
 * Supavisor Environment Utilities
 * 
 * This module provides convenient utility functions for working with
 * Supavisor environment variables, including validation helpers and
 * configuration status checks.
 */

import { 
  parseSupavisorEnvironmentVariables,
  formatValidationErrors,
  isSupavisorEnvironmentConfigured,
  getDefaultSupavisorConfiguration,
  type SupavisorEnvironmentConfig,
  type ValidationResult,
  type ValidationError,
  type ValidationWarning,
  SUPAVISOR_ENV_SCHEMA
} from './supavisor-environment-parser'

/**
 * Configuration status information
 */
export interface ConfigurationStatus {
  isConfigured: boolean
  hasErrors: boolean
  hasWarnings: boolean
  errorCount: number
  warningCount: number
  missingRequired: string[]
  summary: string
}

/**
 * Environment variable information for UI display
 */
export interface EnvironmentVariableInfo {
  name: string
  value?: string
  isSet: boolean
  isRequired: boolean
  defaultValue?: any
  description: string
  hasError: boolean
  hasWarning: boolean
  errorMessage?: string
  warningMessage?: string
}

/**
 * Get comprehensive configuration status
 */
export function getSupavisorConfigurationStatus(): ConfigurationStatus {
  const { config, validation } = parseSupavisorEnvironmentVariables()
  
  const missingRequired = SUPAVISOR_ENV_SCHEMA
    .filter(schema => schema.required && !process.env[schema.name])
    .map(schema => schema.name)

  const errorCount = validation.errors.length
  const warningCount = validation.warnings.length
  const hasErrors = errorCount > 0
  const hasWarnings = warningCount > 0

  let summary: string
  if (!hasErrors && !hasWarnings) {
    summary = 'Supavisor is properly configured'
  } else if (hasErrors) {
    summary = `Configuration has ${errorCount} error${errorCount > 1 ? 's' : ''}`
    if (hasWarnings) {
      summary += ` and ${warningCount} warning${warningCount > 1 ? 's' : ''}`
    }
  } else {
    summary = `Configuration has ${warningCount} warning${warningCount > 1 ? 's' : ''}`
  }

  return {
    isConfigured: validation.isValid,
    hasErrors,
    hasWarnings,
    errorCount,
    warningCount,
    missingRequired,
    summary
  }
}

/**
 * Get detailed information about all environment variables
 */
export function getEnvironmentVariableInfo(): EnvironmentVariableInfo[] {
  const { validation } = parseSupavisorEnvironmentVariables()
  
  return SUPAVISOR_ENV_SCHEMA.map(schema => {
    const value = process.env[schema.name]
    const isSet = value !== undefined && value !== ''
    
    // Find errors and warnings for this field
    const fieldErrors = validation.errors.filter(e => e.field === schema.name)
    const fieldWarnings = validation.warnings.filter(w => w.field === schema.name)
    
    return {
      name: schema.name,
      value: isSet ? value : undefined,
      isSet,
      isRequired: schema.required,
      defaultValue: schema.defaultValue,
      description: schema.description,
      hasError: fieldErrors.length > 0,
      hasWarning: fieldWarnings.length > 0,
      errorMessage: fieldErrors.length > 0 ? fieldErrors[0].message : undefined,
      warningMessage: fieldWarnings.length > 0 ? fieldWarnings[0].message : undefined
    }
  })
}

/**
 * Get configuration with validation details
 */
export function getSupavisorConfigurationWithValidation(): {
  config: SupavisorEnvironmentConfig
  validation: ValidationResult
  status: ConfigurationStatus
  variables: EnvironmentVariableInfo[]
} {
  const { config, validation } = parseSupavisorEnvironmentVariables()
  const status = getSupavisorConfigurationStatus()
  const variables = getEnvironmentVariableInfo()

  return {
    config,
    validation,
    status,
    variables
  }
}

/**
 * Check if a specific environment variable is properly configured
 */
export function isEnvironmentVariableValid(variableName: string): boolean {
  const { validation } = parseSupavisorEnvironmentVariables()
  const hasError = validation.errors.some(e => e.field === variableName)
  return !hasError
}

/**
 * Get validation messages for a specific environment variable
 */
export function getEnvironmentVariableMessages(variableName: string): {
  errors: string[]
  warnings: string[]
} {
  const { validation } = parseSupavisorEnvironmentVariables()
  
  const errors = validation.errors
    .filter(e => e.field === variableName)
    .map(e => e.message)
  
  const warnings = validation.warnings
    .filter(w => w.field === variableName)
    .map(w => w.message)

  return { errors, warnings }
}

/**
 * Generate setup guidance for missing or invalid configuration
 */
export function generateSetupGuidance(): {
  hasIssues: boolean
  requiredActions: string[]
  recommendations: string[]
  exampleConfiguration: Record<string, string>
} {
  const { validation } = parseSupavisorEnvironmentVariables()
  const status = getSupavisorConfigurationStatus()
  
  const requiredActions: string[] = []
  const recommendations: string[] = []
  
  // Required actions for errors
  for (const error of validation.errors) {
    if (error.code === 'MISSING_REQUIRED_VAR') {
      requiredActions.push(`Set ${error.field} environment variable`)
    } else if (error.code === 'INVALID_RANGE' || error.code === 'INVALID_FORMAT') {
      requiredActions.push(`Fix ${error.field}: ${error.message}`)
    }
  }

  // Recommendations for warnings
  for (const warning of validation.warnings) {
    if (warning.code === 'DEFAULT_VALUE_WARNING') {
      recommendations.push(`Consider setting a custom ${warning.field} for production use`)
    } else if (warning.code === 'PERFORMANCE_WARNING') {
      recommendations.push(`Review ${warning.field} setting: ${warning.message}`)
    }
  }

  // Generate example configuration
  const defaultConfig = getDefaultSupavisorConfiguration()
  const exampleConfiguration: Record<string, string> = {}
  
  for (const schema of SUPAVISOR_ENV_SCHEMA) {
    if (schema.required || schema.defaultValue !== undefined) {
      const value = schema.defaultValue !== undefined ? 
        String(schema.defaultValue) : 
        'your-value-here'
      exampleConfiguration[schema.name] = value
    }
  }

  return {
    hasIssues: status.hasErrors || status.hasWarnings,
    requiredActions,
    recommendations,
    exampleConfiguration
  }
}

/**
 * Validate a configuration object before applying it
 */
export function validateConfigurationObject(config: Partial<SupavisorEnvironmentConfig>): ValidationResult {
  // Temporarily set environment variables to test validation
  const originalEnv = { ...process.env }
  
  try {
    // Apply the configuration to environment
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined) {
        process.env[key] = String(value)
      }
    }
    
    // Parse and validate
    const { validation } = parseSupavisorEnvironmentVariables()
    return validation
  } finally {
    // Restore original environment
    for (const key of Object.keys(config)) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key]
      } else {
        delete process.env[key]
      }
    }
  }
}

/**
 * Get human-readable configuration summary
 */
export function getConfigurationSummary(): string {
  const status = getSupavisorConfigurationStatus()
  const variables = getEnvironmentVariableInfo()
  
  const lines: string[] = []
  lines.push(`Supavisor Configuration Status: ${status.summary}`)
  lines.push('')
  
  if (status.hasErrors) {
    lines.push('❌ Errors:')
    const { validation } = parseSupavisorEnvironmentVariables()
    for (const error of validation.errors) {
      lines.push(`   • ${error.field}: ${error.message}`)
    }
    lines.push('')
  }
  
  if (status.hasWarnings) {
    lines.push('⚠️  Warnings:')
    const { validation } = parseSupavisorEnvironmentVariables()
    for (const warning of validation.warnings) {
      lines.push(`   • ${warning.field}: ${warning.message}`)
    }
    lines.push('')
  }
  
  lines.push('Environment Variables:')
  for (const variable of variables) {
    const status = variable.isSet ? '✓' : (variable.isRequired ? '❌' : '○')
    const value = variable.isSet ? variable.value : `(default: ${variable.defaultValue || 'none'})`
    lines.push(`   ${status} ${variable.name}: ${value}`)
  }
  
  return lines.join('\n')
}

/**
 * Export all parsing functions for convenience
 */
export {
  parseSupavisorEnvironmentVariables,
  formatValidationErrors,
  isSupavisorEnvironmentConfigured,
  getDefaultSupavisorConfiguration,
  SUPAVISOR_ENV_SCHEMA
} from './supavisor-environment-parser'