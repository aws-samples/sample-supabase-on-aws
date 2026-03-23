/**
 * Lazy Loading Service for Edge Functions
 * 
 * Implements on-demand loading of functions from S3 to local storage.
 * Functions are only downloaded from S3 when accessed and not present locally.
 * 
 * Key Features:
 * - Local-first strategy: Check local cache before S3
 * - Concurrent request deduplication: Prevent duplicate downloads
 * - Automatic caching: Downloaded functions are cached locally
 * - Error handling: Graceful degradation with clear error messages
 */

import { LocalFileSystemStorage } from '../storage/LocalFileSystemStorage'
// S3Storage is lazy-loaded to avoid bundling AWS SDK dependencies during build
// import { S3Storage } from '../storage/S3Storage'
import {
  FunctionFile,
  StorageBackendError,
  StorageNotFoundError,
} from '../storage/StorageBackend'

// Lazy-load S3Storage module
let S3Storage: any = null
async function loadS3Storage() {
  if (!S3Storage) {
    const module = await import('../storage/S3Storage')
    S3Storage = module.S3Storage
  }
  return S3Storage
}

/**
 * Result of loading a function from S3
 */
export interface LoadResult {
  /** Source of the function (local cache or S3) */
  source: 'local' | 's3'
  /** Whether the function was already cached locally */
  cached: boolean
  /** Time taken to load the function (milliseconds) */
  loadTime: number
  /** Error if loading failed */
  error?: Error
}

/**
 * Lazy Loading Service Interface
 */
export interface LazyLoadingService {
  /**
   * Get function files with lazy loading from S3
   * 
   * Checks local cache first. If not found and S3 is enabled,
   * downloads from S3 and caches locally.
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function identifier
   * @returns Function files
   * @throws StorageNotFoundError if function not found in local or S3
   * @throws StorageBackendError if S3 download fails
   */
  getFunction(projectRef: string, functionSlug: string): Promise<FunctionFile[]>

  /**
   * Check if function is cached locally
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function identifier
   * @returns True if function exists in local cache
   */
  isFunctionCached(projectRef: string, functionSlug: string): Promise<boolean>

  /**
   * Load function from S3 if needed
   * 
   * Handles concurrent request deduplication to prevent duplicate downloads.
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function identifier
   * @returns Load result with timing and source information
   */
  loadFromS3IfNeeded(projectRef: string, functionSlug: string): Promise<LoadResult>

  /**
   * Invalidate local cache for a function
   * 
   * Removes function from local cache. Next access will reload from S3.
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function identifier
   */
  invalidateCache(projectRef: string, functionSlug: string): Promise<void>

  /**
   * Get lazy loading statistics
   * 
   * @returns Statistics about cache hits, misses, and S3 downloads
   */
  getStats(): LazyLoadingStats

  /**
   * Get detailed performance metrics
   * 
   * @returns Performance metrics including download history and speeds
   */
  getPerformanceMetrics(): PerformanceMetrics

  /**
   * Log performance metrics to console
   * 
   * Useful for monitoring and debugging lazy loading performance
   */
  logPerformanceMetrics(): void

  /**
   * Get metrics for a specific function
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function identifier
   * @returns Download metrics for the function, or null if not found
   */
  getFunctionMetrics(projectRef: string, functionSlug: string): DownloadMetrics | null
}

/**
 * Lazy loading statistics
 */
export interface LazyLoadingStats {
  /** Number of cache hits (function found locally) */
  cacheHits: number
  /** Number of cache misses (function not found locally) */
  cacheMisses: number
  /** Number of successful S3 downloads */
  s3Downloads: number
  /** Number of failed S3 downloads */
  failedDownloads: number
  /** Average S3 download time in milliseconds */
  avgDownloadTime: number
  /** Number of concurrent requests deduplicated */
  concurrentRequestsDeduplicated: number
  /** Total bytes downloaded from S3 */
  totalBytesDownloaded: number
  /** Minimum download time in milliseconds */
  minDownloadTime: number
  /** Maximum download time in milliseconds */
  maxDownloadTime: number
  /** Last download timestamp */
  lastDownloadTime: Date | null
  /** Cache hit rate as percentage */
  cacheHitRate: number
}

/**
 * Detailed download metrics for a single function
 */
export interface DownloadMetrics {
  /** Function identifier */
  functionSlug: string
  /** Project reference */
  projectRef: string
  /** Download start time */
  startTime: Date
  /** Download end time */
  endTime: Date
  /** Download duration in milliseconds */
  duration: number
  /** Number of files downloaded */
  fileCount: number
  /** Total bytes downloaded */
  bytes: number
  /** Whether download was successful */
  success: boolean
  /** Error message if failed */
  error?: string
}

/**
 * Performance metrics for monitoring
 */
export interface PerformanceMetrics {
  /** Recent download history (last 100 downloads) */
  recentDownloads: DownloadMetrics[]
  /** Functions accessed in the last hour */
  recentlyAccessedFunctions: Map<string, Date>
  /** Functions that failed to download */
  failedFunctions: Map<string, { count: number; lastError: string; lastAttempt: Date }>
  /** Average download speed in bytes per second */
  avgDownloadSpeed: number
}

/**
 * Edge Functions Lazy Loading Service Implementation
 * 
 * Implements lazy loading pattern for Edge Functions with S3 fallback.
 */
export class EdgeFunctionsLazyLoadingService implements LazyLoadingService {
  private localStorage: LocalFileSystemStorage
  private s3Storage: S3Storage | null = null
  private isS3Enabled: boolean
  private loadingLocks: Map<string, Promise<LoadResult>>
  private stats: LazyLoadingStats
  private performanceMetrics: PerformanceMetrics

  constructor() {
    this.localStorage = new LocalFileSystemStorage()
    this.isS3Enabled = process.env.EDGE_FUNCTIONS_STORAGE_BACKEND === 's3'
    this.loadingLocks = new Map()
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      s3Downloads: 0,
      failedDownloads: 0,
      avgDownloadTime: 0,
      concurrentRequestsDeduplicated: 0,
      totalBytesDownloaded: 0,
      minDownloadTime: Infinity,
      maxDownloadTime: 0,
      lastDownloadTime: null,
      cacheHitRate: 0,
    }
    this.performanceMetrics = {
      recentDownloads: [],
      recentlyAccessedFunctions: new Map(),
      failedFunctions: new Map(),
      avgDownloadSpeed: 0,
    }

    // Initialize S3 storage if enabled (lazy initialization on first use)
    if (this.isS3Enabled) {
      // Don't initialize here - will be done on first use
      // this.initializeS3Storage()
    }

    // Log metrics periodically (every 5 minutes)
    if (process.env.EDGE_FUNCTIONS_LOG_METRICS === 'true') {
      setInterval(() => this.logPerformanceMetrics(), 5 * 60 * 1000)
    }
  }

  /**
   * Initialize S3 storage backend
   */
  private s3InitPromise: Promise<void> | null = null
  
  private async ensureS3Initialized(): Promise<void> {
    if (!this.isS3Enabled) {
      return
    }
    
    if (this.s3Storage) {
      return // Already initialized
    }
    
    if (!this.s3InitPromise) {
      this.s3InitPromise = this.initializeS3Storage()
    }
    
    await this.s3InitPromise
  }
  
  private async initializeS3Storage(): Promise<void> {
    try {
      const s3Config = {
        bucketName: process.env.EDGE_FUNCTIONS_S3_BUCKET_NAME,
        region: process.env.EDGE_FUNCTIONS_S3_REGION,
        endpoint: process.env.EDGE_FUNCTIONS_S3_ENDPOINT,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        basePrefix: process.env.EDGE_FUNCTIONS_S3_PREFIX,
      }

      const S3StorageClass = await loadS3Storage()
      this.s3Storage = new S3StorageClass(s3Config)
      console.log('[LazyLoading] S3 storage initialized for lazy loading')
    } catch (error: any) {
      console.error('[LazyLoading] Failed to initialize S3 storage:', error)
      this.isS3Enabled = false
    }
  }

  /**
   * Get function files with lazy loading
   * 
   * Implementation follows this flow:
   * 1. Check local cache (fast path)
   * 2. If not cached and S3 enabled, download from S3 (slow path)
   * 3. Cache downloaded function locally
   * 4. Return function files
   */
  async getFunction(projectRef: string, functionSlug: string): Promise<FunctionFile[]> {
    const functionKey = `${projectRef}/${functionSlug}`
    
    // Track function access
    this.performanceMetrics.recentlyAccessedFunctions.set(functionKey, new Date())
    
    // Clean up old access records (keep last hour only)
    this.cleanupOldAccessRecords()

    // Step 1: Check local cache (fast path)
    const isCached = await this.isFunctionCached(projectRef, functionSlug)

    if (isCached) {
      this.stats.cacheHits++
      this.updateCacheHitRate()
      console.log(`[LazyLoading] ✓ Cache HIT: ${functionSlug} (local)`)
      
      // Return from local cache
      return await this.localStorage.retrieve(projectRef, functionSlug)
    }

    // Cache miss
    this.stats.cacheMisses++
    this.updateCacheHitRate()
    console.log(`[LazyLoading] ✗ Cache MISS: ${functionSlug} (not in local storage)`)

    // Step 2: Check if S3 is enabled
    if (!this.isS3Enabled || !this.s3Storage) {
      throw new StorageNotFoundError(
        `Function ${functionSlug} not found in local storage and S3 is not enabled`,
        { projectRef, functionSlug, s3Enabled: this.isS3Enabled }
      )
    }

    // Step 3: Load from S3 (slow path)
    console.log(`[LazyLoading] → Loading ${functionSlug} from S3...`)
    const loadResult = await this.loadFromS3IfNeeded(projectRef, functionSlug)

    if (loadResult.error) {
      this.stats.failedDownloads++
      
      // Track failed function
      const failedKey = `${projectRef}/${functionSlug}`
      const existing = this.performanceMetrics.failedFunctions.get(failedKey)
      this.performanceMetrics.failedFunctions.set(failedKey, {
        count: (existing?.count || 0) + 1,
        lastError: loadResult.error.message,
        lastAttempt: new Date(),
      })
      
      throw new StorageBackendError(
        `Failed to load function ${functionSlug} from S3: ${loadResult.error.message}`,
        'LAZY_LOAD_S3_ERROR',
        {
          projectRef,
          functionSlug,
          loadTime: loadResult.loadTime,
          originalError: loadResult.error,
        }
      )
    }

    console.log(
      `[LazyLoading] ✓ Function ${functionSlug} loaded from S3 in ${loadResult.loadTime}ms`
    )

    // Step 4: Return from local cache (now cached)
    return await this.localStorage.retrieve(projectRef, functionSlug)
  }

  /**
   * Check if function is cached locally
   */
  async isFunctionCached(projectRef: string, functionSlug: string): Promise<boolean> {
    try {
      // Use exists method for efficient check
      return await this.localStorage.exists(projectRef, functionSlug)
    } catch (error: any) {
      console.error(`[LazyLoading] Cache check failed for ${functionSlug}:`, error)
      return false
    }
  }

  /**
   * Load function from S3 if needed
   * 
   * Implements concurrent request deduplication:
   * - If function is already being loaded, wait for existing download
   * - Otherwise, start new download and create lock
   * - Clean up lock after download completes
   */
  async loadFromS3IfNeeded(projectRef: string, functionSlug: string): Promise<LoadResult> {
    const lockKey = `${projectRef}/${functionSlug}`

    // Check if already loading (concurrent request deduplication)
    if (this.loadingLocks.has(lockKey)) {
      this.stats.concurrentRequestsDeduplicated++
      console.log(
        `[LazyLoading] Function ${functionSlug} is already being loaded by another request, waiting...`
      )
      return await this.loadingLocks.get(lockKey)!
    }

    // Create new loading promise
    const loadingPromise = this._loadFromS3(projectRef, functionSlug)
    this.loadingLocks.set(lockKey, loadingPromise)

    try {
      const result = await loadingPromise
      return result
    } finally {
      // Clean up lock after loading completes (success or failure)
      this.loadingLocks.delete(lockKey)
    }
  }

  /**
   * Internal method to load function from S3
   * 
   * Downloads all function files from S3 and caches them locally.
   * Tracks detailed metrics for monitoring.
   */
  private async _loadFromS3(projectRef: string, functionSlug: string): Promise<LoadResult> {
    const startTime = Date.now()
    const result: LoadResult = {
      source: 's3',
      cached: false,
      loadTime: 0,
    }

    const downloadMetrics: DownloadMetrics = {
      functionSlug,
      projectRef,
      startTime: new Date(startTime),
      endTime: new Date(),
      duration: 0,
      fileCount: 0,
      bytes: 0,
      success: false,
    }

    try {
      // Ensure S3 storage is initialized
      await this.ensureS3Initialized()
      
      if (!this.s3Storage) {
        throw new Error('S3 storage not initialized')
      }

      console.log(`[LazyLoading] Downloading function ${functionSlug} from S3...`)

      // Download all files from S3
      const files = await this.s3Storage.retrieve(projectRef, functionSlug)

      if (!files || files.length === 0) {
        throw new StorageNotFoundError(
          `Function ${functionSlug} not found in S3`,
          { projectRef, functionSlug }
        )
      }

      // Calculate total bytes
      const totalBytes = files.reduce((sum, file) => sum + file.content.length, 0)
      downloadMetrics.fileCount = files.length
      downloadMetrics.bytes = totalBytes

      // Get metadata from S3
      const metadata = await this.s3Storage.getMetadata(projectRef, functionSlug)

      if (!metadata) {
        throw new StorageNotFoundError(
          `Function ${functionSlug} metadata not found in S3`,
          { projectRef, functionSlug }
        )
      }

      // Cache to local storage
      await this.localStorage.store(projectRef, functionSlug, files, metadata)

      result.cached = true
      result.loadTime = Date.now() - startTime
      downloadMetrics.duration = result.loadTime
      downloadMetrics.endTime = new Date()
      downloadMetrics.success = true

      // Update statistics
      this.stats.s3Downloads++
      this.stats.totalBytesDownloaded += totalBytes
      this.stats.lastDownloadTime = new Date()
      this.updateAverageDownloadTime(result.loadTime)
      this.updateDownloadTimeRange(result.loadTime)

      // Store download metrics
      this.addDownloadMetrics(downloadMetrics)

      console.log(
        `[LazyLoading] ✓ Function ${functionSlug} downloaded and cached in ${result.loadTime}ms (${files.length} files, ${this.formatBytes(totalBytes)})`
      )

      return result
    } catch (error: any) {
      result.error = error
      result.loadTime = Date.now() - startTime
      downloadMetrics.duration = result.loadTime
      downloadMetrics.endTime = new Date()
      downloadMetrics.error = error.message

      // Store failed download metrics
      this.addDownloadMetrics(downloadMetrics)

      console.error(
        `[LazyLoading] ✗ Failed to load function ${functionSlug} from S3:`,
        error.message
      )

      return result
    }
  }

  /**
   * Update average download time statistic
   */
  private updateAverageDownloadTime(newDownloadTime: number): void {
    const totalDownloads = this.stats.s3Downloads
    const currentAvg = this.stats.avgDownloadTime

    // Calculate new average: (old_avg * (n-1) + new_value) / n
    this.stats.avgDownloadTime =
      (currentAvg * (totalDownloads - 1) + newDownloadTime) / totalDownloads
  }

  /**
   * Update download time range (min/max)
   */
  private updateDownloadTimeRange(downloadTime: number): void {
    this.stats.minDownloadTime = Math.min(this.stats.minDownloadTime, downloadTime)
    this.stats.maxDownloadTime = Math.max(this.stats.maxDownloadTime, downloadTime)
  }

  /**
   * Update cache hit rate
   */
  private updateCacheHitRate(): void {
    const totalRequests = this.stats.cacheHits + this.stats.cacheMisses
    if (totalRequests === 0) {
      this.stats.cacheHitRate = 0
    } else {
      this.stats.cacheHitRate = (this.stats.cacheHits / totalRequests) * 100
    }
  }

  /**
   * Add download metrics to recent history
   * Keeps only the last 100 downloads
   */
  private addDownloadMetrics(metrics: DownloadMetrics): void {
    this.performanceMetrics.recentDownloads.push(metrics)
    
    // Keep only last 100 downloads
    if (this.performanceMetrics.recentDownloads.length > 100) {
      this.performanceMetrics.recentDownloads.shift()
    }

    // Update average download speed
    if (metrics.success && metrics.duration > 0) {
      const speed = metrics.bytes / (metrics.duration / 1000) // bytes per second
      const totalDownloads = this.performanceMetrics.recentDownloads.filter(d => d.success).length
      const currentAvgSpeed = this.performanceMetrics.avgDownloadSpeed

      this.performanceMetrics.avgDownloadSpeed =
        (currentAvgSpeed * (totalDownloads - 1) + speed) / totalDownloads
    }
  }

  /**
   * Clean up old access records (keep last hour only)
   */
  private cleanupOldAccessRecords(): void {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    
    for (const [key, accessTime] of this.performanceMetrics.recentlyAccessedFunctions.entries()) {
      if (accessTime < oneHourAgo) {
        this.performanceMetrics.recentlyAccessedFunctions.delete(key)
      }
    }
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes'
    
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  /**
   * Format duration to human-readable string
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`
    return `${(ms / 60000).toFixed(2)}m`
  }

  /**
   * Invalidate local cache for a function
   */
  async invalidateCache(projectRef: string, functionSlug: string): Promise<void> {
    try {
      await this.localStorage.delete(projectRef, functionSlug)
      console.log(`[LazyLoading] Cache invalidated for function ${functionSlug}`)
    } catch (error: any) {
      console.warn(`[LazyLoading] Failed to invalidate cache for function ${functionSlug}:`, error)
      // Don't throw - cache invalidation failure is non-critical
    }
  }

  /**
   * Get lazy loading statistics
   */
  getStats(): LazyLoadingStats {
    return { ...this.stats }
  }

  /**
   * Get detailed performance metrics
   */
  getPerformanceMetrics(): PerformanceMetrics {
    return {
      recentDownloads: [...this.performanceMetrics.recentDownloads],
      recentlyAccessedFunctions: new Map(this.performanceMetrics.recentlyAccessedFunctions),
      failedFunctions: new Map(this.performanceMetrics.failedFunctions),
      avgDownloadSpeed: this.performanceMetrics.avgDownloadSpeed,
    }
  }

  /**
   * Log performance metrics to console
   */
  logPerformanceMetrics(): void {
    console.log('\n========== Lazy Loading Performance Metrics ==========')
    console.log(`Cache Hit Rate: ${this.stats.cacheHitRate.toFixed(2)}%`)
    console.log(`Cache Hits: ${this.stats.cacheHits}`)
    console.log(`Cache Misses: ${this.stats.cacheMisses}`)
    console.log(`S3 Downloads: ${this.stats.s3Downloads}`)
    console.log(`Failed Downloads: ${this.stats.failedDownloads}`)
    console.log(`Concurrent Requests Deduplicated: ${this.stats.concurrentRequestsDeduplicated}`)
    console.log(`Total Bytes Downloaded: ${this.formatBytes(this.stats.totalBytesDownloaded)}`)
    console.log(`Average Download Time: ${this.formatDuration(this.stats.avgDownloadTime)}`)
    console.log(`Min Download Time: ${this.formatDuration(this.stats.minDownloadTime === Infinity ? 0 : this.stats.minDownloadTime)}`)
    console.log(`Max Download Time: ${this.formatDuration(this.stats.maxDownloadTime)}`)
    console.log(`Average Download Speed: ${this.formatBytes(this.performanceMetrics.avgDownloadSpeed)}/s`)
    console.log(`Last Download: ${this.stats.lastDownloadTime?.toISOString() || 'Never'}`)
    console.log(`Recently Accessed Functions (last hour): ${this.performanceMetrics.recentlyAccessedFunctions.size}`)
    console.log(`Failed Functions: ${this.performanceMetrics.failedFunctions.size}`)
    
    // Log top 5 most recent downloads
    if (this.performanceMetrics.recentDownloads.length > 0) {
      console.log('\nRecent Downloads (last 5):')
      const recentFive = this.performanceMetrics.recentDownloads.slice(-5).reverse()
      recentFive.forEach((download, index) => {
        const status = download.success ? '✓' : '✗'
        console.log(
          `  ${index + 1}. ${status} ${download.functionSlug} - ${this.formatDuration(download.duration)} (${download.fileCount} files, ${this.formatBytes(download.bytes)})`
        )
      })
    }
    
    // Log failed functions
    if (this.performanceMetrics.failedFunctions.size > 0) {
      console.log('\nFailed Functions:')
      let count = 0
      for (const [key, failure] of this.performanceMetrics.failedFunctions.entries()) {
        if (count >= 5) break // Show only top 5
        console.log(
          `  - ${key}: ${failure.count} failures, last: ${failure.lastError} (${failure.lastAttempt.toISOString()})`
        )
        count++
      }
    }
    
    console.log('====================================================\n')
  }

  /**
   * Get metrics for a specific function
   */
  getFunctionMetrics(projectRef: string, functionSlug: string): DownloadMetrics | null {
    const functionKey = `${projectRef}/${functionSlug}`
    
    // Find the most recent download for this function
    for (let i = this.performanceMetrics.recentDownloads.length - 1; i >= 0; i--) {
      const download = this.performanceMetrics.recentDownloads[i]
      if (download.projectRef === projectRef && download.functionSlug === functionSlug) {
        return download
      }
    }
    
    return null
  }

  /**
   * Reset statistics (useful for testing)
   */
  resetStats(): void {
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      s3Downloads: 0,
      failedDownloads: 0,
      avgDownloadTime: 0,
      concurrentRequestsDeduplicated: 0,
      totalBytesDownloaded: 0,
      minDownloadTime: Infinity,
      maxDownloadTime: 0,
      lastDownloadTime: null,
      cacheHitRate: 0,
    }
    this.performanceMetrics = {
      recentDownloads: [],
      recentlyAccessedFunctions: new Map(),
      failedFunctions: new Map(),
      avgDownloadSpeed: 0,
    }
  }

  /**
   * Get cache hit rate as percentage
   */
  getCacheHitRate(): number {
    const totalRequests = this.stats.cacheHits + this.stats.cacheMisses
    if (totalRequests === 0) return 0
    return (this.stats.cacheHits / totalRequests) * 100
  }

  /**
   * Check if S3 is enabled and available
   */
  isS3Available(): boolean {
    return this.isS3Enabled && this.s3Storage !== null
  }
}

/**
 * Singleton instance
 */
let lazyLoadingService: EdgeFunctionsLazyLoadingService | null = null

/**
 * Get the singleton LazyLoadingService instance
 */
export function getLazyLoadingService(): EdgeFunctionsLazyLoadingService {
  if (!lazyLoadingService) {
    lazyLoadingService = new EdgeFunctionsLazyLoadingService()
  }
  return lazyLoadingService
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetLazyLoadingService(): void {
  lazyLoadingService = null
}
