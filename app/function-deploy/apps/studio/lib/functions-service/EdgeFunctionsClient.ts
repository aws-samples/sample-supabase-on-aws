import { getStorageBackend } from './storage/StorageBackendFactory'
import {
  StorageBackend,
  FunctionFile,
  FunctionMetadata,
  StorageBackendError,
  StorageNotFoundError,
} from './storage/StorageBackend'
import { LocalFileSystemStorage } from './storage/LocalFileSystemStorage'
// S3Storage is lazy-loaded to avoid bundling AWS SDK dependencies during build
// import { S3Storage } from './storage/S3Storage'
import { 
  getDenoRuntimeService, 
  DenoRuntimeService,
  FunctionExecutionResult,
  DenoRuntimeConfig 
} from './deno/DenoRuntimeService'
import { getLazyLoadingService, LazyLoadingService } from './lazy-loading/LazyLoadingService'
import { getFrequencyTracker, FrequencyTracker } from './background-sync/FrequencyTracker'
import { getBackgroundSyncService, BackgroundSyncService } from './background-sync/BackgroundSyncService'

/**
 * Deployment data for Edge Functions
 */
export interface DeploymentData {
  /** Function slug/identifier */
  slug: string
  /** Function files to deploy */
  files: FunctionFile[]
  /** Function metadata */
  metadata: Omit<FunctionMetadata, 'createdAt' | 'updatedAt'>
  /** Import map content (optional) */
  importMap?: string
  /** Entry point file (optional, defaults to 'index.ts') */
  entrypoint?: string
}

/**
 * Deployment result
 */
export interface DeploymentResult {
  /** Whether deployment was successful */
  success: boolean
  /** Function metadata after deployment */
  metadata: FunctionMetadata
  /** Error message if deployment failed */
  error?: string
  /** Additional details */
  details?: Record<string, any>
  /** Warning messages (e.g., S3 write failures) */
  warnings?: string[]
}

/**
 * Dual-write deployment result
 */
export interface DualWriteResult {
  /** Whether deployment was successful (local write succeeded) */
  success: boolean
  /** Whether local write succeeded */
  localWriteSuccess: boolean
  /** Whether S3 write succeeded */
  s3WriteSuccess: boolean
  /** Local write error if failed */
  localError?: Error
  /** S3 write error if failed */
  s3Error?: Error
  /** Warning messages */
  warnings: string[]
  /** Function metadata after deployment */
  metadata: FunctionMetadata
}

/**
 * Function information
 */
export interface FunctionInfo {
  /** Function metadata */
  metadata: FunctionMetadata
  /** Function files */
  files: FunctionFile[]
}

/**
 * Function invocation result
 */
export interface InvocationResult {
  /** HTTP status code */
  status: number
  /** Response headers */
  headers: Record<string, string>
  /** Response body */
  body: any
  /** Execution time in milliseconds */
  executionTime: number
}

/**
 * Edge Functions Client Configuration
 */
export interface EdgeFunctionsClientConfig {
  /** Deno runtime configuration */
  denoConfig?: DenoRuntimeConfig
}

/**
 * Edge Functions Client
 * 
 * Provides a unified interface for managing Edge Functions with storage backend integration.
 * Supports both local file system and AWS S3 storage backends with Deno runtime integration.
 */
export class EdgeFunctionsClient {
  private storageBackend: StorageBackend | null = null
  private localStorage: LocalFileSystemStorage | null = null
  private s3Storage: S3Storage | null = null
  private denoRuntimeService: DenoRuntimeService | null = null
  private lazyLoadingService: LazyLoadingService | null = null
  private frequencyTracker: FrequencyTracker | null = null
  private backgroundSyncService: BackgroundSyncService | null = null
  private config: EdgeFunctionsClientConfig
  private isDualWriteEnabled: boolean

  constructor(config: EdgeFunctionsClientConfig = {}) {
    this.config = config
    this.isDualWriteEnabled = process.env.EDGE_FUNCTIONS_STORAGE_BACKEND === 's3'
    
    // Initialize frequency tracker if background sync is enabled
    if (process.env.EDGE_FUNCTIONS_BACKGROUND_SYNC_ENABLED === 'true') {
      this.initializeBackgroundSync()
    }
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
   * Get or initialize the local storage backend
   */
  private getLocalStorage(): LocalFileSystemStorage {
    if (!this.localStorage) {
      this.localStorage = new LocalFileSystemStorage()
    }
    return this.localStorage
  }

  /**
   * Get or initialize the S3 storage backend
   */
  private getS3Storage(): S3Storage {
    if (!this.s3Storage) {
      const s3Config = {
        bucketName: process.env.EDGE_FUNCTIONS_S3_BUCKET_NAME,
        region: process.env.EDGE_FUNCTIONS_S3_REGION,
        endpoint: process.env.EDGE_FUNCTIONS_S3_ENDPOINT,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        basePrefix: process.env.EDGE_FUNCTIONS_S3_PREFIX,
      }
      this.s3Storage = new S3Storage(s3Config)
    }
    return this.s3Storage
  }

  /**
   * Get or initialize the Deno runtime service
   */
  private getDenoRuntimeService(): DenoRuntimeService {
    if (!this.denoRuntimeService) {
      this.denoRuntimeService = getDenoRuntimeService(this.config.denoConfig)
    }
    return this.denoRuntimeService
  }

  /**
   * Get or initialize the lazy loading service
   */
  private getLazyLoadingService(): LazyLoadingService {
    if (!this.lazyLoadingService) {
      this.lazyLoadingService = getLazyLoadingService()
    }
    return this.lazyLoadingService
  }

  /**
   * Initialize background sync service and frequency tracker
   */
  private initializeBackgroundSync(): void {
    try {
      // Initialize frequency tracker
      this.frequencyTracker = getFrequencyTracker()
      
      // Initialize background sync service
      const lazyLoader = this.getLazyLoadingService()
      this.backgroundSyncService = getBackgroundSyncService(lazyLoader)
      
      // Start background sync
      this.backgroundSyncService.startBackgroundSync()
      
      console.log('[EdgeFunctionsClient] Background sync initialized and started')
    } catch (error: any) {
      console.error('[EdgeFunctionsClient] Failed to initialize background sync:', error)
      // Non-critical - continue without background sync
    }
  }

  /**
   * Record function access for frequency tracking
   */
  private recordFunctionAccess(projectRef: string, functionSlug: string): void {
    if (this.frequencyTracker) {
      this.frequencyTracker.recordAccess(projectRef, functionSlug)
      
      // Update background sync service with frequent functions periodically
      // (every 10 accesses to avoid too frequent updates)
      const accessCount = this.frequencyTracker.getAccessCount(projectRef, functionSlug)
      if (accessCount % 10 === 0 && this.backgroundSyncService) {
        const frequentFunctions = this.frequencyTracker.getFrequentFunctions(100)
        this.backgroundSyncService.updateFrequencyList(frequentFunctions)
      }
    }
  }

  /**
   * Deploy a function using dual-write strategy
   * 
   * Writes to local storage first (critical path), then attempts S3 write (best effort).
   * Deployment succeeds if local write succeeds, even if S3 write fails.
   * Invalidates cache on updates to ensure fresh data on next access.
   * 
   * @param projectRef - Project reference
   * @param deploymentData - Function deployment data
   * @returns Dual-write deployment result
   */
  async dualWriteDeploy(projectRef: string, deploymentData: DeploymentData): Promise<DualWriteResult> {
    const result: DualWriteResult = {
      success: false,
      localWriteSuccess: false,
      s3WriteSuccess: false,
      warnings: [],
      metadata: deploymentData.metadata as FunctionMetadata,
    }

    // Validate deployment data
    this.validateDeploymentData(deploymentData)

    // Invalidate cache before deployment (for updates)
    if (this.isDualWriteEnabled) {
      const lazyLoader = this.getLazyLoadingService()
      try {
        await lazyLoader.invalidateCache(projectRef, deploymentData.slug)
        console.log(`[DualWrite] Cache invalidated for function '${deploymentData.slug}' before deployment`)
      } catch (error: any) {
        console.warn(`[DualWrite] Failed to invalidate cache before deployment:`, error)
        // Non-critical - continue with deployment
      }
    }

    // Prepare function files
    const files = [...deploymentData.files]
    
    // Add import map if provided
    if (deploymentData.importMap) {
      files.push({
        name: 'import_map.json',
        content: deploymentData.importMap,
        path: 'import_map.json',
      })
    }

    // Create complete metadata with timestamps
    const now = new Date()
    const localStorage = this.getLocalStorage()
    const existingMetadata = await localStorage.getMetadata(projectRef, deploymentData.slug)
    
    const metadata: FunctionMetadata = {
      ...deploymentData.metadata,
      slug: deploymentData.slug,
      projectRef,
      entrypoint: deploymentData.entrypoint || 'index.ts',
      createdAt: existingMetadata?.createdAt || now,
      updatedAt: now,
    }

    result.metadata = metadata

    // Step 1: Write to local storage (critical path)
    try {
      await localStorage.store(projectRef, deploymentData.slug, files, metadata)
      result.localWriteSuccess = true
      console.log(`[DualWrite] Successfully wrote function '${deploymentData.slug}' to local storage`)
    } catch (error: any) {
      result.localError = error
      console.error(`[DualWrite] Local write failed for function '${deploymentData.slug}':`, error)
      // Local write failure is critical - fail the entire deployment
      return result
    }

    // Step 2: Write to S3 if dual-write is enabled (best effort)
    if (this.isDualWriteEnabled) {
      try {
        const s3Storage = this.getS3Storage()
        await s3Storage.store(projectRef, deploymentData.slug, files, metadata)
        result.s3WriteSuccess = true
        console.log(`[DualWrite] Successfully wrote function '${deploymentData.slug}' to S3 storage`)
      } catch (error: any) {
        result.s3Error = error
        result.warnings.push(
          `S3 write failed: ${error.message}. Function deployed locally only. ` +
          `Function may not be available after container restart.`
        )
        console.warn(`[DualWrite] S3 write failed for function '${deploymentData.slug}':`, error)
        // S3 write failure is non-critical - log warning but continue
      }
    }

    // Deployment succeeds if local write succeeded
    result.success = result.localWriteSuccess

    return result
  }

  /**
   * Deploy a function to the specified project
   * 
   * Uses dual-write strategy when S3 storage is enabled.
   * 
   * @param projectRef - Project reference
   * @param deploymentData - Function deployment data
   * @returns Deployment result
   */
  async deploy(projectRef: string, deploymentData: DeploymentData): Promise<DeploymentResult> {
    try {
      // Use dual-write if S3 storage is enabled
      if (this.isDualWriteEnabled) {
        const dualWriteResult = await this.dualWriteDeploy(projectRef, deploymentData)
        
        if (!dualWriteResult.success) {
          return {
            success: false,
            metadata: dualWriteResult.metadata,
            error: dualWriteResult.localError?.message || 'Deployment failed',
            details: {
              projectRef,
              functionSlug: deploymentData.slug,
              localWriteSuccess: dualWriteResult.localWriteSuccess,
              s3WriteSuccess: dualWriteResult.s3WriteSuccess,
              localError: dualWriteResult.localError?.message,
              s3Error: dualWriteResult.s3Error?.message,
            },
          }
        }

        // Deployment succeeded (local write succeeded)
        const result: DeploymentResult = {
          success: true,
          metadata: dualWriteResult.metadata,
          warnings: dualWriteResult.warnings,
        }

        // Perform Deno runtime validation and preloading
        await this.performDenoRuntimePreparation(projectRef, deploymentData.slug)

        return result
      }

      // Single-write path for local-only deployments
      const storage = await this.getStorageBackend()
      const denoRuntime = this.getDenoRuntimeService()
      
      // Validate deployment data
      this.validateDeploymentData(deploymentData)
      
      // Prepare function files
      const files = [...deploymentData.files]
      
      // Add import map if provided
      if (deploymentData.importMap) {
        files.push({
          name: 'import_map.json',
          content: deploymentData.importMap,
          path: 'import_map.json',
        })
      }
      
      // Create complete metadata with timestamps
      const now = new Date()
      const existingMetadata = await storage.getMetadata(projectRef, deploymentData.slug)
      
      const metadata: FunctionMetadata = {
        ...deploymentData.metadata,
        slug: deploymentData.slug,
        projectRef,
        entrypoint: deploymentData.entrypoint || 'index.ts',
        createdAt: existingMetadata?.createdAt || now,
        updatedAt: now,
      }
      
      // Store function in storage backend first
      await storage.store(projectRef, deploymentData.slug, files, metadata)
      
      // Perform Deno runtime validation and preloading
      await this.performDenoRuntimePreparation(projectRef, deploymentData.slug)
      
      console.log(`Successfully deployed function '${deploymentData.slug}' to project '${projectRef}' using ${storage.getType()} storage`)
      
      return {
        success: true,
        metadata,
      }
      
    } catch (error: any) {
      console.error(`Failed to deploy function '${deploymentData.slug}':`, error)
      
      return {
        success: false,
        metadata: deploymentData.metadata as FunctionMetadata,
        error: error.message,
        details: {
          projectRef,
          functionSlug: deploymentData.slug,
          storageType: this.storageBackend?.getType() || 'unknown',
          originalError: error instanceof StorageBackendError ? error.code : 'UNKNOWN_ERROR',
        },
      }
    }
  }

  /**
   * Perform Deno runtime preparation (validation and preloading)
   * 
   * @param projectRef - Project reference
   * @param slug - Function slug
   */
  private async performDenoRuntimePreparation(projectRef: string, slug: string): Promise<void> {
    const denoRuntime = this.getDenoRuntimeService()
    const storage = this.getLocalStorage() // Always use local storage for Deno runtime
    
    let preparation
    try {
      preparation = await denoRuntime.prepareFunction(storage, projectRef, slug)
      
      // Validate TypeScript code
      const validation = await denoRuntime.validateFunction(preparation)
      if (!validation.valid) {
        console.warn(`Function '${slug}' has TypeScript validation errors:`, validation.errors)
        // Continue deployment but log warnings
      }
      
      // Preload function dependencies for better performance
      const preloadResult = await denoRuntime.preloadFunction(preparation)
      if (preloadResult.success) {
        console.log(`Successfully preloaded ${preloadResult.cachedModules} modules for function '${slug}'`)
      } else {
        console.warn(`Failed to preload function '${slug}':`, preloadResult.error)
        // Continue deployment even if preloading fails
      }
      
    } catch (error: any) {
      console.warn(`Deno runtime preparation failed for function '${slug}':`, error.message)
      // Continue deployment even if Deno preparation fails
    } finally {
      // Clean up temporary files
      if (preparation) {
        await preparation.cleanup()
      }
    }
  }

  /**
   * List all functions in a project
   * 
   * @param projectRef - Project reference
   * @returns Array of function metadata
   */
  async list(projectRef: string): Promise<FunctionMetadata[]> {
    try {
      const storage = await this.getStorageBackend()
      return await storage.list(projectRef)
    } catch (error: any) {
      console.error(`Failed to list functions for project '${projectRef}':`, error)
      throw new StorageBackendError(
        `Failed to list functions: ${error.message}`,
        error instanceof StorageBackendError ? error.code : 'LIST_ERROR',
        { projectRef, originalError: error }
      )
    }
  }

  /**
   * Get function information (metadata and files)
   * 
   * Uses lazy loading when S3 storage is enabled:
   * - Checks local cache first
   * - If not cached, downloads from S3 automatically
   * - Caches downloaded function locally
   * 
   * @param projectRef - Project reference
   * @param slug - Function slug
   * @returns Function information
   */
  async get(projectRef: string, slug: string): Promise<FunctionInfo> {
    try {
      // Record function access for frequency tracking
      this.recordFunctionAccess(projectRef, slug)
      
      // Use lazy loading service when S3 is enabled
      if (this.isDualWriteEnabled) {
        const lazyLoader = this.getLazyLoadingService()
        
        try {
          // Lazy loader will check local cache first, then S3 if needed
          const files = await lazyLoader.getFunction(projectRef, slug)
          
          // Get metadata from local storage (now guaranteed to be cached)
          const localStorage = this.getLocalStorage()
          const metadata = await localStorage.getMetadata(projectRef, slug)
          
          if (!metadata) {
            throw new StorageNotFoundError(`Function ${slug} metadata not found in project ${projectRef}`)
          }
          
          return {
            metadata,
            files,
          }
        } catch (error: any) {
          // If lazy loading fails, throw appropriate error
          if (error instanceof StorageBackendError || error instanceof StorageNotFoundError) {
            throw error
          }
          
          throw new StorageBackendError(
            `Failed to get function with lazy loading: ${error.message}`,
            'LAZY_LOAD_ERROR',
            { projectRef, functionSlug: slug, originalError: error }
          )
        }
      }
      
      // Fallback to standard storage backend for non-S3 deployments
      const storage = await this.getStorageBackend()
      
      // Get metadata and files in parallel
      const [metadata, files] = await Promise.all([
        storage.getMetadata(projectRef, slug),
        storage.retrieve(projectRef, slug),
      ])
      
      if (!metadata) {
        throw new StorageNotFoundError(`Function ${slug} in project ${projectRef}`)
      }
      
      return {
        metadata,
        files,
      }
      
    } catch (error: any) {
      if (error instanceof StorageBackendError) {
        throw error
      }
      
      console.error(`Failed to get function '${slug}' from project '${projectRef}':`, error)
      throw new StorageBackendError(
        `Failed to get function: ${error.message}`,
        'GET_ERROR',
        { projectRef, functionSlug: slug, originalError: error }
      )
    }
  }

  /**
   * Delete a function from a project
   * 
   * Uses the configured storage backend (database, local, or S3).
   * When using DatabaseStorage, this will delete both metadata and files.
   * Invalidates cache to ensure deleted function is not accessible.
   * 
   * @param projectRef - Project reference
   * @param slug - Function slug
   */
  async delete(projectRef: string, slug: string): Promise<void> {
    try {
      // Invalidate cache before deletion
      if (this.isDualWriteEnabled) {
        const lazyLoader = this.getLazyLoadingService()
        try {
          await lazyLoader.invalidateCache(projectRef, slug)
          console.log(`[Delete] Cache invalidated for function '${slug}' before deletion`)
        } catch (error: any) {
          console.warn(`[Delete] Failed to invalidate cache before deletion:`, error)
          // Non-critical - continue with deletion
        }
      }
      
      // Use the configured storage backend (database, local, or S3)
      // This ensures proper deletion of both metadata and files
      const storage = await this.getStorageBackend()
      await storage.delete(projectRef, slug)
      
      console.log(`Successfully deleted function '${slug}' from ${storage.getType()} storage`)
      
      // Delete from S3 if dual-write is enabled (for S3 code storage)
      if (this.isDualWriteEnabled) {
        try {
          const s3Storage = this.getS3Storage()
          await s3Storage.delete(projectRef, slug)
          console.log(`Successfully deleted function '${slug}' from S3 storage`)
        } catch (error: any) {
          console.warn(`Failed to delete function '${slug}' from S3:`, error.message)
          // Non-critical - function already deleted from primary storage
        }
      }
      
    } catch (error: any) {
      if (error instanceof StorageBackendError) {
        throw error
      }
      
      console.error(`Failed to delete function '${slug}' from project '${projectRef}':`, error)
      throw new StorageBackendError(
        `Failed to delete function: ${error.message}`,
        'DELETE_ERROR',
        { projectRef, functionSlug: slug, originalError: error }
      )
    }
  }

  /**
   * Check if a function exists
   * 
   * @param projectRef - Project reference
   * @param slug - Function slug
   * @returns True if function exists
   */
  async exists(projectRef: string, slug: string): Promise<boolean> {
    try {
      const storage = await this.getStorageBackend()
      return await storage.exists(projectRef, slug)
    } catch (error: any) {
      console.error(`Failed to check if function '${slug}' exists in project '${projectRef}':`, error)
      return false
    }
  }

  /**
   * Get function metadata only
   * 
   * @param projectRef - Project reference
   * @param slug - Function slug
   * @returns Function metadata or null if not found
   */
  async getMetadata(projectRef: string, slug: string): Promise<FunctionMetadata | null> {
    try {
      const storage = await this.getStorageBackend()
      return await storage.getMetadata(projectRef, slug)
    } catch (error: any) {
      if (error instanceof StorageBackendError) {
        throw error
      }
      
      console.error(`Failed to get metadata for function '${slug}' in project '${projectRef}':`, error)
      throw new StorageBackendError(
        `Failed to get function metadata: ${error.message}`,
        'METADATA_ERROR',
        { projectRef, functionSlug: slug, originalError: error }
      )
    }
  }

  /**
   * Get function files only
   * 
   * Uses lazy loading when S3 storage is enabled.
   * 
   * @param projectRef - Project reference
   * @param slug - Function slug
   * @returns Function files
   */
  async getFiles(projectRef: string, slug: string): Promise<FunctionFile[]> {
    try {
      // Use lazy loading service when S3 is enabled
      if (this.isDualWriteEnabled) {
        const lazyLoader = this.getLazyLoadingService()
        
        try {
          // Lazy loader will check local cache first, then S3 if needed
          return await lazyLoader.getFunction(projectRef, slug)
        } catch (error: any) {
          // If lazy loading fails, throw appropriate error
          if (error instanceof StorageBackendError || error instanceof StorageNotFoundError) {
            throw error
          }
          
          throw new StorageBackendError(
            `Failed to get function files with lazy loading: ${error.message}`,
            'LAZY_LOAD_FILES_ERROR',
            { projectRef, functionSlug: slug, originalError: error }
          )
        }
      }
      
      // Fallback to standard storage backend for non-S3 deployments
      const storage = await this.getStorageBackend()
      return await storage.retrieve(projectRef, slug)
    } catch (error: any) {
      if (error instanceof StorageBackendError) {
        throw error
      }
      
      console.error(`Failed to get files for function '${slug}' in project '${projectRef}':`, error)
      throw new StorageBackendError(
        `Failed to get function files: ${error.message}`,
        'FILES_ERROR',
        { projectRef, functionSlug: slug, originalError: error }
      )
    }
  }

  /**
   * Invoke a function using Deno runtime
   * 
   * Ensures function is loaded before execution when using lazy loading.
   * 
   * @param projectRef - Project reference
   * @param slug - Function slug
   * @param payload - Invocation payload
   * @returns Invocation result
   */
  async invoke(projectRef: string, slug: string, payload: any): Promise<InvocationResult> {
    try {
      // Record function access for frequency tracking
      this.recordFunctionAccess(projectRef, slug)
      
      // Ensure function is loaded before invocation when using lazy loading
      if (this.isDualWriteEnabled) {
        const lazyLoader = this.getLazyLoadingService()
        
        try {
          // This will load from S3 if not cached locally
          await lazyLoader.getFunction(projectRef, slug)
          console.log(`[Invoke] Function ${slug} loaded and ready for execution`)
        } catch (error: any) {
          console.error(`[Invoke] Failed to load function ${slug} before invocation:`, error)
          throw new StorageBackendError(
            `Failed to load function before invocation: ${error.message}`,
            'INVOKE_LOAD_ERROR',
            { projectRef, functionSlug: slug, originalError: error }
          )
        }
      }
      
      const storage = await this.getStorageBackend()
      const denoRuntime = this.getDenoRuntimeService()
      
      // Verify function exists
      const exists = await this.exists(projectRef, slug)
      if (!exists) {
        throw new StorageNotFoundError(`Function ${slug} in project ${projectRef}`)
      }

      // Prepare function for execution
      const preparation = await denoRuntime.prepareFunction(storage, projectRef, slug)
      
      try {
        // Execute function with Deno runtime
        const executionResult = await denoRuntime.executeFunction(preparation, payload)
        
        // Convert Deno execution result to InvocationResult
        const result: InvocationResult = {
          status: executionResult.success ? 200 : 500,
          headers: {
            'Content-Type': 'application/json',
            'X-Function-Name': slug,
            'X-Project-Ref': projectRef,
            'X-Storage-Backend': storage.getType(),
            'X-Execution-Time': executionResult.executionTime.toString(),
          },
          body: executionResult.success 
            ? this.parseExecutionOutput(executionResult.stdout)
            : {
                error: executionResult.error || 'Function execution failed',
                stderr: executionResult.stderr,
                exitCode: executionResult.exitCode,
              },
          executionTime: executionResult.executionTime,
        }

        return result
        
      } finally {
        // Clean up temporary files
        await preparation.cleanup()
      }
      
    } catch (error: any) {
      if (error instanceof StorageBackendError) {
        throw error
      }
      
      console.error(`Failed to invoke function '${slug}' in project '${projectRef}':`, error)
      throw new StorageBackendError(
        `Failed to invoke function: ${error.message}`,
        'INVOKE_ERROR',
        { projectRef, functionSlug: slug, originalError: error }
      )
    }
  }

  /**
   * Parse execution output from Deno runtime
   * 
   * @param stdout - Standard output from Deno execution
   * @returns Parsed output
   */
  private parseExecutionOutput(stdout: string): any {
    if (!stdout || stdout.trim().length === 0) {
      return { message: 'Function executed successfully', output: null }
    }

    // Try to parse as JSON first
    try {
      return JSON.parse(stdout.trim())
    } catch {
      // If not JSON, return as plain text
      return { message: 'Function executed successfully', output: stdout.trim() }
    }
  }

  /**
   * Get storage backend health status
   * 
   * @returns Storage backend health status
   */
  async getStorageHealth(): Promise<{
    healthy: boolean
    type: string
    error?: string
    details?: Record<string, any>
  }> {
    try {
      const storage = await this.getStorageBackend()
      const healthStatus = await storage.healthCheck()
      
      return {
        healthy: healthStatus.healthy,
        type: storage.getType(),
        error: healthStatus.error,
        details: healthStatus.details,
      }
      
    } catch (error: any) {
      return {
        healthy: false,
        type: 'unknown',
        error: `Failed to check storage health: ${error.message}`,
        details: { originalError: error.message },
      }
    }
  }

  /**
   * Get Deno runtime health status
   * 
   * @returns Deno runtime health status
   */
  async getDenoHealth(): Promise<{
    healthy: boolean
    version?: string
    error?: string
    details?: Record<string, any>
  }> {
    try {
      const denoRuntime = this.getDenoRuntimeService()
      return await denoRuntime.healthCheck()
    } catch (error: any) {
      return {
        healthy: false,
        error: `Failed to check Deno runtime health: ${error.message}`,
        details: { originalError: error.message },
      }
    }
  }

  /**
   * Get comprehensive health status for Edge Functions service
   * 
   * @returns Comprehensive health status
   */
  async getHealthStatus(): Promise<{
    healthy: boolean
    storage: {
      healthy: boolean
      type: string
      error?: string
      details?: Record<string, any>
    }
    deno: {
      healthy: boolean
      version?: string
      error?: string
      details?: Record<string, any>
    }
    cache?: {
      totalCachedFunctions: number
      cacheByStorageType: Record<string, number>
      cacheByProject: Record<string, number>
    }
  }> {
    const [storageHealth, denoHealth] = await Promise.all([
      this.getStorageHealth(),
      this.getDenoHealth(),
    ])

    const denoRuntime = this.getDenoRuntimeService()
    const cacheStats = denoRuntime.getCacheStats()

    return {
      healthy: storageHealth.healthy && denoHealth.healthy,
      storage: storageHealth,
      deno: denoHealth,
      cache: cacheStats,
    }
  }

  /**
   * Validate function TypeScript code
   * 
   * @param projectRef - Project reference
   * @param slug - Function slug
   * @returns Validation result
   */
  async validateFunction(projectRef: string, slug: string): Promise<{
    valid: boolean
    errors: string[]
    warnings: string[]
  }> {
    try {
      const storage = await this.getStorageBackend()
      const denoRuntime = this.getDenoRuntimeService()
      
      // Verify function exists
      const exists = await this.exists(projectRef, slug)
      if (!exists) {
        throw new StorageNotFoundError(`Function ${slug} in project ${projectRef}`)
      }

      // Prepare function for validation
      const preparation = await denoRuntime.prepareFunction(storage, projectRef, slug)
      
      try {
        return await denoRuntime.validateFunction(preparation)
      } finally {
        await preparation.cleanup()
      }
      
    } catch (error: any) {
      if (error instanceof StorageBackendError) {
        throw error
      }
      
      return {
        valid: false,
        errors: [`Failed to validate function: ${error.message}`],
        warnings: [],
      }
    }
  }

  /**
   * Preload function dependencies
   * 
   * @param projectRef - Project reference
   * @param slug - Function slug
   * @returns Preload result
   */
  async preloadFunction(projectRef: string, slug: string): Promise<{
    success: boolean
    cachedModules: number
    error?: string
  }> {
    try {
      const storage = await this.getStorageBackend()
      const denoRuntime = this.getDenoRuntimeService()
      
      // Verify function exists
      const exists = await this.exists(projectRef, slug)
      if (!exists) {
        throw new StorageNotFoundError(`Function ${slug} in project ${projectRef}`)
      }

      // Prepare function for preloading
      const preparation = await denoRuntime.prepareFunction(storage, projectRef, slug)
      
      try {
        return await denoRuntime.preloadFunction(preparation)
      } finally {
        await preparation.cleanup()
      }
      
    } catch (error: any) {
      return {
        success: false,
        cachedModules: 0,
        error: `Failed to preload function: ${error.message}`,
      }
    }
  }

  /**
   * Clear Deno runtime cache
   * 
   * @param projectRef - Project reference (optional)
   * @param slug - Function slug (optional)
   */
  async clearDenoCache(projectRef?: string, slug?: string): Promise<void> {
    const denoRuntime = this.getDenoRuntimeService()
    await denoRuntime.clearCache(projectRef, slug)
  }

  /**
   * Get Deno runtime cache statistics
   */
  getDenoCacheStats(): {
    totalCachedFunctions: number
    cacheByStorageType: Record<string, number>
    cacheByProject: Record<string, number>
  } {
    const denoRuntime = this.getDenoRuntimeService()
    return denoRuntime.getCacheStats()
  }

  /**
   * Refresh storage backend and Deno runtime (clears cache and reinitializes)
   */
  async refreshStorage(): Promise<void> {
    this.storageBackend = null
    // Clear Deno runtime cache when refreshing storage
    if (this.denoRuntimeService) {
      await this.denoRuntimeService.clearCache()
    }
    // The next call to getStorageBackend() will reinitialize
  }

  /**
   * Refresh Deno runtime service (clears cache and reinitializes)
   */
  async refreshDenoRuntime(): Promise<void> {
    if (this.denoRuntimeService) {
      await this.denoRuntimeService.clearCache()
    }
    this.denoRuntimeService = null
    // The next call to getDenoRuntimeService() will reinitialize
  }

  /**
   * Get background sync service
   * 
   * @returns Background sync service or null if not initialized
   */
  getBackgroundSyncService(): BackgroundSyncService | null {
    return this.backgroundSyncService
  }

  /**
   * Get frequency tracker
   * 
   * @returns Frequency tracker or null if not initialized
   */
  getFrequencyTracker(): FrequencyTracker | null {
    return this.frequencyTracker
  }

  /**
   * Get background sync statistics
   * 
   * @returns Background sync statistics or null if not enabled
   */
  getBackgroundSyncStats() {
    return this.backgroundSyncService?.getStats() || null
  }

  /**
   * Get frequency tracker statistics
   * 
   * @returns Frequency tracker statistics or null if not enabled
   */
  getFrequencyTrackerStats() {
    if (!this.frequencyTracker) return null
    
    const tracker = this.frequencyTracker as any
    if (typeof tracker.getStats === 'function') {
      return tracker.getStats()
    }
    
    return null
  }

  /**
   * Manually trigger background sync
   * 
   * @returns Sync result or null if background sync is not enabled
   */
  async triggerBackgroundSync() {
    if (!this.backgroundSyncService) {
      console.warn('[EdgeFunctionsClient] Background sync is not enabled')
      return null
    }
    
    return await this.backgroundSyncService.syncFrequentFunctions()
  }

  /**
   * Validate deployment data
   * 
   * @param deploymentData - Deployment data to validate
   * @throws Error if validation fails
   */
  private validateDeploymentData(deploymentData: DeploymentData): void {
    if (!deploymentData.slug || deploymentData.slug.trim().length === 0) {
      throw new Error('Function slug is required')
    }

    // Validate slug format (lowercase alphanumeric, hyphens, underscores, and forward slashes only)
    if (!/^[a-z0-9][a-z0-9_\/-]*[a-z0-9]$/.test(deploymentData.slug)) {
      throw new Error(
        'Function slug must start and end with alphanumeric characters and contain only lowercase letters, numbers, hyphens, underscores, and forward slashes'
      )
    }

    if (!deploymentData.files || deploymentData.files.length === 0) {
      throw new Error('At least one function file is required')
    }

    // Validate that there's an entry point file
    const entrypoint = deploymentData.entrypoint || 'index.ts'
    const hasEntrypoint = deploymentData.files.some(
      file => file.path === entrypoint || file.name === entrypoint
    )

    if (!hasEntrypoint) {
      throw new Error(`Entry point file '${entrypoint}' not found in function files`)
    }

    // Validate metadata
    if (!deploymentData.metadata) {
      throw new Error('Function metadata is required')
    }

    if (!deploymentData.metadata.name || deploymentData.metadata.name.trim().length === 0) {
      throw new Error('Function name is required in metadata')
    }

    if (!deploymentData.metadata.version || deploymentData.metadata.version.trim().length === 0) {
      throw new Error('Function version is required in metadata')
    }

    if (!deploymentData.metadata.userId || deploymentData.metadata.userId.trim().length === 0) {
      throw new Error('User ID is required in metadata')
    }

    // Validate files
    for (const file of deploymentData.files) {
      if (!file.name || file.name.trim().length === 0) {
        throw new Error('File name is required for all files')
      }

      if (!file.path || file.path.trim().length === 0) {
        throw new Error('File path is required for all files')
      }

      if (file.content === undefined || file.content === null) {
        throw new Error(`File content is required for file '${file.name}'`)
      }
    }

    // Validate import map if provided
    if (deploymentData.importMap) {
      try {
        JSON.parse(deploymentData.importMap)
      } catch (error) {
        throw new Error('Import map must be valid JSON')
      }
    }
  }
}

/**
 * Singleton instance
 */
let edgeFunctionsClient: EdgeFunctionsClient | null = null

/**
 * Get the singleton EdgeFunctionsClient instance
 */
export function getEdgeFunctionsClient(config?: EdgeFunctionsClientConfig): EdgeFunctionsClient {
  if (!edgeFunctionsClient) {
    edgeFunctionsClient = new EdgeFunctionsClient(config)
  }
  return edgeFunctionsClient
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetEdgeFunctionsClient(): void {
  edgeFunctionsClient = null
}