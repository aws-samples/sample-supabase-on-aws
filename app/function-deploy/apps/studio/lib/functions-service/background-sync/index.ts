/**
 * Background Sync Module
 * 
 * Exports background sync service and related types.
 */

export {
  EdgeFunctionsBackgroundSyncService,
  getBackgroundSyncService,
  resetBackgroundSyncService,
} from './BackgroundSyncService'

export type {
  BackgroundSyncService,
  FrequentFunction,
  SyncResult,
  BackgroundSyncStats,
} from './BackgroundSyncService'

export {
  EdgeFunctionsFrequencyTracker,
  getFrequencyTracker,
  resetFrequencyTracker,
} from './FrequencyTracker'

export type {
  FrequencyTracker,
  FrequencyTrackerConfig,
} from './FrequencyTracker'
