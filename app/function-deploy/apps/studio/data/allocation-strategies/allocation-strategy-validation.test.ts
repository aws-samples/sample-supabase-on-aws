/**
 * Allocation Strategy Validation Tests
 * 
 * Tests for allocation strategy validation logic
 * 
 * Requirements: 3.3, 7.1
 */

import { describe, it, expect } from 'vitest'
import {
  validateStrategyType,
  validateStrategyConfig,
  validateAllocationStrategyCreate,
  validateAllocationStrategyUpdate,
  getValidationErrorMessage,
} from './allocation-strategy-validation'
import type {
  AllocationStrategyCreatePayload,
  AllocationStrategyUpdatePayload,
} from './allocation-strategy.types'

describe('validateStrategyType', () => {
  it('should accept valid strategy types', () => {
    expect(validateStrategyType('manual')).toBe(true)
    expect(validateStrategyType('hash')).toBe(true)
    expect(validateStrategyType('round_robin')).toBe(true)
    expect(validateStrategyType('weighted_round_robin')).toBe(true)
    expect(validateStrategyType('least_connections')).toBe(true)
  })

  it('should reject invalid strategy types', () => {
    expect(validateStrategyType('invalid')).toBe(false)
    expect(validateStrategyType('random')).toBe(false)
    expect(validateStrategyType('')).toBe(false)
  })
})

describe('validateStrategyConfig', () => {
  it('should validate hash strategy config', () => {
    expect(validateStrategyConfig('hash', null)).toEqual([])
    expect(validateStrategyConfig('hash', {})).toEqual([])
    expect(
      validateStrategyConfig('hash', {
        hash_key: 'project_id',
        algorithm: 'consistent_hash',
      })
    ).toEqual([])

    const errors = validateStrategyConfig('hash', {
      hash_key: 123, // Should be string
    })
    expect(errors).toContain('hash_key must be a string')
  })

  it('should validate weighted round-robin strategy config', () => {
    expect(validateStrategyConfig('weighted_round_robin', null)).toEqual([])
    expect(validateStrategyConfig('weighted_round_robin', {})).toEqual([])
    expect(
      validateStrategyConfig('weighted_round_robin', {
        use_cluster_weight: true,
      })
    ).toEqual([])

    const errors = validateStrategyConfig('weighted_round_robin', {
      use_cluster_weight: 'yes', // Should be boolean
    })
    expect(errors).toContain('use_cluster_weight must be a boolean')
  })

  it('should validate least connections strategy config', () => {
    expect(validateStrategyConfig('least_connections', null)).toEqual([])
    expect(validateStrategyConfig('least_connections', {})).toEqual([])
    expect(
      validateStrategyConfig('least_connections', {
        consider_capacity: true,
        threshold_percentage: 80,
      })
    ).toEqual([])

    const errors1 = validateStrategyConfig('least_connections', {
      threshold_percentage: 150, // Out of range
    })
    expect(errors1).toContain('threshold_percentage must be between 0 and 100')

    const errors2 = validateStrategyConfig('least_connections', {
      threshold_percentage: 'high', // Should be number
    })
    expect(errors2).toContain('threshold_percentage must be a number')
  })

  it('should accept manual and round_robin without config validation', () => {
    expect(validateStrategyConfig('manual', null)).toEqual([])
    expect(validateStrategyConfig('round_robin', null)).toEqual([])
    expect(validateStrategyConfig('manual', { any: 'value' })).toEqual([])
  })
})

describe('validateAllocationStrategyCreate', () => {
  it('should validate a valid create payload', () => {
    const payload: AllocationStrategyCreatePayload = {
      name: 'production-weighted',
      strategy_type: 'weighted_round_robin',
      description: 'Production weighted allocation',
      config: { use_cluster_weight: true },
      is_active: true,
    }

    const result = validateAllocationStrategyCreate(payload)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('should reject payload with missing name', () => {
    const payload: AllocationStrategyCreatePayload = {
      name: '',
      strategy_type: 'hash',
    }

    const result = validateAllocationStrategyCreate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual({
      field: 'name',
      message: 'Name is required',
    })
  })

  it('should reject payload with invalid strategy type', () => {
    const payload: any = {
      name: 'test-strategy',
      strategy_type: 'invalid_type',
    }

    const result = validateAllocationStrategyCreate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'strategy_type')).toBe(true)
  })

  it('should reject payload with invalid name format', () => {
    const payload: AllocationStrategyCreatePayload = {
      name: 'invalid name with spaces',
      strategy_type: 'hash',
    }

    const result = validateAllocationStrategyCreate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual({
      field: 'name',
      message: 'Name can only contain letters, numbers, hyphens, and underscores',
    })
  })

  it('should reject payload with invalid config', () => {
    const payload: AllocationStrategyCreatePayload = {
      name: 'test-strategy',
      strategy_type: 'least_connections',
      config: {
        threshold_percentage: 150, // Out of range
      },
    }

    const result = validateAllocationStrategyCreate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'config')).toBe(true)
  })

  it('should accept valid name formats', () => {
    const validNames = [
      'simple',
      'with-hyphens',
      'with_underscores',
      'MixedCase123',
      'production-weighted-v2',
    ]

    validNames.forEach((name) => {
      const payload: AllocationStrategyCreatePayload = {
        name,
        strategy_type: 'hash',
      }

      const result = validateAllocationStrategyCreate(payload)
      expect(result.valid).toBe(true)
    })
  })
})

describe('validateAllocationStrategyUpdate', () => {
  it('should validate a valid update payload', () => {
    const payload: AllocationStrategyUpdatePayload = {
      name: 'production-weighted',
      strategy_type: 'weighted_round_robin',
      description: 'Updated description',
      is_active: false,
    }

    const result = validateAllocationStrategyUpdate(payload)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('should reject payload with missing name', () => {
    const payload: AllocationStrategyUpdatePayload = {
      name: '',
      description: 'Updated',
    }

    const result = validateAllocationStrategyUpdate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual({
      field: 'name',
      message: 'Name is required',
    })
  })

  it('should reject payload with invalid strategy type', () => {
    const payload: any = {
      name: 'test-strategy',
      strategy_type: 'invalid_type',
    }

    const result = validateAllocationStrategyUpdate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'strategy_type')).toBe(true)
  })

  it('should validate config when both strategy_type and config are provided', () => {
    const payload: AllocationStrategyUpdatePayload = {
      name: 'test-strategy',
      strategy_type: 'least_connections',
      config: {
        threshold_percentage: 200, // Invalid
      },
    }

    const result = validateAllocationStrategyUpdate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'config')).toBe(true)
  })
})

describe('getValidationErrorMessage', () => {
  it('should return empty string for valid result', () => {
    const result = {
      valid: true,
      errors: [],
    }

    expect(getValidationErrorMessage(result)).toBe('')
  })

  it('should format error messages', () => {
    const result = {
      valid: false,
      errors: [
        { field: 'name', message: 'Name is required' },
        { field: 'strategy_type', message: 'Invalid type' },
      ],
    }

    const message = getValidationErrorMessage(result)
    expect(message).toContain('name: Name is required')
    expect(message).toContain('strategy_type: Invalid type')
  })
})
