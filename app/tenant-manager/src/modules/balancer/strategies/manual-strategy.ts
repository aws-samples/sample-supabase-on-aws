/**
 * Manual allocation strategy - select a specific instance by identifier
 */

import type { DbInstance } from '../../../db/types.js'
import type { AllocationStrategyType, AllocationContext, AllocationResult } from '../../../types/allocation-strategy.js'
import { BaseAllocationStrategy } from './base-strategy.js'

export class ManualStrategy extends BaseAllocationStrategy {
  readonly type: AllocationStrategyType = 'manual'

  select(
    instances: DbInstance[],
    context: AllocationContext,
  ): AllocationResult {
    if (!context.instance_identifier) {
      throw new Error('Manual strategy requires instance_identifier in context')
    }

    const target = instances.find((i) => i.identifier === context.instance_identifier)
    if (!target) {
      throw new Error(`Instance not found: ${context.instance_identifier}`)
    }

    if (target.status !== 'active') {
      throw new Error(`Instance ${context.instance_identifier} is not active (status: ${target.status})`)
    }

    if (target.current_databases >= target.max_databases) {
      throw new Error(`Instance ${context.instance_identifier} is at capacity (${target.current_databases}/${target.max_databases})`)
    }

    return this.buildResult(target, `Manually selected instance ${context.instance_identifier}`)
  }
}
