/**
 * Deno Runtime Configuration Utilities
 * 
 * Provides utilities for configuring Deno runtime from environment variables
 * and validating Deno runtime configuration.
 */

import { DenoRuntimeConfig, DenoPermissions } from './DenoRuntimeService'

/**
 * Load Deno runtime configuration from environment variables
 * 
 * @returns Deno runtime configuration
 */
export function loadDenoRuntimeConfigFromEnv(): DenoRuntimeConfig {
  const config: DenoRuntimeConfig = {}

  // Deno executable path
  if (process.env.DENO_PATH) {
    config.denoPath = process.env.DENO_PATH
  }

  // Temporary directory
  if (process.env.EDGE_FUNCTIONS_TEMP_DIR) {
    config.tempDir = process.env.EDGE_FUNCTIONS_TEMP_DIR
  }

  // Cache directory
  if (process.env.EDGE_FUNCTIONS_CACHE_DIR || process.env.DENO_DIR) {
    config.cacheDir = process.env.EDGE_FUNCTIONS_CACHE_DIR || process.env.DENO_DIR
  }

  // Execution timeout
  if (process.env.EDGE_FUNCTIONS_EXECUTION_TIMEOUT) {
    const timeout = parseInt(process.env.EDGE_FUNCTIONS_EXECUTION_TIMEOUT, 10)
    if (!isNaN(timeout) && timeout > 0) {
      config.executionTimeout = timeout
    }
  }

  // Type checking
  if (process.env.EDGE_FUNCTIONS_TYPE_CHECK) {
    config.typeCheck = process.env.EDGE_FUNCTIONS_TYPE_CHECK.toLowerCase() === 'true'
  }

  // Permissions
  config.permissions = loadDenoPermissionsFromEnv()

  return config
}

/**
 * Load Deno permissions from environment variables
 * 
 * @returns Deno permissions configuration
 */
export function loadDenoPermissionsFromEnv(): DenoPermissions {
  const permissions: DenoPermissions = {}

  // Network permissions
  if (process.env.DENO_ALLOW_NET !== undefined) {
    if (process.env.DENO_ALLOW_NET === 'true' || process.env.DENO_ALLOW_NET === '') {
      permissions.allowNet = true
    } else if (process.env.DENO_ALLOW_NET === 'false') {
      permissions.allowNet = false
    } else {
      // Parse comma-separated list of allowed hosts
      permissions.allowNet = process.env.DENO_ALLOW_NET.split(',').map(host => host.trim())
    }
  }

  // Read permissions
  if (process.env.DENO_ALLOW_READ !== undefined) {
    if (process.env.DENO_ALLOW_READ === 'true' || process.env.DENO_ALLOW_READ === '') {
      permissions.allowRead = true
    } else if (process.env.DENO_ALLOW_READ === 'false') {
      permissions.allowRead = false
    } else {
      // Parse comma-separated list of allowed paths
      permissions.allowRead = process.env.DENO_ALLOW_READ.split(',').map(path => path.trim())
    }
  }

  // Write permissions
  if (process.env.DENO_ALLOW_WRITE !== undefined) {
    if (process.env.DENO_ALLOW_WRITE === 'true' || process.env.DENO_ALLOW_WRITE === '') {
      permissions.allowWrite = true
    } else if (process.env.DENO_ALLOW_WRITE === 'false') {
      permissions.allowWrite = false
    } else {
      // Parse comma-separated list of allowed paths
      permissions.allowWrite = process.env.DENO_ALLOW_WRITE.split(',').map(path => path.trim())
    }
  }

  // Environment permissions
  if (process.env.DENO_ALLOW_ENV !== undefined) {
    if (process.env.DENO_ALLOW_ENV === 'true' || process.env.DENO_ALLOW_ENV === '') {
      permissions.allowEnv = true
    } else if (process.env.DENO_ALLOW_ENV === 'false') {
      permissions.allowEnv = false
    } else {
      // Parse comma-separated list of allowed environment variables
      permissions.allowEnv = process.env.DENO_ALLOW_ENV.split(',').map(env => env.trim())
    }
  }

  // Run permissions
  if (process.env.DENO_ALLOW_RUN !== undefined) {
    if (process.env.DENO_ALLOW_RUN === 'true' || process.env.DENO_ALLOW_RUN === '') {
      permissions.allowRun = true
    } else if (process.env.DENO_ALLOW_RUN === 'false') {
      permissions.allowRun = false
    } else {
      // Parse comma-separated list of allowed commands
      permissions.allowRun = process.env.DENO_ALLOW_RUN.split(',').map(cmd => cmd.trim())
    }
  }

  return permissions
}

/**
 * Validate Deno runtime configuration
 * 
 * @param config - Deno runtime configuration to validate
 * @returns Validation result
 */
export function validateDenoRuntimeConfig(config: DenoRuntimeConfig): {
  valid: boolean
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []

  // Validate execution timeout
  if (config.executionTimeout !== undefined) {
    if (config.executionTimeout <= 0) {
      errors.push('Execution timeout must be greater than 0')
    } else if (config.executionTimeout < 1000) {
      warnings.push('Execution timeout is very low (< 1 second), functions may timeout frequently')
    } else if (config.executionTimeout > 300000) {
      warnings.push('Execution timeout is very high (> 5 minutes), consider reducing for better performance')
    }
  }

  // Validate paths
  if (config.tempDir !== undefined) {
    if (!config.tempDir.startsWith('/')) {
      errors.push('Temporary directory must be an absolute path')
    }
  }

  if (config.cacheDir !== undefined) {
    if (!config.cacheDir.startsWith('/')) {
      errors.push('Cache directory must be an absolute path')
    }
  }

  // Validate permissions
  if (config.permissions) {
    const perms = config.permissions

    // Check for overly permissive settings
    if (perms.allowWrite === true) {
      warnings.push('Allowing unrestricted write access may be a security risk')
    }

    if (perms.allowRun === true) {
      warnings.push('Allowing unrestricted subprocess execution may be a security risk')
    }

    if (perms.allowEnv === true) {
      warnings.push('Allowing unrestricted environment variable access may expose sensitive data')
    }

    // Validate array permissions
    if (Array.isArray(perms.allowNet)) {
      for (const host of perms.allowNet) {
        if (!host || host.trim().length === 0) {
          errors.push('Network permission hosts cannot be empty')
        }
      }
    }

    if (Array.isArray(perms.allowRead)) {
      for (const path of perms.allowRead) {
        if (!path || path.trim().length === 0) {
          errors.push('Read permission paths cannot be empty')
        }
      }
    }

    if (Array.isArray(perms.allowWrite)) {
      for (const path of perms.allowWrite) {
        if (!path || path.trim().length === 0) {
          errors.push('Write permission paths cannot be empty')
        }
      }
    }

    if (Array.isArray(perms.allowEnv)) {
      for (const env of perms.allowEnv) {
        if (!env || env.trim().length === 0) {
          errors.push('Environment permission variables cannot be empty')
        }
      }
    }

    if (Array.isArray(perms.allowRun)) {
      for (const cmd of perms.allowRun) {
        if (!cmd || cmd.trim().length === 0) {
          errors.push('Run permission commands cannot be empty')
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Get default Deno runtime configuration for self-hosted environments
 * 
 * @returns Default configuration
 */
export function getDefaultDenoRuntimeConfig(): DenoRuntimeConfig {
  return {
    denoPath: 'deno',
    tempDir: '/tmp/edge-functions',
    cacheDir: '/tmp/deno-cache',
    executionTimeout: 30000, // 30 seconds
    typeCheck: true,
    permissions: {
      allowNet: true, // Allow network access for HTTP functions
      allowRead: ['/tmp/edge-functions'], // Only allow reading from function directories
      allowWrite: false, // No write access by default
      allowEnv: ['SUPABASE_URL', 'SUPABASE_ANON_KEY'], // Only allow specific environment variables
      allowRun: false, // No subprocess execution by default
    },
  }
}

/**
 * Merge Deno runtime configurations with defaults
 * 
 * @param config - Configuration to merge
 * @param defaults - Default configuration
 * @returns Merged configuration
 */
export function mergeDenoRuntimeConfig(
  config: DenoRuntimeConfig,
  defaults: DenoRuntimeConfig = getDefaultDenoRuntimeConfig()
): DenoRuntimeConfig {
  return {
    denoPath: config.denoPath ?? defaults.denoPath,
    tempDir: config.tempDir ?? defaults.tempDir,
    cacheDir: config.cacheDir ?? defaults.cacheDir,
    executionTimeout: config.executionTimeout ?? defaults.executionTimeout,
    typeCheck: config.typeCheck ?? defaults.typeCheck,
    permissions: {
      allowNet: config.permissions?.allowNet ?? defaults.permissions?.allowNet,
      allowRead: config.permissions?.allowRead ?? defaults.permissions?.allowRead,
      allowWrite: config.permissions?.allowWrite ?? defaults.permissions?.allowWrite,
      allowEnv: config.permissions?.allowEnv ?? defaults.permissions?.allowEnv,
      allowRun: config.permissions?.allowRun ?? defaults.permissions?.allowRun,
    },
  }
}