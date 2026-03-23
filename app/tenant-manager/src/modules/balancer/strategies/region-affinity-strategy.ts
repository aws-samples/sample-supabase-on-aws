/**
 * Region-affinity allocation strategy
 * Prefers instances in the same region, falls back to least-connections
 */

import type { DbInstance } from '../../../db/types.js'
import type { AllocationStrategyType, AllocationContext, AllocationResult } from '../../../types/allocation-strategy.js'
import { BaseAllocationStrategy } from './base-strategy.js'
import { LeastConnectionsStrategy } from './least-connections-strategy.js'

const leastConnections = new LeastConnectionsStrategy()

export class RegionAffinityStrategy extends BaseAllocationStrategy {
  readonly type: AllocationStrategyType = 'region_affinity'

  select(
    instances: DbInstance[],
    context: AllocationContext,
  ): AllocationResult {
    const eligible = this.filterEligible(instances)
    if (eligible.length === 0) {
      throw new Error('No eligible instances available for allocation')
    }

    if (!context.region) {
      // No region preference, fall back to least_connections
      const result = leastConnections.select(instances, context)
      return {
        ...result,
        reason: `Region affinity fallback (no region specified): ${result.reason}`,
      }
    }

    // Try to find instances in the preferred region
    const regionInstances = eligible.filter((i) => i.region === context.region)

    if (regionInstances.length > 0) {
      // Select the least-loaded instance in the preferred region
      let best = regionInstances[0]!
      let bestUtilization = this.calculateUtilization(best)

      for (let i = 1; i < regionInstances.length; i++) {
        const utilization = this.calculateUtilization(regionInstances[i]!)
        if (utilization < bestUtilization) {
          best = regionInstances[i]!
          bestUtilization = utilization
        }
      }

      return this.buildResult(
        best,
        `Region affinity: matched region '${context.region}', ${best.current_databases}/${best.max_databases} (${bestUtilization.toFixed(1)}% utilization)`
      )
    }

    // No instances in preferred region, fall back to least_connections across all
    const result = leastConnections.select(instances, context)
    return {
      ...result,
      reason: `Region affinity fallback (no instances in '${context.region}'): ${result.reason}`,
    }
  }
}
