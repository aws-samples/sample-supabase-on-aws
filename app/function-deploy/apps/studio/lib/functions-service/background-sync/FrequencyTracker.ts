/**
 * Frequency Tracker for Edge Functions
 * 
 * Tracks function access patterns to identify frequently accessed functions
 * for background sync prioritization.
 * 
 * Features:
 * - In-memory tracking of function access counts
 * - Automatic decay of old access patterns
 * - Configurable tracking window
 * - Thread-safe access counting
 */

import { FrequentFunction } from './BackgroundSyncService'

/**
 * Function access record
 */
interface FunctionAccessRecord {
  projectRef: string
  functionSlug: string
  accessCount: number
  lastAccessed: Date
  firstAccessed: Date
}

/**
 * Frequency Tracker Configuration
 */
export interface FrequencyTrackerConfig {
  /** Maximum number of functions to track (default: 1000) */
  maxTrackedFunctions?: number
  /** Time window for access tracking in milliseconds (default: 3600000 = 1 hour) */
  trackingWindowMs?: number
  /** Decay factor for old accesses (default: 0.9) */
  decayFactor?: number
}

/**
 * Frequency Tracker Interface
 */
export interface FrequencyTracker {
  /**
   * Record a function access
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function identifier
   */
  recordAccess(projectRef: string, functionSlug: string): void

  /**
   * Get frequently accessed functions
   * 
   * @param limit - Maximum number of functions to return
   * @returns List of frequently accessed functions sorted by access count
   */
  getFrequentFunctions(limit?: number): FrequentFunction[]

  /**
   * Get access count for a specific function
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function identifier
   * @returns Access count
   */
  getAccessCount(projectRef: string, functionSlug: string): number

  /**
   * Clear all tracking data
   */
  clear(): void

  /**
   * Apply decay to old access patterns
   * 
   * Reduces access counts for functions not accessed recently.
   */
  applyDecay(): void

  /**
   * Get total number of tracked functions
   */
  getTrackedFunctionCount(): number
}

/**
 * Edge Functions Frequency Tracker Implementation
 */
export class EdgeFunctionsFrequencyTracker implements FrequencyTracker {
  private accessRecords: Map<string, FunctionAccessRecord>
  private maxTrackedFunctions: number
  private trackingWindowMs: number
  private decayFactor: number

  constructor(config: FrequencyTrackerConfig = {}) {
    this.accessRecords = new Map()
    this.maxTrackedFunctions = config.maxTrackedFunctions || 1000
    this.trackingWindowMs = config.trackingWindowMs || 3600000 // 1 hour
    this.decayFactor = config.decayFactor || 0.9

    console.log('[FrequencyTracker] Initialized', {
      maxTrackedFunctions: this.maxTrackedFunctions,
      trackingWindowMs: this.trackingWindowMs,
      decayFactor: this.decayFactor,
    })
  }

  /**
   * Record a function access
   */
  recordAccess(projectRef: string, functionSlug: string): void {
    const key = this.getKey(projectRef, functionSlug)
    const now = new Date()

    const existing = this.accessRecords.get(key)

    if (existing) {
      // Update existing record
      existing.accessCount++
      existing.lastAccessed = now
    } else {
      // Create new record
      this.accessRecords.set(key, {
        projectRef,
        functionSlug,
        accessCount: 1,
        lastAccessed: now,
        firstAccessed: now,
      })

      // Enforce max tracked functions limit
      if (this.accessRecords.size > this.maxTrackedFunctions) {
        this.evictLeastFrequent()
      }
    }
  }

  /**
   * Get frequently accessed functions
   */
  getFrequentFunctions(limit: number = 100): FrequentFunction[] {
    // Convert records to FrequentFunction array
    const functions: FrequentFunction[] = Array.from(this.accessRecords.values()).map(
      (record) => ({
        projectRef: record.projectRef,
        functionSlug: record.functionSlug,
        accessCount: record.accessCount,
        lastAccessed: record.lastAccessed,
      })
    )

    // Sort by access count (descending) and last accessed (most recent first)
    functions.sort((a, b) => {
      if (b.accessCount !== a.accessCount) {
        return b.accessCount - a.accessCount
      }
      return new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime()
    })

    // Return top N functions
    return functions.slice(0, limit)
  }

  /**
   * Get access count for a specific function
   */
  getAccessCount(projectRef: string, functionSlug: string): number {
    const key = this.getKey(projectRef, functionSlug)
    const record = this.accessRecords.get(key)
    return record ? record.accessCount : 0
  }

  /**
   * Clear all tracking data
   */
  clear(): void {
    this.accessRecords.clear()
    console.log('[FrequencyTracker] All tracking data cleared')
  }

  /**
   * Apply decay to old access patterns
   * 
   * Reduces access counts for functions not accessed within the tracking window.
   * Removes functions with very low access counts.
   */
  applyDecay(): void {
    const now = Date.now()
    const cutoffTime = now - this.trackingWindowMs
    let decayedCount = 0
    let removedCount = 0

    for (const [key, record] of this.accessRecords.entries()) {
      const lastAccessTime = record.lastAccessed.getTime()

      // If not accessed within tracking window, apply decay
      if (lastAccessTime < cutoffTime) {
        record.accessCount = Math.floor(record.accessCount * this.decayFactor)
        decayedCount++

        // Remove if access count is very low
        if (record.accessCount < 1) {
          this.accessRecords.delete(key)
          removedCount++
        }
      }
    }

    if (decayedCount > 0 || removedCount > 0) {
      console.log(
        `[FrequencyTracker] Applied decay: ${decayedCount} functions decayed, ${removedCount} removed`
      )
    }
  }

  /**
   * Get total number of tracked functions
   */
  getTrackedFunctionCount(): number {
    return this.accessRecords.size
  }

  /**
   * Generate key for function access record
   */
  private getKey(projectRef: string, functionSlug: string): string {
    return `${projectRef}/${functionSlug}`
  }

  /**
   * Evict least frequently accessed function
   * 
   * Called when max tracked functions limit is reached.
   */
  private evictLeastFrequent(): void {
    let minAccessCount = Infinity
    let minKey: string | null = null

    // Find function with lowest access count
    for (const [key, record] of this.accessRecords.entries()) {
      if (record.accessCount < minAccessCount) {
        minAccessCount = record.accessCount
        minKey = key
      }
    }

    // Remove least frequent function
    if (minKey) {
      this.accessRecords.delete(minKey)
      console.log(
        `[FrequencyTracker] Evicted least frequent function (access count: ${minAccessCount})`
      )
    }
  }

  /**
   * Get statistics about tracked functions
   */
  getStats(): {
    totalTracked: number
    totalAccesses: number
    avgAccessCount: number
    maxAccessCount: number
    minAccessCount: number
  } {
    const records = Array.from(this.accessRecords.values())

    if (records.length === 0) {
      return {
        totalTracked: 0,
        totalAccesses: 0,
        avgAccessCount: 0,
        maxAccessCount: 0,
        minAccessCount: 0,
      }
    }

    const totalAccesses = records.reduce((sum, record) => sum + record.accessCount, 0)
    const accessCounts = records.map((record) => record.accessCount)

    return {
      totalTracked: records.length,
      totalAccesses,
      avgAccessCount: totalAccesses / records.length,
      maxAccessCount: Math.max(...accessCounts),
      minAccessCount: Math.min(...accessCounts),
    }
  }
}

/**
 * Singleton instance
 */
let frequencyTracker: EdgeFunctionsFrequencyTracker | null = null

/**
 * Get the singleton FrequencyTracker instance
 */
export function getFrequencyTracker(
  config?: FrequencyTrackerConfig
): EdgeFunctionsFrequencyTracker {
  if (!frequencyTracker) {
    frequencyTracker = new EdgeFunctionsFrequencyTracker(config)
  }
  return frequencyTracker
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetFrequencyTracker(): void {
  frequencyTracker = null
}
