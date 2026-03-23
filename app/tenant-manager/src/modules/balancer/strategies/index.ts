/**
 * Strategy registry - factory for allocation strategy implementations
 */

import type { AllocationStrategyType } from '../../../types/allocation-strategy.js'
import type { BaseAllocationStrategy } from './base-strategy.js'
import { ManualStrategy } from './manual-strategy.js'
import { HashStrategy } from './hash-strategy.js'
import { RoundRobinStrategy } from './round-robin-strategy.js'
import { WeightedRoundRobinStrategy } from './weighted-round-robin-strategy.js'
import { LeastConnectionsStrategy } from './least-connections-strategy.js'
import { RegionAffinityStrategy } from './region-affinity-strategy.js'

// Singleton instances
const strategies: Record<AllocationStrategyType, BaseAllocationStrategy> = {
  manual: new ManualStrategy(),
  hash: new HashStrategy(),
  round_robin: new RoundRobinStrategy(),
  weighted_round_robin: new WeightedRoundRobinStrategy(),
  least_connections: new LeastConnectionsStrategy(),
  region_affinity: new RegionAffinityStrategy(),
}

/**
 * Get a strategy implementation by type
 */
export function getStrategy(type: AllocationStrategyType): BaseAllocationStrategy {
  const strategy = strategies[type]
  if (!strategy) {
    throw new Error(`Unknown allocation strategy: ${type}`)
  }
  return strategy
}

/**
 * List all available strategy types
 */
export function getAvailableStrategyTypes(): AllocationStrategyType[] {
  return Object.keys(strategies) as AllocationStrategyType[]
}
