/**
 * Base allocation strategy with common filtering logic
 */

import type { DbInstance } from '../../../db/types.js'
import type { AllocationStrategyType, AllocationContext, AllocationResult } from '../../../types/allocation-strategy.js'

export abstract class BaseAllocationStrategy {
  abstract readonly type: AllocationStrategyType

  abstract select(
    instances: DbInstance[],
    context: AllocationContext,
    config?: Record<string, unknown>
  ): AllocationResult

  /**
   * Filter instances to only those eligible for allocation
   * (active status + capacity available)
   */
  protected filterEligible(instances: DbInstance[]): DbInstance[] {
    return instances.filter(
      (i) => i.status === 'active' && i.current_databases < i.max_databases
    )
  }

  /**
   * Calculate utilization percentage for an instance
   */
  protected calculateUtilization(instance: DbInstance): number {
    if (instance.max_databases === 0) return 100
    return (instance.current_databases / instance.max_databases) * 100
  }

  /**
   * Build an AllocationResult from a selected instance
   */
  protected buildResult(instance: DbInstance, reason: string): AllocationResult {
    return {
      instance_id: instance.id,
      instance_identifier: instance.identifier,
      reason,
    }
  }
}
