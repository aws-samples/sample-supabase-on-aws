/**
 * Background Sync Service for Edge Functions
 * 
 * Optional service that pre-warms the local cache by syncing frequently accessed
 * functions from S3 in the background. This reduces latency for popular functions
 * on first access.
 * 
 * Key Features:
 * - Non-blocking: Runs in background without affecting normal operations
 * - Configurable: Enable/disable via environment variables
 * - Frequency-based: Prioritizes frequently accessed functions
 * - Error resilient: Errors don't affect normal function operations
 * 
 * Configuration:
 * - EDGE_FUNCTIONS_BACKGROUND_SYNC_ENABLED: Enable/disable (default: false)
 * - EDGE_FUNCTIONS_BACKGROUND_SYNC_INTERVAL: Sync interval in ms (default: 300000 = 5 min)
 * - EDGE_FUNCTIONS_BACKGROUND_SYNC_MAX_FUNCTIONS: Max functions to sync (default: 100)
 */

import { LazyLoadingService } from '../lazy-loading/LazyLoadingService'

/**
 * Frequent function metadata for prioritization
 */
export interface FrequentFunction {
  /** Project reference */
  projectRef: string
  /** Function identifier */
  functionSlug: string
  /** Number of times accessed */
  accessCount: number
  /** Last access timestamp */
  lastAccessed: Date
}

/**
 * Result of a background sync operation
 */
export interface SyncResult {
  /** Number of functions successfully synced */
  synced: number
  /** Number of functions that failed to sync */
  failed: number
  /** Number of functions skipped (already cached) */
  skipped: number
  /** Total duration of sync operation in milliseconds */
  duration: number
  /** Timestamp when sync completed */
  completedAt: string
}

/**
 * Background Sync Service Interface
 */
export interface BackgroundSyncService {
  /**
   * Start background sync process
   * 
   * Begins periodic syncing of frequently accessed functions.
   * Does nothing if background sync is disabled.
   */
  startBackgroundSync(): void

  /**
   * Stop background sync process
   * 
   * Stops the periodic sync timer.
   */
  stopBackgroundSync(): void

  /**
   * Sync frequently accessed functions
   * 
   * Downloads functions from S3 that are not yet cached locally.
   * Prioritizes functions based on access frequency.
   * 
   * @returns Sync result with statistics
   */
  syncFrequentFunctions(): Promise<SyncResult>

  /**
   * Update the list of frequently accessed functions
   * 
   * Updates the internal list used for prioritization.
   * Sorts by access count and keeps top N functions.
   * 
   * @param functions - List of functions with access statistics
   */
  updateFrequencyList(functions: FrequentFunction[]): void

  /**
   * Get background sync statistics
   * 
   * @returns Statistics about sync operations
   */
  getStats(): BackgroundSyncStats

  /**
   * Check if background sync is enabled
   * 
   * @returns True if background sync is enabled
   */
  isEnabled(): boolean
}

/**
 * Background sync statistics
 */
export interface BackgroundSyncStats {
  /** Total number of sync operations performed */
  totalSyncs: number
  /** Total number of functions synced */
  totalFunctionsSynced: number
  /** Total number of functions that failed to sync */
  totalFunctionsFailed: number
  /** Total number of functions skipped (already cached) */
  totalFunctionsSkipped: number
  /** Average sync duration in milliseconds */
  avgSyncDuration: number
  /** Last sync timestamp */
  lastSyncAt: string | null
  /** Last sync result */
  lastSyncResult: SyncResult | null
}

/**
 * Edge Functions Background Sync Service Implementation
 * 
 * Implements optional background cache warming for frequently accessed functions.
 */
export class EdgeFunctionsBackgroundSyncService implements BackgroundSyncService {
  private lazyLoader: LazyLoadingService
  private syncInterval: NodeJS.Timeout | null = null
  private frequentFunctions: FrequentFunction[] = []
  private isBackgroundSyncEnabled: boolean
  private syncIntervalMs: number
  private maxFunctions: number
  private stats: BackgroundSyncStats

  constructor(lazyLoader: LazyLoadingService) {
    this.lazyLoader = lazyLoader

    // Load configuration from environment
    this.isBackgroundSyncEnabled =
      process.env.EDGE_FUNCTIONS_BACKGROUND_SYNC_ENABLED === 'true'
    this.syncIntervalMs = parseInt(
      process.env.EDGE_FUNCTIONS_BACKGROUND_SYNC_INTERVAL || '300000'
    ) // 5 minutes default
    this.maxFunctions = parseInt(
      process.env.EDGE_FUNCTIONS_BACKGROUND_SYNC_MAX_FUNCTIONS || '100'
    )

    // Initialize statistics
    this.stats = {
      totalSyncs: 0,
      totalFunctionsSynced: 0,
      totalFunctionsFailed: 0,
      totalFunctionsSkipped: 0,
      avgSyncDuration: 0,
      lastSyncAt: null,
      lastSyncResult: null,
    }

    console.log('[BackgroundSync] Service initialized', {
      enabled: this.isBackgroundSyncEnabled,
      intervalMs: this.syncIntervalMs,
      maxFunctions: this.maxFunctions,
    })
  }

  /**
   * Start background sync process
   */
  startBackgroundSync(): void {
    if (!this.isBackgroundSyncEnabled) {
      console.log('[BackgroundSync] Background sync is disabled, not starting')
      return
    }

    if (this.syncInterval) {
      console.log('[BackgroundSync] Background sync is already running')
      return
    }

    console.log(
      `[BackgroundSync] Starting background sync with interval ${this.syncIntervalMs}ms`
    )

    // Run initial sync immediately
    this.syncFrequentFunctions().catch((error) => {
      console.error('[BackgroundSync] Initial sync failed:', error)
    })

    // Set up periodic sync
    this.syncInterval = setInterval(async () => {
      try {
        await this.syncFrequentFunctions()
      } catch (error: any) {
        console.error('[BackgroundSync] Periodic sync error:', error)
        // Don't throw - background sync errors should not affect normal operations
      }
    }, this.syncIntervalMs)

    console.log('[BackgroundSync] Background sync started successfully')
  }

  /**
   * Stop background sync process
   */
  stopBackgroundSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval)
      this.syncInterval = null
      console.log('[BackgroundSync] Background sync stopped')
    } else {
      console.log('[BackgroundSync] Background sync is not running')
    }
  }

  /**
   * Sync frequently accessed functions
   * 
   * Implementation:
   * 1. Check each frequent function if it's cached
   * 2. If not cached, load from S3 and cache locally
   * 3. Track statistics (synced, failed, skipped)
   * 4. Return sync result
   */
  async syncFrequentFunctions(): Promise<SyncResult> {
    const startTime = Date.now()
    const result: SyncResult = {
      synced: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      completedAt: new Date().toISOString(),
    }

    console.log(
      `[BackgroundSync] Starting sync of ${this.frequentFunctions.length} frequent functions`
    )

    // Process each frequent function
    for (const func of this.frequentFunctions) {
      try {
        // Check if already cached
        const isCached = await this.lazyLoader.isFunctionCached(func.projectRef, func.functionSlug)

        if (isCached) {
          result.skipped++
          console.log(
            `[BackgroundSync] Skipped ${func.functionSlug} (already cached, accessed ${func.accessCount} times)`
          )
          continue
        }

        // Load from S3 and cache
        console.log(
          `[BackgroundSync] Syncing ${func.functionSlug} (accessed ${func.accessCount} times)...`
        )
        const loadResult = await this.lazyLoader.loadFromS3IfNeeded(
          func.projectRef,
          func.functionSlug
        )

        if (loadResult.error) {
          result.failed++
          console.error(
            `[BackgroundSync] Failed to sync ${func.functionSlug}:`,
            loadResult.error.message
          )
        } else {
          result.synced++
          console.log(
            `[BackgroundSync] ✓ Synced ${func.functionSlug} in ${loadResult.loadTime}ms`
          )
        }
      } catch (error: any) {
        result.failed++
        console.error(`[BackgroundSync] Error syncing ${func.functionSlug}:`, error.message)
        // Continue with next function - don't let one failure stop the sync
      }
    }

    result.duration = Date.now() - startTime

    // Update statistics
    this.updateStats(result)

    console.log(
      `[BackgroundSync] Sync completed: ${result.synced} synced, ${result.failed} failed, ${result.skipped} skipped in ${result.duration}ms`
    )

    return result
  }

  /**
   * Update the list of frequently accessed functions
   * 
   * Sorts by access count (descending) and keeps top N functions.
   */
  updateFrequencyList(functions: FrequentFunction[]): void {
    // Sort by access count (most accessed first)
    const sortedFunctions = [...functions].sort((a, b) => {
      // Primary sort: access count (descending)
      if (b.accessCount !== a.accessCount) {
        return b.accessCount - a.accessCount
      }
      // Secondary sort: last accessed (most recent first)
      return new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime()
    })

    // Keep only top N functions
    this.frequentFunctions = sortedFunctions.slice(0, this.maxFunctions)

    console.log(
      `[BackgroundSync] Updated frequent functions list: ${this.frequentFunctions.length} functions (from ${functions.length} total)`
    )

    if (this.frequentFunctions.length > 0) {
      const topFunction = this.frequentFunctions[0]
      console.log(
        `[BackgroundSync] Top function: ${topFunction.functionSlug} (accessed ${topFunction.accessCount} times)`
      )
    }
  }

  /**
   * Update background sync statistics
   */
  private updateStats(result: SyncResult): void {
    this.stats.totalSyncs++
    this.stats.totalFunctionsSynced += result.synced
    this.stats.totalFunctionsFailed += result.failed
    this.stats.totalFunctionsSkipped += result.skipped
    this.stats.lastSyncAt = result.completedAt
    this.stats.lastSyncResult = result

    // Update average sync duration
    const totalSyncs = this.stats.totalSyncs
    const currentAvg = this.stats.avgSyncDuration
    this.stats.avgSyncDuration =
      (currentAvg * (totalSyncs - 1) + result.duration) / totalSyncs
  }

  /**
   * Get background sync statistics
   */
  getStats(): BackgroundSyncStats {
    return { ...this.stats }
  }

  /**
   * Check if background sync is enabled
   */
  isEnabled(): boolean {
    return this.isBackgroundSyncEnabled
  }

  /**
   * Reset statistics (useful for testing)
   */
  resetStats(): void {
    this.stats = {
      totalSyncs: 0,
      totalFunctionsSynced: 0,
      totalFunctionsFailed: 0,
      totalFunctionsSkipped: 0,
      avgSyncDuration: 0,
      lastSyncAt: null,
      lastSyncResult: null,
    }
  }

  /**
   * Get current frequent functions list
   */
  getFrequentFunctions(): FrequentFunction[] {
    return [...this.frequentFunctions]
  }

  /**
   * Get sync interval in milliseconds
   */
  getSyncInterval(): number {
    return this.syncIntervalMs
  }

  /**
   * Get max functions to sync
   */
  getMaxFunctions(): number {
    return this.maxFunctions
  }

  /**
   * Check if background sync is currently running
   */
  isRunning(): boolean {
    return this.syncInterval !== null
  }
}

/**
 * Singleton instance
 */
let backgroundSyncService: EdgeFunctionsBackgroundSyncService | null = null

/**
 * Get the singleton BackgroundSyncService instance
 * 
 * @param lazyLoader - LazyLoadingService instance (required for first call)
 * @returns BackgroundSyncService instance
 */
export function getBackgroundSyncService(
  lazyLoader?: LazyLoadingService
): EdgeFunctionsBackgroundSyncService {
  if (!backgroundSyncService) {
    if (!lazyLoader) {
      throw new Error('LazyLoadingService is required to initialize BackgroundSyncService')
    }
    backgroundSyncService = new EdgeFunctionsBackgroundSyncService(lazyLoader)
  }
  return backgroundSyncService
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetBackgroundSyncService(): void {
  if (backgroundSyncService && backgroundSyncService.isRunning()) {
    backgroundSyncService.stopBackgroundSync()
  }
  backgroundSyncService = null
}
