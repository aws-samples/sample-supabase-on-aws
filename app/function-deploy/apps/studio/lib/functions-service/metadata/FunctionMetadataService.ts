import { StorageBackend, FunctionMetadata, StorageBackendError, StorageNotFoundError } from '../storage/StorageBackend'
import { getStorageBackend } from '../storage/StorageBackendFactory'

/**
 * Metadata retrieval options
 */
export interface MetadataRetrievalOptions {
  /** Whether to use fallback metadata if retrieval fails */
  useFallback?: boolean
  /** Whether to normalize metadata fields */
  normalize?: boolean
  /** Whether to validate metadata integrity */
  validate?: boolean
}

/**
 * Metadata validation result
 */
export interface MetadataValidationResult {
  /** Whether metadata is valid */
  valid: boolean
  /** Validation errors */
  errors: string[]
  /** Validation warnings */
  warnings: string[]
  /** Normalized metadata */
  normalizedMetadata?: FunctionMetadata
}

/**
 * Enhanced Function Metadata Service
 * 
 * Provides robust metadata parsing, validation, and fallback mechanisms
 * to ensure function names and metadata display correctly on detail pages.
 */
export class FunctionMetadataService {
  private storageBackend: StorageBackend | null = null

  /**
   * Get or initialize the storage backend
   */
  private async getStorageBackend(): Promise<StorageBackend> {
    if (!this.storageBackend) {
      this.storageBackend = await getStorageBackend()
    }
    return this.storageBackend
  }

  /**
   * Get function metadata with robust parsing and fallbacks
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function slug
   * @param options - Retrieval options
   * @returns Function metadata
   */
  async getFunctionMetadata(
    projectRef: string, 
    functionSlug: string,
    options: MetadataRetrievalOptions = {}
  ): Promise<FunctionMetadata> {
    const { useFallback = true, normalize = true, validate = true } = options

    try {
      const storage = await this.getStorageBackend()
      let metadata = await storage.getMetadata(projectRef, functionSlug)
      
      if (!metadata) {
        if (useFallback) {
          console.warn(`Metadata not found for function '${functionSlug}', using fallback`)
          return this.createFallbackMetadata(projectRef, functionSlug)
        } else {
          throw new StorageNotFoundError(`Metadata for function ${functionSlug} in project ${projectRef}`)
        }
      }

      // Validate metadata if requested
      if (validate) {
        const validationResult = this.validateMetadata(metadata, projectRef, functionSlug)
        if (!validationResult.valid) {
          console.warn(`Metadata validation failed for function '${functionSlug}':`, validationResult.errors)
          
          if (validationResult.normalizedMetadata) {
            metadata = validationResult.normalizedMetadata
          } else if (useFallback) {
            return this.createFallbackMetadata(projectRef, functionSlug)
          }
        }
      }

      // Normalize metadata if requested
      if (normalize) {
        metadata = this.normalizeMetadata(metadata, projectRef, functionSlug)
      }

      return metadata

    } catch (error: any) {
      console.error(`Failed to retrieve metadata for function '${functionSlug}':`, error)
      
      if (error instanceof StorageNotFoundError && !useFallback) {
        throw error
      }
      
      if (useFallback) {
        return this.createFallbackMetadata(projectRef, functionSlug)
      }
      
      throw new StorageBackendError(
        `Failed to retrieve function metadata: ${error.message}`,
        'METADATA_RETRIEVAL_ERROR',
        { projectRef, functionSlug, originalError: error }
      )
    }
  }

  /**
   * Validate metadata integrity and completeness
   * 
   * @param metadata - Metadata to validate
   * @param projectRef - Project reference
   * @param functionSlug - Function slug
   * @returns Validation result
   */
  validateMetadata(
    metadata: any, 
    projectRef: string, 
    functionSlug: string
  ): MetadataValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    // Check if metadata is an object
    if (!metadata || typeof metadata !== 'object') {
      errors.push('Metadata must be an object')
      return { valid: false, errors, warnings }
    }

    // Validate required fields
    const requiredFields = ['slug', 'name', 'version', 'runtime', 'projectRef', 'userId']
    for (const field of requiredFields) {
      if (!metadata[field]) {
        if (field === 'slug' || field === 'name') {
          errors.push(`Required field '${field}' is missing`)
        } else {
          warnings.push(`Required field '${field}' is missing, will use fallback`)
        }
      }
    }

    // Validate field types and formats
    if (metadata.slug && typeof metadata.slug !== 'string') {
      errors.push('Slug must be a string')
    }

    if (metadata.name && typeof metadata.name !== 'string') {
      errors.push('Name must be a string')
    }

    if (metadata.version && typeof metadata.version !== 'string') {
      warnings.push('Version should be a string')
    }

    if (metadata.runtime && metadata.runtime !== 'deno') {
      warnings.push(`Unsupported runtime '${metadata.runtime}', expected 'deno'`)
    }

    // Validate slug format if present
    if (metadata.slug && !/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(metadata.slug)) {
      errors.push('Slug format is invalid')
    }

    // Validate dates if present
    if (metadata.createdAt) {
      const createdAt = new Date(metadata.createdAt)
      if (isNaN(createdAt.getTime())) {
        warnings.push('Invalid createdAt date format')
      }
    }

    if (metadata.updatedAt) {
      const updatedAt = new Date(metadata.updatedAt)
      if (isNaN(updatedAt.getTime())) {
        warnings.push('Invalid updatedAt date format')
      }
    }

    // Create normalized metadata if there are warnings but no errors
    let normalizedMetadata: FunctionMetadata | undefined
    if (errors.length === 0) {
      normalizedMetadata = this.normalizeMetadata(metadata, projectRef, functionSlug)
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      normalizedMetadata,
    }
  }

  /**
   * Normalize metadata to ensure all required fields are present and valid
   * 
   * @param metadata - Raw metadata
   * @param projectRef - Project reference
   * @param functionSlug - Function slug
   * @returns Normalized metadata
   */
  normalizeMetadata(
    metadata: any, 
    projectRef: string, 
    functionSlug: string
  ): FunctionMetadata {
    const now = new Date()

    return {
      slug: this.normalizeSlug(metadata.slug, functionSlug),
      name: this.normalizeName(metadata.name, functionSlug),
      description: this.normalizeDescription(metadata.description),
      version: this.normalizeVersion(metadata.version),
      runtime: this.normalizeRuntime(metadata.runtime),
      entrypoint: this.normalizeEntrypoint(metadata.entrypoint),
      projectRef: metadata.projectRef || projectRef,
      userId: metadata.userId || 'unknown',
      createdAt: this.normalizeDate(metadata.createdAt, now),
      updatedAt: this.normalizeDate(metadata.updatedAt, now),
    }
  }

  /**
   * Create fallback metadata when retrieval fails or metadata is corrupted
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function slug
   * @returns Fallback metadata
   */
  createFallbackMetadata(projectRef: string, functionSlug: string): FunctionMetadata {
    const now = new Date()
    
    return {
      slug: functionSlug,
      name: this.generateDisplayName(functionSlug),
      description: 'Function metadata unavailable',
      version: '1.0.0',
      runtime: 'deno',
      entrypoint: 'index.ts',
      projectRef,
      userId: 'unknown',
      createdAt: now,
      updatedAt: now,
    }
  }

  /**
   * Generate a human-readable display name from function slug
   * 
   * @param slug - Function slug
   * @returns Display name
   */
  generateDisplayName(slug: string): string {
    if (!slug || typeof slug !== 'string') {
      return 'Unnamed Function'
    }

    // Convert kebab-case, snake_case, or camelCase to Title Case
    return slug
      .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase to space-separated
      .split(/[-_\s]+/) // Split on hyphens, underscores, or spaces
      .map(word => {
        if (word.length === 0) return ''
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      })
      .filter(word => word.length > 0)
      .join(' ') || 'Unnamed Function'
  }

  /**
   * Handle missing or corrupted metadata gracefully
   * 
   * @param error - Original error
   * @param projectRef - Project reference
   * @param functionSlug - Function slug
   * @returns Graceful degradation result
   */
  handleMetadataError(
    error: any, 
    projectRef: string, 
    functionSlug: string
  ): {
    fallbackMetadata: FunctionMetadata
    errorInfo: {
      code: string
      message: string
      recoverable: boolean
      suggestion: string
    }
  } {
    let errorCode = 'METADATA_ERROR'
    let errorMessage = 'Unknown metadata error'
    let recoverable = true
    let suggestion = 'Try refreshing the page or redeploying the function'

    if (error instanceof StorageNotFoundError) {
      errorCode = 'METADATA_NOT_FOUND'
      errorMessage = 'Function metadata not found'
      suggestion = 'The function may not be properly deployed. Try redeploying the function.'
    } else if (error instanceof StorageBackendError) {
      errorCode = 'STORAGE_ERROR'
      errorMessage = 'Storage backend error while retrieving metadata'
      suggestion = 'Check storage backend configuration and connectivity'
      recoverable = error.code !== 'STORAGE_UNAVAILABLE'
    } else if (error.message.includes('JSON') || error.message.includes('parse')) {
      errorCode = 'METADATA_CORRUPTED'
      errorMessage = 'Function metadata is corrupted or invalid'
      suggestion = 'Redeploy the function to regenerate metadata'
    } else if (error.message.toLowerCase().includes('permission') || error.message.toLowerCase().includes('access')) {
      errorCode = 'METADATA_ACCESS_DENIED'
      errorMessage = 'Access denied to function metadata'
      suggestion = 'Check your permissions for this project and function'
      recoverable = false
    }

    return {
      fallbackMetadata: this.createFallbackMetadata(projectRef, functionSlug),
      errorInfo: {
        code: errorCode,
        message: errorMessage,
        recoverable,
        suggestion,
      }
    }
  }

  /**
   * Normalize slug field
   */
  private normalizeSlug(slug: any, fallback: string): string {
    if (typeof slug === 'string' && slug.trim().length > 0) {
      return slug.trim()
    }
    return fallback
  }

  /**
   * Normalize name field
   */
  private normalizeName(name: any, fallback: string): string {
    if (typeof name === 'string' && name.trim().length > 0) {
      return name.trim()
    }
    return this.generateDisplayName(fallback)
  }

  /**
   * Normalize description field
   */
  private normalizeDescription(description: any): string {
    if (typeof description === 'string') {
      return description.trim()
    }
    return ''
  }

  /**
   * Normalize version field
   */
  private normalizeVersion(version: any): string {
    if (typeof version === 'string' && version.trim().length > 0) {
      return version.trim()
    }
    if (typeof version === 'number') {
      return version.toString()
    }
    return '1.0.0'
  }

  /**
   * Normalize runtime field
   */
  private normalizeRuntime(runtime: any): 'deno' {
    if (runtime === 'deno') {
      return 'deno'
    }
    // Always default to 'deno' for Edge Functions
    return 'deno'
  }

  /**
   * Normalize entrypoint field
   */
  private normalizeEntrypoint(entrypoint: any): string {
    if (typeof entrypoint === 'string' && entrypoint.trim().length > 0) {
      return entrypoint.trim()
    }
    return 'index.ts'
  }

  /**
   * Normalize date field
   */
  private normalizeDate(date: any, fallback: Date): Date {
    if (date instanceof Date && !isNaN(date.getTime())) {
      return date
    }
    
    if (typeof date === 'string') {
      const parsed = new Date(date)
      if (!isNaN(parsed.getTime())) {
        return parsed
      }
    }
    
    if (typeof date === 'number') {
      const parsed = new Date(date)
      if (!isNaN(parsed.getTime())) {
        return parsed
      }
    }
    
    return fallback
  }

  /**
   * Refresh storage backend (useful for testing or configuration changes)
   */
  async refreshStorageBackend(): Promise<void> {
    this.storageBackend = null
  }
}

/**
 * Singleton instance
 */
let functionMetadataService: FunctionMetadataService | null = null

/**
 * Get the singleton FunctionMetadataService instance
 */
export function getFunctionMetadataService(): FunctionMetadataService {
  if (!functionMetadataService) {
    functionMetadataService = new FunctionMetadataService()
  }
  return functionMetadataService
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetFunctionMetadataService(): void {
  functionMetadataService = null
}