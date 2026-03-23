/**
 * Allocation strategy types for multi-RDS cluster management
 */

// Strategy types supported by the allocation system
export type AllocationStrategyType =
  | 'manual'
  | 'hash'
  | 'round_robin'
  | 'weighted_round_robin'
  | 'least_connections'
  | 'region_affinity'

// Allocation strategy record from DB
export interface AllocationStrategy {
  id: string
  name: string
  strategy_type: AllocationStrategyType
  description: string | null
  config: Record<string, unknown> | null
  is_active: boolean
  created_at: Date
  updated_at: Date
}

// Context provided for allocation decisions
export interface AllocationContext {
  project_ref: string
  organization_id: number
  region?: string
  instance_identifier?: string
}

// Result of an allocation decision
export interface AllocationResult {
  instance_id: number
  instance_identifier: string
  reason: string
}

// Input for creating/updating a strategy
export interface CreateAllocationStrategyInput {
  name: string
  strategy_type: AllocationStrategyType
  description?: string
  config?: Record<string, unknown>
  is_active?: boolean
}

export interface UpdateAllocationStrategyInput {
  strategy_type?: AllocationStrategyType
  description?: string
  config?: Record<string, unknown>
  is_active?: boolean
}
