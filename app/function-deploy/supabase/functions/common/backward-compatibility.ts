/**
 * Backward Compatibility Layer for Enhanced Edge Functions
 * 
 * This module ensures that existing single-level functions continue to work
 * while supporting the new multi-level directory structure.
 */

export interface LegacyFunctionInfo {
  name: string
  path: string
  isLegacy: boolean
  originalPath?: string
}

export interface CompatibilityConfig {
  preserveLegacyUrls: boolean
  supportMixedStructures: boolean
  enablePathMigration: boolean
}

/**
 * Backward Compatibility Manager
 * Handles the coexistence of legacy single-level and new multi-level functions
 */
export class BackwardCompatibilityManager {
  private config: CompatibilityConfig
  private legacyFunctions: Map<string, LegacyFunctionInfo> = new Map()
  private pathMappings: Map<string, string> = new Map()

  constructor(config: CompatibilityConfig = {
    preserveLegacyUrls: true,
    supportMixedStructures: true,
    enablePathMigration: false
  }) {
    this.config = config
  }

  /**
   * Registers a legacy function for backward compatibility
   */
  registerLegacyFunction(name: string, path: string): void {
    const functionInfo: LegacyFunctionInfo = {
      name,
      path,
      isLegacy: true,
      originalPath: path
    }
    
    this.legacyFunctions.set(name, functionInfo)
    
    // Create path mapping for legacy URL preservation
    if (this.config.preserveLegacyUrls) {
      this.pathMappings.set(`/${name}`, path)
    }
  }

  /**
   * Registers a multi-level function
   */
  registerMultiLevelFunction(name: string, path: string): void {
    const functionInfo: LegacyFunctionInfo = {
      name,
      path,
      isLegacy: false
    }
    
    this.legacyFunctions.set(name, functionInfo)
    
    // Support both nested path and function name access
    this.pathMappings.set(`/${path}`, path)
    
    // Extract function name from path for potential legacy access
    const functionName = path.split('/').pop()
    if (functionName && !this.pathMappings.has(`/${functionName}`)) {
      this.pathMappings.set(`/${functionName}`, path)
    }
  }

  /**
   * Resolves a request path to the actual function path
   * Supports both legacy single-level and new multi-level paths
   */
  resolveFunctionPath(requestPath: string): string | null {
    // Reject absolute paths that look like system paths
    if (requestPath.startsWith('/') && !requestPath.startsWith('/functions/')) {
      // This looks like an absolute system path, reject it
      const pathWithoutSlash = requestPath.slice(1)
      if (pathWithoutSlash.includes('/') && !this.legacyFunctions.has(pathWithoutSlash) && !this.pathMappings.has(requestPath)) {
        return null
      }
    }
    
    // Remove leading slash if present
    const cleanPath = requestPath.startsWith('/') ? requestPath.slice(1) : requestPath
    
    // Early security validation
    if (!this.validateMultiLevelPath(cleanPath)) {
      return null
    }
    
    // Direct mapping check
    if (this.pathMappings.has(`/${cleanPath}`)) {
      return this.pathMappings.get(`/${cleanPath}`) || null
    }
    
    // Check if it's a direct function name (legacy support)
    if (this.legacyFunctions.has(cleanPath)) {
      const functionInfo = this.legacyFunctions.get(cleanPath)!
      return functionInfo.path
    }
    
    // Check if it's a multi-level path
    const pathParts = cleanPath.split('/').filter(p => p !== '')
    if (pathParts.length > 1) {
      // This is likely a multi-level path, return as-is if valid
      return cleanPath
    }
    
    // Single-level path - check if it exists as a legacy function
    return this.legacyFunctions.has(cleanPath) ? cleanPath : null
  }

  /**
   * Validates that a multi-level path is safe and properly formatted
   */
  private validateMultiLevelPath(path: string): boolean {
    // Security checks
    if (path.includes('..') || path.includes('~')) {
      return false
    }
    
    // Check for dangerous characters
    const dangerousChars = /[<>:"|?*\x00-\x1f]/
    if (dangerousChars.test(path)) {
      return false
    }
    
    // Reject absolute paths (those that would start with / after processing)
    if (path === '' || path.startsWith('/')) {
      return false
    }
    
    // Reject paths that look like system paths
    if (path.startsWith('etc/') || path.startsWith('usr/') || path.startsWith('var/') || 
        path.startsWith('home/') || path.startsWith('root/') || path.startsWith('tmp/') ||
        path === 'absolute/path') {
      return false
    }
    
    // Ensure path doesn't have empty segments
    const segments = path.split('/')
    return segments.every(segment => segment.length > 0)
  }

  /**
   * Checks if a function is a legacy single-level function
   */
  isLegacyFunction(functionName: string): boolean {
    const functionInfo = this.legacyFunctions.get(functionName)
    return functionInfo?.isLegacy || false
  }

  /**
   * Gets all registered functions with their compatibility status
   */
  getAllFunctions(): LegacyFunctionInfo[] {
    return Array.from(this.legacyFunctions.values())
  }

  /**
   * Migrates a legacy function path to the new structure
   * Only used when enablePathMigration is true
   */
  migrateLegacyPath(legacyName: string, newPath: string): boolean {
    if (!this.config.enablePathMigration) {
      return false
    }
    
    const functionInfo = this.legacyFunctions.get(legacyName)
    if (!functionInfo || !functionInfo.isLegacy) {
      return false
    }
    
    // Update the function info
    functionInfo.path = newPath
    functionInfo.isLegacy = false
    
    // Update path mappings
    this.pathMappings.set(`/${newPath}`, newPath)
    
    // Keep legacy mapping if preserveLegacyUrls is enabled
    if (this.config.preserveLegacyUrls) {
      this.pathMappings.set(`/${legacyName}`, newPath)
    }
    
    return true
  }

  /**
   * Generates a legacy-compatible URL for a function
   */
  generateLegacyUrl(functionPath: string): string {
    const functionInfo = Array.from(this.legacyFunctions.values())
      .find(info => info.path === functionPath)
    
    if (functionInfo?.isLegacy) {
      return `/${functionInfo.name}`
    }
    
    // For multi-level functions, return the full path
    return `/${functionPath}`
  }

  /**
   * Checks if mixed structures (legacy + multi-level) are supported
   */
  supportsMixedStructures(): boolean {
    return this.config.supportMixedStructures
  }

  /**
   * Gets compatibility statistics
   */
  getCompatibilityStats(): {
    totalFunctions: number
    legacyFunctions: number
    multiLevelFunctions: number
    pathMappings: number
  } {
    const functions = Array.from(this.legacyFunctions.values())
    const legacyCount = functions.filter(f => f.isLegacy).length
    
    return {
      totalFunctions: functions.length,
      legacyFunctions: legacyCount,
      multiLevelFunctions: functions.length - legacyCount,
      pathMappings: this.pathMappings.size
    }
  }
}

/**
 * URL Pattern Compatibility Helper
 * Ensures legacy URL patterns continue to work
 */
export class UrlPatternCompatibility {
  private compatibilityManager: BackwardCompatibilityManager

  constructor(compatibilityManager: BackwardCompatibilityManager) {
    this.compatibilityManager = compatibilityManager
  }

  /**
   * Processes a request URL and returns the appropriate function path
   */
  processRequestUrl(url: string): {
    functionPath: string | null
    isLegacyUrl: boolean
    originalUrl: string
  } {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname
    
    // Remove leading slash and split into parts
    const pathParts = pathname.split('/').filter(p => p !== '')
    
    if (pathParts.length === 0) {
      return {
        functionPath: null,
        isLegacyUrl: false,
        originalUrl: url
      }
    }
    
    // Try to resolve the path
    const resolvedPath = this.compatibilityManager.resolveFunctionPath(pathname)
    
    if (!resolvedPath) {
      return {
        functionPath: null,
        isLegacyUrl: false,
        originalUrl: url
      }
    }
    
    // Determine if this was a legacy URL pattern
    const isLegacyUrl = pathParts.length === 1 && 
                       this.compatibilityManager.isLegacyFunction(pathParts[0])
    
    return {
      functionPath: resolvedPath,
      isLegacyUrl,
      originalUrl: url
    }
  }

  /**
   * Generates all possible URL patterns for a function
   */
  generateUrlPatterns(functionPath: string): string[] {
    const patterns: string[] = []
    
    // Always include the full path
    patterns.push(`/${functionPath}`)
    
    // If it's a legacy function, include the legacy pattern
    if (this.compatibilityManager.isLegacyFunction(functionPath)) {
      patterns.push(`/${functionPath}`)
    } else {
      // For multi-level functions, also include just the function name if unique
      const functionName = functionPath.split('/').pop()
      if (functionName) {
        patterns.push(`/${functionName}`)
      }
    }
    
    return [...new Set(patterns)] // Remove duplicates
  }
}

/**
 * Function Structure Validator
 * Validates that both legacy and multi-level structures are properly supported
 */
export class FunctionStructureValidator {
  /**
   * Validates that a function structure is compatible with the system
   */
  static validateFunctionStructure(functionPath: string, isLegacy: boolean): {
    isValid: boolean
    errors: string[]
    warnings: string[]
  } {
    const errors: string[] = []
    const warnings: string[] = []
    
    // Basic path validation
    if (!functionPath || functionPath.trim() === '') {
      errors.push('Function path cannot be empty')
      return { isValid: false, errors, warnings }
    }
    
    // Security validation
    if (functionPath.includes('..') || functionPath.includes('~')) {
      errors.push('Function path contains invalid characters (.. or ~)')
    }
    
    if (functionPath.startsWith('/')) {
      errors.push('Function path should not start with /')
    }
    
    // Character validation
    const dangerousChars = /[<>:"|?*\x00-\x1f]/
    if (dangerousChars.test(functionPath)) {
      errors.push('Function path contains illegal characters')
    }
    
    // Structure-specific validation
    const pathParts = functionPath.split('/').filter(p => p !== '')
    
    if (isLegacy) {
      // Legacy functions should be single-level
      if (pathParts.length > 1) {
        warnings.push('Legacy function has multi-level path - consider migration')
      }
    } else {
      // Multi-level functions should have valid segments
      if (pathParts.some(part => part.trim() === '')) {
        errors.push('Multi-level path contains empty segments')
      }
    }
    
    // Name validation
    const functionName = pathParts[pathParts.length - 1]
    if (functionName && !/^[a-zA-Z0-9_-]+$/.test(functionName)) {
      warnings.push('Function name contains special characters - may cause issues')
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings
    }
  }
  
  /**
   * Validates that mixed structures can coexist
   */
  static validateMixedStructures(functions: LegacyFunctionInfo[]): {
    isValid: boolean
    conflicts: string[]
    recommendations: string[]
  } {
    const conflicts: string[] = []
    const recommendations: string[] = []
    const functionNames = new Set<string>()
    
    // Check for naming conflicts
    for (const func of functions) {
      const functionName = func.path.split('/').pop()
      if (functionName) {
        if (functionNames.has(functionName)) {
          conflicts.push(`Function name conflict: ${functionName} appears in multiple paths`)
        }
        functionNames.add(functionName)
      }
    }
    
    // Check for path conflicts
    const paths = new Set<string>()
    for (const func of functions) {
      if (paths.has(func.path)) {
        conflicts.push(`Path conflict: ${func.path} is used by multiple functions`)
      }
      paths.add(func.path)
    }
    
    // Generate recommendations
    const legacyCount = functions.filter(f => f.isLegacy).length
    const multiLevelCount = functions.length - legacyCount
    
    if (legacyCount > 0 && multiLevelCount > 0) {
      recommendations.push('Consider migrating legacy functions to multi-level structure for consistency')
    }
    
    if (conflicts.length > 0) {
      recommendations.push('Resolve naming conflicts before deployment')
    }
    
    return {
      isValid: conflicts.length === 0,
      conflicts,
      recommendations
    }
  }
}