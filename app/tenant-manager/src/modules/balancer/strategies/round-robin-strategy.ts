/**
 * Round-robin allocation strategy - simple sequential assignment
 */

import type { DbInstance } from '../../../db/types.js'
import type { AllocationStrategyType, AllocationContext, AllocationResult } from '../../../types/allocation-strategy.js'
import { BaseAllocationStrategy } from './base-strategy.js'

// In-memory counter for round-robin position
let roundRobinCounter = 0

export class RoundRobinStrategy extends BaseAllocationStrategy {
  readonly type: AllocationStrategyType = 'round_robin'

  select(
    instances: DbInstance[],
    _context: AllocationContext,
  ): AllocationResult {
    const eligible = this.filterEligible(instances)
    if (eligible.length === 0) {
      throw new Error('No eligible instances available for allocation')
    }

    // Sort by id for deterministic ordering
    eligible.sort((a, b) => a.id - b.id)

    const index = roundRobinCounter % eligible.length
    roundRobinCounter++

    const selected = eligible[index]!
    return this.buildResult(
      selected,
      `Round-robin selection: position ${index} of ${eligible.length} eligible instances`
    )
  }
}
