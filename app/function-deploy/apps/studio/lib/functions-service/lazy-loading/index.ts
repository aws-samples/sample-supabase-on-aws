/**
 * Lazy Loading Module
 * 
 * Exports lazy loading service and related types for Edge Functions.
 */

export {
  EdgeFunctionsLazyLoadingService,
  getLazyLoadingService,
  resetLazyLoadingService,
  type LazyLoadingService,
  type LoadResult,
  type LazyLoadingStats,
} from './LazyLoadingService'
