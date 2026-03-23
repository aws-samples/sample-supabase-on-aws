/**
 * Least-connections allocation strategy
 * Selects the instance with the lowest utilization
 */

import type { DbInstance } from '../../../db/types.js'
import type { AllocationStrategyType, AllocationContext, AllocationResult } from '../../../types/allocation-strategy.js'
import { BaseAllocationStrategy } from './base-strategy.js'

export class LeastConnectionsStrategy extends BaseAllocationStrategy {
  readonly type: AllocationStrategyType = 'least_connections'

  select(
    instances: DbInstance[],
    _context: AllocationContext,
  ): AllocationResult {
    const eligible = this.filterEligible(instances)
    if (eligible.length === 0) {
      throw new Error('No eligible instances available for allocation')
    }

    // Select instance with lowest utilization percentage
    let best = eligible[0]!
    let bestUtilization = this.calculateUtilization(best)

    for (let i = 1; i < eligible.length; i++) {
      const utilization = this.calculateUtilization(eligible[i]!)
      if (utilization < bestUtilization) {
        best = eligible[i]!
        bestUtilization = utilization
      }
    }

    return this.buildResult(
      best,
      `Least-connections selection: ${best.current_databases}/${best.max_databases} (${bestUtilization.toFixed(1)}% utilization)`
    )
  }
}
