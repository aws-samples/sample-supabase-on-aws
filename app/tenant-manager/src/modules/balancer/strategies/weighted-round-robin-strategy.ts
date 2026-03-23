/**
 * Weighted round-robin allocation strategy
 * Assigns instances based on their weight values
 */

import type { DbInstance } from '../../../db/types.js'
import type { AllocationStrategyType, AllocationContext, AllocationResult } from '../../../types/allocation-strategy.js'
import { BaseAllocationStrategy } from './base-strategy.js'

// In-memory state for weighted round-robin
let weightedCounter = 0

export class WeightedRoundRobinStrategy extends BaseAllocationStrategy {
  readonly type: AllocationStrategyType = 'weighted_round_robin'

  select(
    instances: DbInstance[],
    _context: AllocationContext,
  ): AllocationResult {
    const eligible = this.filterEligible(instances)
    if (eligible.length === 0) {
      throw new Error('No eligible instances available for allocation')
    }

    // Build a weighted list: each instance appears proportionally to its weight
    // Normalize weights relative to the minimum weight to keep the array manageable
    const minWeight = Math.max(1, Math.min(...eligible.map((i) => i.weight)))
    const weightedList: DbInstance[] = []
    for (const instance of eligible) {
      const slots = Math.max(1, Math.round(instance.weight / minWeight))
      for (let i = 0; i < slots; i++) {
        weightedList.push(instance)
      }
    }

    const index = weightedCounter % weightedList.length
    weightedCounter++

    const selected = weightedList[index]!
    return this.buildResult(
      selected,
      `Weighted round-robin selection: instance weight ${selected.weight}, position ${index} of ${weightedList.length} weighted slots`
    )
  }
}
