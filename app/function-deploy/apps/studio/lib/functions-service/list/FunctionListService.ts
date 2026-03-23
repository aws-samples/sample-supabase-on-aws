import { StorageBackend, FunctionMetadata, StorageBackendError, StorageNotFoundError } from '../storage/StorageBackend'
import { getStorageBackend } from '../storage/StorageBackendFactory'
import { FunctionCodeService } from '../code/FunctionCodeService'
import { 
  FunctionMetadataNormalizer, 
  NormalizedFunctionMetadata, 
  DeploymentSource,
  getMetadataNormalizer 
} from '../metadata/FunctionMetadataNormalizer'
import { 
  FunctionListErrorHandler, 
  FunctionListError as ListError, 
  getFunctionListErrorHandler 
} from './FunctionListErrorHandler'

/**
 * Function list synchronization result
 */
export interface SyncResult {
  /** Total number of functions found */
  totalFunctions: number
  /** Number of functions deployed via UI */
  uiDeployed: number
  /** Number of functions deployed via API */
  apiDeployed: number
  /** Number of functions with unknown deployment source */
  unknownSource: number
  /** Any errors encountered during synchronization */
  errors: string[]
  /** Timestamp of last synchronization */
  lastSync: string
  /** Functions that failed to load metadata */
  failedMetadata: string[]
}

/**
 * Function list error information
 */
export interface FunctionListError {
  /** Error code */
  code: string
  /** Human-readable error message */
  message: string
  /** Whether the error is retryable */
  retryable: boolean
  /** Suggested retry delay in milliseconds */
  retryAfter?: number
  /** Additional error details */
  details?: Record<string, any>
}

/**
 * Enhanced function metadata with deployment source information
 */
export interface EnhancedFunctionMetadata extends NormalizedFunctionMetadata {
  /** Whether metadata was successfully loaded */
  metadataLoaded: boolean
  /** Any metadata loading errors */
  metadataError?: string
}

/**
 * Function List Service
 * 
 * Handles function listing and synchronization across different deployment sources.
 * Ensures API-deployed functions appear in Studio interface and provides consistent
 * metadata normalization regardless of deployment method.
 */
export class FunctionListService {
  private storageBackend: StorageBackend | null = null
  private codeService: FunctionCodeService | null = null
  private metadataNormalizer: FunctionMetadataNormalizer
  private errorHandler: FunctionListErrorHandler

  constructor() {
    // Services will be initialized lazily
    this.metadataNormalizer = getMetadataNormalizer()
    this.errorHandler = getFunctionListErrorHandler()
  }

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
   * Get or initialize the function code service
   */
  private async getCodeService(): Promise<FunctionCodeService> {
    if (!this.codeService) {
      this.codeService = new FunctionCodeService()
    }
    return this.codeService
  }

  /**
   * Get all functions for a project with enhanced metadata
   * 
   * @param projectRef - Project reference
   * @returns Array of enhanced function metadata
   */
  async getAllFunctions(projectRef: string): Promise<EnhancedFunctionMetadata[]> {
    return this.errorHandler.executeWithRetry(async () => {
      const storage = await this.getStorageBackend()
      const codeService = await this.getCodeService()
      
      // Get basic function list from storage
      const functions = await storage.list(projectRef)
      
      // Enhance each function with normalized metadata and deployment source
      const enhancedFunctions = await Promise.allSettled(
        functions.map(async (func): Promise<EnhancedFunctionMetadata> => {
          try {
            // Get detailed metadata using code service (with fallbacks)
            const metadata = await codeService.getFunctionMetadata(projectRef, func.slug)
            
            // Normalize and enhance the metadata using the metadata normalizer
            const normalized = this.metadataNormalizer.normalize(metadata, {
              includeOriginal: false,
              validate: true,
            })
            
            return {
              ...normalized,
              metadataLoaded: true,
            }
          } catch (error) {
            // Handle metadata loading error with enhanced error handler
            const metadataError = this.errorHandler.handleMetadataError(error, func.slug, {
              projectRef,
              operation: 'getAllFunctions',
            })
            
            console.warn(`Failed to load metadata for function '${func.slug}':`, metadataError.message)
            
            const fallbackMetadata = this.metadataNormalizer.normalize({
              ...func,
              name: func.name || func.slug,
              description: func.description || 'Metadata unavailable',
            }, {
              includeOriginal: false,
              validate: false, // Skip validation for fallback metadata
            })
            
            return {
              ...fallbackMetadata,
              metadataLoaded: false,
              metadataError: metadataError.message,
            }
          }
        })
      )
      
      // Extract successful results and log any failures
      const results: EnhancedFunctionMetadata[] = []
      const failures: string[] = []
      
      enhancedFunctions.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value)
        } else {
          const functionSlug = functions[index]?.slug || `function-${index}`
          failures.push(`${functionSlug}: ${result.reason}`)
          console.error(`Failed to process function ${functionSlug}:`, result.reason)
        }
      })
      
      if (failures.length > 0) {
        console.warn(`Failed to process ${failures.length} functions:`, failures)
      }
      
      return results
    }, `get all functions for project '${projectRef}'`)
  }

  /**
   * Synchronize function list and return statistics
   * 
   * @param projectRef - Project reference
   * @returns Synchronization result with statistics
   */
  async syncFunctionList(projectRef: string): Promise<SyncResult> {
    return this.errorHandler.executeWithRetry(async () => {
      const functions = await this.getAllFunctions(projectRef)
      
      // Categorize functions by deployment source
      const uiDeployed = functions.filter(f => f.deploymentSource === 'ui').length
      const apiDeployed = functions.filter(f => f.deploymentSource === 'api').length
      const unknownSource = functions.filter(f => f.deploymentSource === 'unknown').length
      
      // Collect functions that failed to load metadata
      const failedMetadata = functions
        .filter(f => !f.metadataLoaded)
        .map(f => f.slug)
      
      // Collect any metadata errors
      const errors = functions
        .filter(f => f.metadataError)
        .map(f => `${f.slug}: ${f.metadataError}`)
      
      const result: SyncResult = {
        totalFunctions: functions.length,
        uiDeployed,
        apiDeployed,
        unknownSource,
        errors,
        lastSync: new Date().toISOString(),
        failedMetadata,
      }
      
      console.log(`Function list sync completed for project '${projectRef}':`, {
        total: result.totalFunctions,
        ui: result.uiDeployed,
        api: result.apiDeployed,
        unknown: result.unknownSource,
        errors: result.errors.length,
        failedMetadata: result.failedMetadata.length,
      })
      
      return result
    }, `sync function list for project '${projectRef}'`)
  }

  /**
   * Handle function list retrieval errors
   * 
   * @param error - Original error
   * @returns Structured error information
   */
  handleListRetrievalError(error: any): FunctionListError {
    return this.errorHandler.handleListRetrievalError(error, {
      service: 'FunctionListService',
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Refresh the storage backend (useful for testing or configuration changes)
   */
  async refreshStorage(): Promise<void> {
    this.storageBackend = null
    this.codeService = null
    // Next call to getStorageBackend() will reinitialize
  }

  /**
   * Get storage backend type for diagnostics
   */
  async getStorageType(): Promise<string> {
    try {
      const storage = await this.getStorageBackend()
      return storage.getType()
    } catch (error) {
      return 'unknown'
    }
  }

  /**
   * Check if storage backend is healthy
   */
  async isStorageHealthy(): Promise<boolean> {
    try {
      const storage = await this.getStorageBackend()
      const health = await storage.healthCheck()
      return health.healthy
    } catch (error) {
      return false
    }
  }
}

/**
 * Singleton instance
 */
let functionListService: FunctionListService | null = null

/**
 * Get the singleton FunctionListService instance
 */
export function getFunctionListService(): FunctionListService {
  if (!functionListService) {
    functionListService = new FunctionListService()
  }
  return functionListService
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetFunctionListService(): void {
  functionListService = null
}