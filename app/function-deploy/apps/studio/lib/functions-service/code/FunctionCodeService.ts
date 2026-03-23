import { StorageBackend, FunctionFile, FunctionMetadata, StorageBackendError, StorageNotFoundError } from '../storage/StorageBackend'
import { getStorageBackend } from '../storage/StorageBackendFactory'

/**
 * Function code response with enhanced error handling
 */
export interface FunctionCodeResponse {
  /** Main function code content */
  code: string
  /** All function files */
  files: FunctionFile[]
  /** Function metadata with fallbacks */
  metadata: FunctionMetadata
  /** Import map content if available */
  importMap?: string
  /** Entry point file name */
  entrypoint: string
}

/**
 * Function code error with specific error codes
 */
export class FunctionCodeError extends Error {
  /** Error code for categorization */
  code: string
  /** Additional error details */
  details?: any
  /** Fallback data when possible */
  fallbackData?: Partial<FunctionMetadata>

  constructor(message: string, code: string, details?: any, fallbackData?: Partial<FunctionMetadata>) {
    super(message)
    this.name = 'FunctionCodeError'
    this.code = code
    this.details = details
    this.fallbackData = fallbackData
  }
}

/**
 * Enhanced Function Code Service
 * 
 * Provides robust function code retrieval with proper error handling,
 * fallback mechanisms, and consistent behavior across storage backends.
 */
export class FunctionCodeService {
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
   * Get function code with enhanced error handling and fallbacks
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function slug
   * @returns Function code response with fallbacks
   */
  async getFunctionCode(projectRef: string, functionSlug: string): Promise<FunctionCodeResponse> {
    try {
      const storage = await this.getStorageBackend()
      
      // Get files and metadata in parallel with individual error handling
      const [files, metadata] = await Promise.allSettled([
        storage.retrieve(projectRef, functionSlug),
        this.getFunctionMetadata(projectRef, functionSlug)
      ])

      // Handle files retrieval result
      let functionFiles: FunctionFile[] = []
      if (files.status === 'fulfilled') {
        functionFiles = files.value
      } else {
        console.warn(`Failed to retrieve files for function '${functionSlug}':`, files.reason)
        throw this.createCodeRetrievalError('FUNCTION_FILES_NOT_FOUND', 
          'Function files could not be retrieved', files.reason)
      }

      // Handle metadata retrieval result
      let functionMetadata: FunctionMetadata
      if (metadata.status === 'fulfilled') {
        functionMetadata = metadata.value
      } else {
        console.warn(`Failed to retrieve metadata for function '${functionSlug}':`, metadata.reason)
        // Create fallback metadata
        functionMetadata = this.createFallbackMetadata(projectRef, functionSlug)
      }

      // Find main entry point file
      const entrypoint = functionMetadata.entrypoint || 'index.ts'
      const mainFile = this.findEntryPointFile(functionFiles, entrypoint)
      
      let fallbackFile: FunctionFile | null = null
      if (!mainFile) {
        console.warn(`Entry point file '${entrypoint}' not found for function '${functionSlug}'`)
        // Try common entry point names as fallback
        fallbackFile = this.findFallbackEntryPoint(functionFiles)
        if (!fallbackFile) {
          throw this.createCodeRetrievalError('FUNCTION_ENTRYPOINT_NOT_FOUND',
            `Entry point file '${entrypoint}' not found`, null, {
              availableFiles: functionFiles.map(f => f.name),
              expectedEntrypoint: entrypoint
            })
        }
      }

      // Extract import map if available
      const importMapFile = functionFiles.find(f => f.name === 'import_map.json')
      let importMap: string | undefined
      if (importMapFile) {
        try {
          // Validate import map JSON
          JSON.parse(importMapFile.content)
          importMap = importMapFile.content
        } catch (error) {
          console.warn(`Invalid import map JSON for function '${functionSlug}':`, error)
          // Continue without import map
        }
      }

      const codeContent = mainFile?.content || fallbackFile?.content || ''
      
      return {
        code: codeContent,
        files: functionFiles,
        metadata: functionMetadata,
        importMap,
        entrypoint: mainFile?.name || fallbackFile?.name || entrypoint,
      }

    } catch (error: any) {
      if (error instanceof FunctionCodeError) {
        throw error
      }
      
      throw this.handleCodeRetrievalError(error, projectRef, functionSlug)
    }
  }

  /**
   * Get function metadata with robust fallback handling
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function slug
   * @returns Function metadata with fallbacks
   */
  async getFunctionMetadata(projectRef: string, functionSlug: string): Promise<FunctionMetadata> {
    try {
      const storage = await this.getStorageBackend()
      const metadata = await storage.getMetadata(projectRef, functionSlug)
      
      if (!metadata) {
        console.warn(`Metadata not found for function '${functionSlug}', creating fallback`)
        return this.createFallbackMetadata(projectRef, functionSlug)
      }

      // Validate and normalize metadata
      return this.normalizeMetadata(metadata, projectRef, functionSlug)
      
    } catch (error: any) {
      console.warn(`Failed to retrieve metadata for function '${functionSlug}':`, error)
      
      if (error instanceof StorageNotFoundError) {
        return this.createFallbackMetadata(projectRef, functionSlug)
      }
      
      // For other errors, still return fallback but log the error
      console.error(`Metadata retrieval error for function '${functionSlug}':`, error)
      return this.createFallbackMetadata(projectRef, functionSlug)
    }
  }

  /**
   * Validate function code integrity
   * 
   * @param code - Function code to validate
   * @returns True if code appears valid
   */
  validateCodeIntegrity(code: string): boolean {
    if (!code || typeof code !== 'string') {
      return false
    }

    const trimmedCode = code.trim()
    
    // Check for minimum code length
    if (trimmedCode.length < 10) {
      return false
    }

    // Check for basic JavaScript/TypeScript patterns
    const hasFunction = /(?:function|=>|export|const|let|var)/.test(trimmedCode)
    const hasValidSyntax = !(/^\s*<|^\s*{[\s\S]*}$/.test(trimmedCode)) // Not HTML or pure JSON
    
    return hasFunction && hasValidSyntax
  }

  /**
   * Create fallback metadata when retrieval fails
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function slug
   * @returns Fallback metadata
   */
  private createFallbackMetadata(projectRef: string, functionSlug: string): FunctionMetadata {
    const now = new Date()
    
    return {
      slug: functionSlug,
      name: this.generateFallbackName(functionSlug),
      description: 'Function metadata unavailable - using fallback data',
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
   * Normalize metadata to ensure all required fields are present
   * 
   * @param metadata - Raw metadata
   * @param projectRef - Project reference
   * @param functionSlug - Function slug
   * @returns Normalized metadata
   */
  private normalizeMetadata(
    metadata: FunctionMetadata, 
    projectRef: string, 
    functionSlug: string
  ): FunctionMetadata {
    return {
      slug: metadata.slug || functionSlug,
      name: metadata.name || this.generateFallbackName(functionSlug),
      description: metadata.description || '',
      version: metadata.version || '1.0.0',
      runtime: metadata.runtime || 'deno',
      entrypoint: metadata.entrypoint || 'index.ts',
      projectRef: metadata.projectRef || projectRef,
      userId: metadata.userId || 'unknown',
      createdAt: metadata.createdAt || new Date(),
      updatedAt: metadata.updatedAt || new Date(),
    }
  }

  /**
   * Generate a fallback function name from slug
   * 
   * @param slug - Function slug
   * @returns Human-readable function name
   */
  private generateFallbackName(slug: string): string {
    // Convert kebab-case or snake_case to Title Case
    return slug
      .split(/[-_]/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
  }

  /**
   * Find the entry point file in function files
   * 
   * @param files - Function files
   * @param entrypoint - Expected entry point file name
   * @returns Entry point file or null
   */
  private findEntryPointFile(files: FunctionFile[], entrypoint: string): FunctionFile | null {
    // Try exact match first
    let file = files.find(f => f.name === entrypoint || f.path === entrypoint)
    if (file) return file

    // Try without extension
    const nameWithoutExt = entrypoint.replace(/\.[^.]+$/, '')
    file = files.find(f => 
      f.name === nameWithoutExt || 
      f.path === nameWithoutExt ||
      f.name.replace(/\.[^.]+$/, '') === nameWithoutExt
    )
    if (file) return file

    return null
  }

  /**
   * Find fallback entry point when specified entry point is not found
   * 
   * @param files - Function files
   * @returns Fallback entry point file or null
   */
  private findFallbackEntryPoint(files: FunctionFile[]): FunctionFile | null {
    // Common entry point names in order of preference
    const commonEntryPoints = [
      'index.ts', 'index.js', 'main.ts', 'main.js', 
      'handler.ts', 'handler.js', 'function.ts', 'function.js'
    ]

    for (const entryPoint of commonEntryPoints) {
      const file = files.find(f => f.name === entryPoint || f.path === entryPoint)
      if (file) return file
    }

    // If no common entry points found, return the first TypeScript or JavaScript file
    return files.find(f => /\.(ts|js)$/.test(f.name)) || files[0] || null
  }

  /**
   * Create a specific function code error
   * 
   * @param code - Error code
   * @param message - Error message
   * @param originalError - Original error
   * @param details - Additional details
   * @returns Function code error
   */
  private createCodeRetrievalError(
    code: string, 
    message: string, 
    originalError?: any,
    details?: any
  ): FunctionCodeError {
    return new FunctionCodeError(message, code, {
      ...details,
      originalError: originalError?.message || originalError,
    })
  }

  /**
   * Handle code retrieval errors with specific error categorization
   * 
   * @param error - Original error
   * @param projectRef - Project reference
   * @param functionSlug - Function slug
   * @returns Categorized function code error
   */
  private handleCodeRetrievalError(
    error: any, 
    projectRef: string, 
    functionSlug: string
  ): FunctionCodeError {
    if (error instanceof StorageNotFoundError) {
      return new FunctionCodeError(
        `Function '${functionSlug}' not found in project '${projectRef}'`,
        'FUNCTION_NOT_FOUND',
        {
          projectRef,
          functionSlug,
          suggestion: 'Verify the function name and ensure it has been deployed',
          originalError: error.message
        }
      )
    }

    if (error instanceof StorageBackendError) {
      if (error.message.includes('permission') || error.message.includes('access')) {
        return new FunctionCodeError(
          `Access denied to function '${functionSlug}' in project '${projectRef}'`,
          'FUNCTION_ACCESS_DENIED',
          {
            projectRef,
            functionSlug,
            suggestion: 'Check your permissions for this project and function',
            originalError: error.message
          }
        )
      }

      if (error.message.includes('storage') || error.message.includes('backend')) {
        return new FunctionCodeError(
          'Storage backend is unavailable or misconfigured',
          'STORAGE_BACKEND_ERROR',
          {
            projectRef,
            functionSlug,
            storageType: error.details?.storageType || 'unknown',
            suggestion: 'Check storage backend configuration and connectivity',
            originalError: error.message
          }
        )
      }
    }

    if (error.message.includes('timeout')) {
      return new FunctionCodeError(
        `Function retrieval timed out for '${functionSlug}'`,
        'FUNCTION_RETRIEVAL_TIMEOUT',
        {
          projectRef,
          functionSlug,
          suggestion: 'Try again or check storage backend performance',
          originalError: error.message
        }
      )
    }

    if (error.message.includes('network') || error.message.includes('connection')) {
      return new FunctionCodeError(
        'Network error while retrieving function code',
        'NETWORK_ERROR',
        {
          projectRef,
          functionSlug,
          suggestion: 'Check network connectivity and storage backend availability',
          originalError: error.message
        }
      )
    }

    // Generic error
    return new FunctionCodeError(
      `Failed to retrieve function code: ${error.message}`,
      'FUNCTION_RETRIEVAL_ERROR',
      {
        projectRef,
        functionSlug,
        suggestion: 'Check function deployment status and storage backend health',
        originalError: error.message
      }
    )
  }

  /**
   * Refresh storage backend (useful for testing or configuration changes)
   */
  async refreshStorageBackend(): Promise<void> {
    this.storageBackend = null
  }

  /**
   * Get storage backend type for diagnostics
   */
  async getStorageBackendType(): Promise<string> {
    try {
      const storage = await this.getStorageBackend()
      return storage.getType()
    } catch (error) {
      return 'unknown'
    }
  }
}

/**
 * Singleton instance
 */
let functionCodeService: FunctionCodeService | null = null

/**
 * Get the singleton FunctionCodeService instance
 */
export function getFunctionCodeService(): FunctionCodeService {
  if (!functionCodeService) {
    functionCodeService = new FunctionCodeService()
  }
  return functionCodeService
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetFunctionCodeService(): void {
  functionCodeService = null
}