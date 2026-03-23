/**
 * Allocation Strategy Validation
 * 
 * Validates allocation strategy configuration and fields
 * 
 * Requirements: 3.3, 7.1
 */

import type {
  AllocationStrategyCreatePayload,
  AllocationStrategyUpdatePayload,
  AllocationStrategyValidationError,
  AllocationStrategyValidationResult,
  StrategyType,
} from './allocation-strategy.types'

/**
 * Valid strategy types
 */
const VALID_STRATEGY_TYPES: StrategyType[] = [
  'manual',
  'hash',
  'round_robin',
  'weighted_round_robin',
  'least_connections',
]

/**
 * Validate strategy type
 * 
 * Property 5: Strategy Type Validation
 * Requirements: 3.3
 */
export function validateStrategyType(strategyType: string): boolean {
  return VALID_STRATEGY_TYPES.includes(strategyType as StrategyType)
}

/**
 * Validate hash strategy configuration
 */
function validateHashConfig(config: Record<string, any> | null | undefined): string[] {
  const errors: string[] = []

  if (!config) {
    return errors // Config is optional for hash strategy
  }

  if (config.hash_key && typeof config.hash_key !== 'string') {
    errors.push('hash_key must be a string')
  }

  if (config.algorithm && typeof config.algorithm !== 'string') {
    errors.push('algorithm must be a string')
  }

  return errors
}

/**
 * Validate weighted round-robin strategy configuration
 */
function validateWeightedRoundRobinConfig(
  config: Record<string, any> | null | undefined
): string[] {
  const errors: string[] = []

  if (!config) {
    return errors // Config is optional
  }

  if (
    config.use_cluster_weight !== undefined &&
    typeof config.use_cluster_weight !== 'boolean'
  ) {
    errors.push('use_cluster_weight must be a boolean')
  }

  return errors
}

/**
 * Validate least connections strategy configuration
 */
function validateLeastConnectionsConfig(
  config: Record<string, any> | null | undefined
): string[] {
  const errors: string[] = []

  if (!config) {
    return errors // Config is optional
  }

  if (
    config.consider_capacity !== undefined &&
    typeof config.consider_capacity !== 'boolean'
  ) {
    errors.push('consider_capacity must be a boolean')
  }

  if (config.threshold_percentage !== undefined) {
    if (typeof config.threshold_percentage !== 'number') {
      errors.push('threshold_percentage must be a number')
    } else if (config.threshold_percentage < 0 || config.threshold_percentage > 100) {
      errors.push('threshold_percentage must be between 0 and 100')
    }
  }

  return errors
}

/**
 * Validate strategy-specific configuration
 * 
 * Requirements: 3.3, 7.1
 */
export function validateStrategyConfig(
  strategyType: StrategyType,
  config: Record<string, any> | null | undefined
): string[] {
  switch (strategyType) {
    case 'hash':
      return validateHashConfig(config)
    case 'weighted_round_robin':
      return validateWeightedRoundRobinConfig(config)
    case 'least_connections':
      return validateLeastConnectionsConfig(config)
    case 'manual':
    case 'round_robin':
      // These strategies don't require specific config validation
      return []
    default:
      return [`Unknown strategy type: ${strategyType}`]
  }
}

/**
 * Validate allocation strategy creation payload
 * 
 * Property 8: Required Fields Validation (adapted for strategies)
 * Requirements: 3.3, 7.1
 */
export function validateAllocationStrategyCreate(
  payload: AllocationStrategyCreatePayload
): AllocationStrategyValidationResult {
  const errors: AllocationStrategyValidationError[] = []

  // Validate required fields
  if (!payload.name || payload.name.trim() === '') {
    errors.push({
      field: 'name',
      message: 'Name is required',
    })
  }

  if (!payload.strategy_type) {
    errors.push({
      field: 'strategy_type',
      message: 'Strategy type is required',
    })
  } else if (!validateStrategyType(payload.strategy_type)) {
    errors.push({
      field: 'strategy_type',
      message: `Strategy type must be one of: ${VALID_STRATEGY_TYPES.join(', ')}`,
    })
  } else {
    // Validate strategy-specific config
    const configErrors = validateStrategyConfig(payload.strategy_type, payload.config)
    configErrors.forEach((error) => {
      errors.push({
        field: 'config',
        message: error,
      })
    })
  }

  // Validate name format (alphanumeric, hyphens, underscores)
  if (payload.name && !/^[a-zA-Z0-9_-]+$/.test(payload.name)) {
    errors.push({
      field: 'name',
      message: 'Name can only contain letters, numbers, hyphens, and underscores',
    })
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Validate allocation strategy update payload
 * 
 * Requirements: 3.3, 7.1
 */
export function validateAllocationStrategyUpdate(
  payload: AllocationStrategyUpdatePayload
): AllocationStrategyValidationResult {
  const errors: AllocationStrategyValidationError[] = []

  // Name is required for updates (used as identifier)
  if (!payload.name || payload.name.trim() === '') {
    errors.push({
      field: 'name',
      message: 'Name is required',
    })
  }

  // Validate strategy type if provided
  if (payload.strategy_type && !validateStrategyType(payload.strategy_type)) {
    errors.push({
      field: 'strategy_type',
      message: `Strategy type must be one of: ${VALID_STRATEGY_TYPES.join(', ')}`,
    })
  }

  // Validate strategy-specific config if both strategy_type and config are provided
  if (payload.strategy_type && payload.config !== undefined) {
    const configErrors = validateStrategyConfig(payload.strategy_type, payload.config)
    configErrors.forEach((error) => {
      errors.push({
        field: 'config',
        message: error,
      })
    })
  }

  // Validate name format
  if (payload.name && !/^[a-zA-Z0-9_-]+$/.test(payload.name)) {
    errors.push({
      field: 'name',
      message: 'Name can only contain letters, numbers, hyphens, and underscores',
    })
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Get validation error messages as a single string
 */
export function getValidationErrorMessage(result: AllocationStrategyValidationResult): string {
  if (result.valid) {
    return ''
  }

  return result.errors.map((error) => `${error.field}: ${error.message}`).join('; ')
}
