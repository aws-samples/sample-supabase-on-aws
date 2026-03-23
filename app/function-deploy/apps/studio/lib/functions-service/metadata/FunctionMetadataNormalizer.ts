import { FunctionMetadata } from '../storage/StorageBackend'

/**
 * Deployment source types
 */
export type DeploymentSource = 'ui' | 'api' | 'unknown'

/**
 * Enhanced function metadata with deployment source tracking
 */
export interface NormalizedFunctionMetadata extends FunctionMetadata {
  /** Source of deployment (ui, api, or unknown) */
  deploymentSource: DeploymentSource
  /** Whether metadata was successfully normalized */
  normalized: boolean
  /** Original metadata before normalization (for debugging) */
  originalMetadata?: any
}

/**
 * Metadata normalization options
 */
export interface NormalizationOptions {
  /** Whether to include original metadata for debugging */
  includeOriginal?: boolean
  /** Default values to use for missing fields */
  defaults?: Partial<FunctionMetadata>
  /** Whether to validate normalized metadata */
  validate?: boolean
}

/**
 * Metadata validation result
 */
export interface ValidationResult {
  /** Whether the metadata is valid */
  valid: boolean
  /** Validation errors */
  errors: string[]
  /** Validation warnings */
  warnings: string[]
}

/**
 * Function Metadata Normalizer
 * 
 * Handles different metadata formats from UI vs API deployments and ensures
 * consistent display regardless of deployment method. Provides deployment
 * source detection and tracking capabilities.
 */
export class FunctionMetadataNormalizer {
  private defaultOptions: NormalizationOptions = {
    includeOriginal: false,
    validate: true,
    defaults: {
      version: '1.0.0',
      runtime: 'deno',
      entrypoint: 'index.ts',
      description: '',
    },
  }

  /**
   * Normalize function metadata for consistent display
   * 
   * @param rawMetadata - Raw metadata from storage or API
   * @param options - Normalization options
   * @returns Normalized function metadata
   */
  normalize(
    rawMetadata: any, 
    options: NormalizationOptions = {}
  ): NormalizedFunctionMetadata {
    const opts = { ...this.defaultOptions, ...options }
    
    try {
      // Handle null or undefined metadata
      if (!rawMetadata) {
        throw new Error('Metadata is null or undefined')
      }

      // Extract and normalize core fields
      const normalized = this.extractCoreFields(rawMetadata, opts.defaults)
      
      // Detect deployment source
      const deploymentSource = this.detectDeploymentSource(rawMetadata)
      
      // Create normalized metadata
      const result: NormalizedFunctionMetadata = {
        ...normalized,
        deploymentSource,
        normalized: true,
      }
      
      // Include original metadata if requested
      if (opts.includeOriginal) {
        result.originalMetadata = rawMetadata
      }
      
      // Validate if requested
      if (opts.validate) {
        const validation = this.validate(result)
        if (!validation.valid) {
          console.warn(`Metadata validation failed for function '${result.slug}':`, validation.errors)
        }
        if (validation.warnings.length > 0) {
          console.warn(`Metadata validation warnings for function '${result.slug}':`, validation.warnings)
        }
      }
      
      return result
      
    } catch (error) {
      console.error('Failed to normalize metadata:', error)
      
      // Return fallback metadata
      return this.createFallbackMetadata(rawMetadata, options)
    }
  }

  /**
   * Normalize multiple function metadata objects
   * 
   * @param metadataArray - Array of raw metadata objects
   * @param options - Normalization options
   * @returns Array of normalized metadata
   */
  normalizeMany(
    metadataArray: any[], 
    options: NormalizationOptions = {}
  ): NormalizedFunctionMetadata[] {
    return metadataArray.map((metadata, index) => {
      try {
        return this.normalize(metadata, options)
      } catch (error) {
        console.error(`Failed to normalize metadata at index ${index}:`, error)
        return this.createFallbackMetadata(metadata, options, `function-${index}`)
      }
    })
  }

  /**
   * Extract core fields from raw metadata
   * 
   * @param rawMetadata - Raw metadata object
   * @param defaults - Default values for missing fields
   * @returns Core function metadata fields
   */
  private extractCoreFields(rawMetadata: any, defaults?: Partial<FunctionMetadata>): FunctionMetadata {
    // Handle different field name variations for slug/id
    const slug = this.extractField(rawMetadata, [
      'slug', 'id', 'name', 'functionId', 'function_id'
    ]) || 'unknown'
    
    // Handle different field name variations for name
    const name = this.extractField(rawMetadata, [
      'name', 'displayName', 'display_name', 'title', 'slug', 'id'
    ]) || slug
    
    // Handle description variations
    const description = this.extractField(rawMetadata, [
      'description', 'desc', 'summary', 'details'
    ]) || defaults?.description || ''
    
    // Handle version variations
    const version = this.extractField(rawMetadata, [
      'version', 'ver', 'versionNumber', 'version_number'
    ]) || defaults?.version || '1.0.0'
    
    // Handle runtime variations
    const runtime = this.extractField(rawMetadata, [
      'runtime', 'engine', 'platform'
    ]) || defaults?.runtime || 'deno'
    
    // Handle entrypoint variations
    const entrypoint = this.extractField(rawMetadata, [
      'entrypoint', 'entry', 'main', 'mainFile', 'main_file', 'index'
    ]) || defaults?.entrypoint || 'index.ts'
    
    // Handle timestamp variations
    const createdAt = this.normalizeTimestamp(
      this.extractField(rawMetadata, [
        'createdAt', 'created_at', 'createdTime', 'created_time', 
        'created', 'dateCreated', 'date_created'
      ])
    )
    
    const updatedAt = this.normalizeTimestamp(
      this.extractField(rawMetadata, [
        'updatedAt', 'updated_at', 'updatedTime', 'updated_time',
        'updated', 'modified', 'modifiedAt', 'modified_at',
        'lastModified', 'last_modified', 'dateModified', 'date_modified'
      ]) || createdAt // Fallback to createdAt if updatedAt is not available
    )
    
    // Handle project reference variations
    const projectRef = this.extractField(rawMetadata, [
      'projectRef', 'project_ref', 'projectId', 'project_id',
      'project', 'projectReference', 'project_reference'
    ]) || ''
    
    // Handle user ID variations
    const userId = this.extractField(rawMetadata, [
      'userId', 'user_id', 'ownerId', 'owner_id',
      'createdBy', 'created_by', 'author', 'authorId', 'author_id'
    ]) || 'unknown'
    
    return {
      slug,
      name,
      description,
      version,
      runtime: runtime as 'deno', // Type assertion since we validate this is 'deno'
      entrypoint,
      createdAt: new Date(createdAt),
      updatedAt: new Date(updatedAt),
      projectRef,
      userId,
    }
  }

  /**
   * Extract field value from object using multiple possible field names
   * 
   * @param obj - Object to extract from
   * @param fieldNames - Array of possible field names to try
   * @returns First non-empty value found, or undefined
   */
  private extractField(obj: any, fieldNames: string[]): any {
    if (!obj || typeof obj !== 'object') {
      return undefined
    }
    
    for (const fieldName of fieldNames) {
      const value = obj[fieldName]
      if (value !== undefined && value !== null && value !== '') {
        return value
      }
    }
    
    return undefined
  }

  /**
   * Detect deployment source based on metadata patterns
   * 
   * @param metadata - Raw metadata object
   * @returns Detected deployment source
   */
  detectDeploymentSource(metadata: any): DeploymentSource {
    if (!metadata || typeof metadata !== 'object') {
      return 'unknown'
    }
    
    // Check explicit deployment source markers
    const explicitSource = this.extractField(metadata, [
      'deploymentSource', 'deployment_source', 'source'
    ])
    
    if (explicitSource) {
      const normalized = explicitSource.toLowerCase()
      if (['ui', 'studio', 'web', 'browser'].includes(normalized)) {
        return 'ui'
      }
      if (['api', 'rest', 'cli', 'curl'].includes(normalized)) {
        return 'api'
      }
    }
    
    // Check for UI-specific indicators
    const uiIndicators = [
      'studioVersion', 'studio_version', 'deployedViaStudio', 'deployed_via_studio',
      'deployedFromStudio', 'deployed_from_studio', 'browserDeployment', 'browser_deployment'
    ]
    
    if (uiIndicators.some(indicator => this.extractField(metadata, [indicator]))) {
      return 'ui'
    }
    
    // Check for API-specific indicators
    const apiIndicators = [
      'apiVersion', 'api_version', 'deployedViaAPI', 'deployed_via_api',
      'deployedFromAPI', 'deployed_from_api', 'cliDeployment', 'cli_deployment',
      'restDeployment', 'rest_deployment'
    ]
    
    if (apiIndicators.some(indicator => this.extractField(metadata, [indicator]))) {
      return 'api'
    }
    
    // Check deployment method field
    const deploymentMethod = this.extractField(metadata, [
      'deploymentMethod', 'deployment_method', 'method'
    ])
    
    if (deploymentMethod) {
      const normalized = deploymentMethod.toLowerCase()
      if (['studio', 'ui', 'web', 'browser'].includes(normalized)) {
        return 'ui'
      }
      if (['api', 'rest', 'cli', 'curl', 'command-line'].includes(normalized)) {
        return 'api'
      }
    }
    
    // Check user agent patterns
    const userAgent = this.extractField(metadata, [
      'userAgent', 'user_agent', 'clientInfo', 'client_info'
    ])
    
    if (userAgent && typeof userAgent === 'string') {
      const ua = userAgent.toLowerCase()
      if (ua.includes('studio') || ua.includes('browser') || ua.includes('mozilla')) {
        return 'ui'
      }
      if (ua.includes('curl') || ua.includes('api') || ua.includes('cli')) {
        return 'api'
      }
    }
    
    // Check for client type indicators
    const clientType = this.extractField(metadata, [
      'clientType', 'client_type', 'client'
    ])
    
    if (clientType) {
      const normalized = clientType.toLowerCase()
      if (['ui', 'studio', 'web', 'browser'].includes(normalized)) {
        return 'ui'
      }
      if (['api', 'rest', 'cli'].includes(normalized)) {
        return 'api'
      }
    }
    
    // If no clear indicators found, return unknown
    return 'unknown'
  }

  /**
   * Normalize timestamp to ISO string
   * 
   * @param timestamp - Raw timestamp in various formats
   * @returns ISO string timestamp
   */
  private normalizeTimestamp(timestamp: any): string {
    if (!timestamp) {
      return new Date().toISOString()
    }
    
    // If already a valid ISO string, return as-is
    if (typeof timestamp === 'string' && this.isValidISOString(timestamp)) {
      return timestamp
    }
    
    // If it's a number (Unix timestamp), convert to Date
    if (typeof timestamp === 'number') {
      // Handle both seconds and milliseconds timestamps
      const date = timestamp > 1000000000000 ? new Date(timestamp) : new Date(timestamp * 1000)
      if (!isNaN(date.getTime())) {
        return date.toISOString()
      }
    }
    
    // If it's a string, try to parse as Date
    if (typeof timestamp === 'string') {
      try {
        const date = new Date(timestamp)
        if (!isNaN(date.getTime())) {
          return date.toISOString()
        }
      } catch (error) {
        console.warn('Failed to parse timestamp:', timestamp)
      }
    }
    
    // If it's already a Date object
    if (timestamp instanceof Date && !isNaN(timestamp.getTime())) {
      return timestamp.toISOString()
    }
    
    // Fallback to current time
    console.warn('Could not normalize timestamp, using current time:', timestamp)
    return new Date().toISOString()
  }

  /**
   * Check if a string is a valid ISO timestamp
   * 
   * @param str - String to check
   * @returns True if valid ISO string
   */
  private isValidISOString(str: string): boolean {
    try {
      const date = new Date(str)
      return date.toISOString() === str
    } catch {
      return false
    }
  }

  /**
   * Validate normalized metadata
   * 
   * @param metadata - Normalized metadata to validate
   * @returns Validation result
   */
  validate(metadata: NormalizedFunctionMetadata): ValidationResult {
    const errors: string[] = []
    const warnings: string[] = []
    
    // Required field validation
    if (!metadata.slug || metadata.slug.trim().length === 0) {
      errors.push('Function slug is required')
    } else if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(metadata.slug)) {
      errors.push('Function slug must contain only lowercase letters, numbers, hyphens, and underscores')
    }
    
    if (!metadata.name || metadata.name.trim().length === 0) {
      errors.push('Function name is required')
    }
    
    if (!metadata.version || metadata.version.trim().length === 0) {
      errors.push('Function version is required')
    }
    
    if (!metadata.userId || metadata.userId.trim().length === 0) {
      warnings.push('User ID is missing or empty')
    }
    
    if (!metadata.projectRef || metadata.projectRef.trim().length === 0) {
      warnings.push('Project reference is missing or empty')
    }
    
    // Runtime validation
    if (metadata.runtime !== 'deno') {
      warnings.push(`Unsupported runtime '${metadata.runtime}', expected 'deno'`)
    }
    
    // Timestamp validation
    try {
      new Date(metadata.createdAt)
    } catch {
      errors.push('Invalid createdAt timestamp')
    }
    
    try {
      new Date(metadata.updatedAt)
    } catch {
      errors.push('Invalid updatedAt timestamp')
    }
    
    // Entrypoint validation
    if (!metadata.entrypoint || metadata.entrypoint.trim().length === 0) {
      warnings.push('Entrypoint is missing, using default')
    } else if (!metadata.entrypoint.endsWith('.ts') && !metadata.entrypoint.endsWith('.js')) {
      warnings.push('Entrypoint should be a TypeScript (.ts) or JavaScript (.js) file')
    }
    
    // Deployment source validation
    if (!['ui', 'api', 'unknown'].includes(metadata.deploymentSource)) {
      warnings.push(`Unknown deployment source '${metadata.deploymentSource}'`)
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /**
   * Create fallback metadata when normalization fails
   * 
   * @param rawMetadata - Original raw metadata
   * @param options - Normalization options
   * @param fallbackSlug - Fallback slug to use
   * @returns Fallback normalized metadata
   */
  private createFallbackMetadata(
    rawMetadata: any, 
    options: NormalizationOptions = {},
    fallbackSlug?: string
  ): NormalizedFunctionMetadata {
    const slug = fallbackSlug || 
                 (rawMetadata?.slug || rawMetadata?.id || rawMetadata?.name) || 
                 'unknown-function'
    
    const now = new Date().toISOString()
    
    const fallback: NormalizedFunctionMetadata = {
      slug,
      name: rawMetadata?.name || slug,
      description: 'Metadata normalization failed',
      version: '1.0.0',
      runtime: 'deno',
      entrypoint: 'index.ts',
      createdAt: new Date(now),
      updatedAt: new Date(now),
      projectRef: rawMetadata?.projectRef || rawMetadata?.project_ref || '',
      userId: rawMetadata?.userId || rawMetadata?.user_id || 'unknown',
      deploymentSource: 'unknown',
      normalized: false,
    }
    
    if (options.includeOriginal) {
      fallback.originalMetadata = rawMetadata
    }
    
    return fallback
  }

  /**
   * Get deployment source statistics for an array of metadata
   * 
   * @param metadataArray - Array of normalized metadata
   * @returns Deployment source statistics
   */
  getDeploymentSourceStats(metadataArray: NormalizedFunctionMetadata[]): {
    total: number
    ui: number
    api: number
    unknown: number
    percentages: {
      ui: number
      api: number
      unknown: number
    }
  } {
    const total = metadataArray.length
    const ui = metadataArray.filter(m => m.deploymentSource === 'ui').length
    const api = metadataArray.filter(m => m.deploymentSource === 'api').length
    const unknown = metadataArray.filter(m => m.deploymentSource === 'unknown').length
    
    return {
      total,
      ui,
      api,
      unknown,
      percentages: {
        ui: total > 0 ? Math.round((ui / total) * 100) : 0,
        api: total > 0 ? Math.round((api / total) * 100) : 0,
        unknown: total > 0 ? Math.round((unknown / total) * 100) : 0,
      },
    }
  }
}

/**
 * Singleton instance
 */
let metadataNormalizer: FunctionMetadataNormalizer | null = null

/**
 * Get the singleton FunctionMetadataNormalizer instance
 */
export function getMetadataNormalizer(): FunctionMetadataNormalizer {
  if (!metadataNormalizer) {
    metadataNormalizer = new FunctionMetadataNormalizer()
  }
  return metadataNormalizer
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetMetadataNormalizer(): void {
  metadataNormalizer = null
}

/**
 * Convenience function to normalize a single metadata object
 */
export function normalizeMetadata(
  rawMetadata: any, 
  options?: NormalizationOptions
): NormalizedFunctionMetadata {
  const normalizer = getMetadataNormalizer()
  return normalizer.normalize(rawMetadata, options)
}

/**
 * Convenience function to normalize multiple metadata objects
 */
export function normalizeMetadataArray(
  metadataArray: any[], 
  options?: NormalizationOptions
): NormalizedFunctionMetadata[] {
  const normalizer = getMetadataNormalizer()
  return normalizer.normalizeMany(metadataArray, options)
}