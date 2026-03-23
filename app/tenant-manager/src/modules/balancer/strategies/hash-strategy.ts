/**
 * Hash-based allocation strategy - deterministic assignment via SHA-256 hash
 */

import crypto from 'crypto'
import type { DbInstance } from '../../../db/types.js'
import type { AllocationStrategyType, AllocationContext, AllocationResult } from '../../../types/allocation-strategy.js'
import { BaseAllocationStrategy } from './base-strategy.js'

export class HashStrategy extends BaseAllocationStrategy {
  readonly type: AllocationStrategyType = 'hash'

  select(
    instances: DbInstance[],
    context: AllocationContext,
  ): AllocationResult {
    const eligible = this.filterEligible(instances)
    if (eligible.length === 0) {
      throw new Error('No eligible instances available for allocation')
    }

    // Sort by id for deterministic ordering
    eligible.sort((a, b) => a.id - b.id)

    const hash = crypto.createHash('sha256').update(context.project_ref).digest()
    // Use first 4 bytes as a 32-bit unsigned integer
    const hashValue = hash.readUInt32BE(0)
    const index = hashValue % eligible.length

    const selected = eligible[index]!
    return this.buildResult(
      selected,
      `Hash-based selection: SHA-256(${context.project_ref}) mod ${eligible.length} = index ${index}`
    )
  }
}
