/**
 * Query keys for allocation strategies
 * 
 * These keys are used for React Query caching and invalidation
 */

export const allocationStrategyKeys = {
  list: (projectRef: string | undefined) =>
    ['projects', projectRef, 'allocation-strategies'] as const,
  strategy: (projectRef: string | undefined, name: string | undefined) =>
    ['projects', projectRef, 'allocation-strategies', name] as const,
  active: (projectRef: string | undefined) =>
    ['projects', projectRef, 'allocation-strategies', 'active'] as const,
}
