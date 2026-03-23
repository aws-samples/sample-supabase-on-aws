/**
 * Allocation Strategy Types
 * 
 * These types define the structure for allocation strategy management,
 * including strategy configuration and validation.
 * 
 * Requirements: 3.1, 7.1, 7.2
 */

export type StrategyType =
  | 'manual'
  | 'hash'
  | 'round_robin'
  | 'weighted_round_robin'
  | 'least_connections'

/**
 * AllocationStrategy represents a configured allocation algorithm
 * that determines how new projects are assigned to database clusters
 */
export interface AllocationStrategy {
  id: string
  name: string
  strategy_type: StrategyType
  description: string | null
  config: Record<string, any> | null
  is_active: boolean
  created_at: string
  updated_at: string
}

/**
 * AllocationStrategyCreatePayload defines the required fields for creating a new strategy
 */
export interface AllocationStrategyCreatePayload {
  name: string
  strategy_type: StrategyType
  description?: string
  config?: Record<string, any>
  is_active?: boolean
}

/**
 * AllocationStrategyUpdatePayload defines fields that can be updated for an existing strategy
 */
export interface AllocationStrategyUpdatePayload {
  name: string
  strategy_type?: StrategyType
  description?: string
  config?: Record<string, any>
  is_active?: boolean
}

/**
 * AllocationStrategyValidationError represents validation errors for strategy operations
 */
export interface AllocationStrategyValidationError {
  field: string
  message: string
}

/**
 * AllocationStrategyValidationResult contains validation results
 */
export interface AllocationStrategyValidationResult {
  valid: boolean
  errors: AllocationStrategyValidationError[]
}
