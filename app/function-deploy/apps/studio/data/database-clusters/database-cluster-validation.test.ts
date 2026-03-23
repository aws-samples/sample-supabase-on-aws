/**
 * Database Cluster Validation Tests
 * 
 * Unit tests for cluster validation logic
 * Validates: Requirements 2.3, 2.4, 4.1, 8.1
 */

import { describe, it, expect } from 'vitest'
import {
  validateStatus,
  validateAuthMethod,
  validateClusterCreate,
  validateClusterUpdate,
  validateClusterDelete,
  calculateUtilization,
  calculateClusterMetrics,
} from './database-cluster-validation'
import type { Cluster, ClusterCreatePayload, ClusterUpdatePayload } from './database-cluster.types'

describe('validateStatus', () => {
  it('should accept valid status values', () => {
    expect(validateStatus('online')).toBe(true)
    expect(validateStatus('offline')).toBe(true)
    expect(validateStatus('maintenance')).toBe(true)
  })

  it('should reject invalid status values', () => {
    expect(validateStatus('invalid')).toBe(false)
    expect(validateStatus('active')).toBe(false)
    expect(validateStatus('')).toBe(false)
  })
})

describe('validateAuthMethod', () => {
  it('should accept valid auth method values', () => {
    expect(validateAuthMethod('password')).toBe(true)
    expect(validateAuthMethod('secrets_manager')).toBe(true)
  })

  it('should reject invalid auth method values', () => {
    expect(validateAuthMethod('invalid')).toBe(false)
    expect(validateAuthMethod('oauth')).toBe(false)
    expect(validateAuthMethod('')).toBe(false)
  })
})

describe('validateClusterCreate', () => {
  const validPayload: ClusterCreatePayload = {
    identifier: 'cluster-1',
    name: 'Test Cluster',
    host: 'db.example.com',
    port: 5432,
    admin_user: 'postgres',
    auth_method: 'password',
    credential: 'secret123',
    region: 'us-east-1',
    weight: 100,
    max_databases: 500,
  }

  it('should validate a complete valid payload', () => {
    const result = validateClusterCreate(validPayload)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('should require identifier', () => {
    const payload = { ...validPayload, identifier: '' }
    const result = validateClusterCreate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'identifier')).toBe(true)
  })

  it('should require name', () => {
    const payload = { ...validPayload, name: '' }
    const result = validateClusterCreate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'name')).toBe(true)
  })

  it('should require host', () => {
    const payload = { ...validPayload, host: '' }
    const result = validateClusterCreate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'host')).toBe(true)
  })

  it('should require auth_method', () => {
    const payload = { ...validPayload, auth_method: undefined as any }
    const result = validateClusterCreate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'auth_method')).toBe(true)
  })

  it('should validate auth_method value', () => {
    const payload = { ...validPayload, auth_method: 'invalid' as any }
    const result = validateClusterCreate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'auth_method')).toBe(true)
  })

  it('should require credential', () => {
    const payload = { ...validPayload, credential: '' }
    const result = validateClusterCreate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'credential')).toBe(true)
  })

  it('should validate port range', () => {
    const invalidLow = { ...validPayload, port: 0 }
    const resultLow = validateClusterCreate(invalidLow)
    expect(resultLow.valid).toBe(false)
    expect(resultLow.errors.some((e) => e.field === 'port')).toBe(true)

    const invalidHigh = { ...validPayload, port: 70000 }
    const resultHigh = validateClusterCreate(invalidHigh)
    expect(resultHigh.valid).toBe(false)
    expect(resultHigh.errors.some((e) => e.field === 'port')).toBe(true)
  })

  it('should validate weight is non-negative', () => {
    const payload = { ...validPayload, weight: -1 }
    const result = validateClusterCreate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'weight')).toBe(true)
  })

  it('should validate max_databases is at least 1', () => {
    const payload = { ...validPayload, max_databases: 0 }
    const result = validateClusterCreate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'max_databases')).toBe(true)
  })

  it('should accept payload with optional fields omitted', () => {
    const minimalPayload: ClusterCreatePayload = {
      identifier: 'cluster-1',
      name: 'Test Cluster',
      host: 'db.example.com',
      auth_method: 'password',
      credential: 'secret123',
    }
    const result = validateClusterCreate(minimalPayload)
    expect(result.valid).toBe(true)
  })
})

describe('validateClusterUpdate', () => {
  const currentCluster: Cluster = {
    id: 1,
    identifier: 'cluster-1',
    name: 'Test Cluster',
    host: 'db.example.com',
    port: 5432,
    admin_user: 'postgres',
    auth_method: 'password',
    admin_credential: 'encrypted:abc123',
    is_management_instance: false,
    region: 'us-east-1',
    status: 'online',
    weight: 100,
    max_databases: 500,
    current_databases: 100,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }

  it('should validate a valid update payload', () => {
    const payload: ClusterUpdatePayload = {
      identifier: 'cluster-1',
      name: 'Updated Name',
      status: 'offline',
    }
    const result = validateClusterUpdate(payload, currentCluster)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('should require identifier', () => {
    const payload: ClusterUpdatePayload = {
      identifier: '',
      name: 'Updated Name',
    }
    const result = validateClusterUpdate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'identifier')).toBe(true)
  })

  it('should validate status value', () => {
    const payload: ClusterUpdatePayload = {
      identifier: 'cluster-1',
      status: 'invalid' as any,
    }
    const result = validateClusterUpdate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'status')).toBe(true)
  })

  it('should validate weight is non-negative', () => {
    const payload: ClusterUpdatePayload = {
      identifier: 'cluster-1',
      weight: -1,
    }
    const result = validateClusterUpdate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'weight')).toBe(true)
  })

  it('should validate max_databases is at least 1', () => {
    const payload: ClusterUpdatePayload = {
      identifier: 'cluster-1',
      max_databases: 0,
    }
    const result = validateClusterUpdate(payload)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'max_databases')).toBe(true)
  })

  it('should reject max_databases less than or equal to current_databases', () => {
    const payload: ClusterUpdatePayload = {
      identifier: 'cluster-1',
      max_databases: 100, // Equal to current_databases
    }
    const result = validateClusterUpdate(payload, currentCluster)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'max_databases')).toBe(true)

    const payload2: ClusterUpdatePayload = {
      identifier: 'cluster-1',
      max_databases: 50, // Less than current_databases
    }
    const result2 = validateClusterUpdate(payload2, currentCluster)
    expect(result2.valid).toBe(false)
    expect(result2.errors.some((e) => e.field === 'max_databases')).toBe(true)
  })

  it('should accept max_databases greater than current_databases', () => {
    const payload: ClusterUpdatePayload = {
      identifier: 'cluster-1',
      max_databases: 600,
    }
    const result = validateClusterUpdate(payload, currentCluster)
    expect(result.valid).toBe(true)
  })
})

describe('validateClusterDelete', () => {
  it('should allow deletion when current_databases is 0', () => {
    const cluster: Cluster = {
      id: 1,
      identifier: 'cluster-1',
      name: 'Test Cluster',
      host: 'db.example.com',
      port: 5432,
      admin_user: 'postgres',
      auth_method: 'password',
      admin_credential: 'encrypted:abc123',
      is_management_instance: false,
      region: 'us-east-1',
      status: 'offline',
      weight: 100,
      max_databases: 500,
      current_databases: 0,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    }
    const result = validateClusterDelete(cluster)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('should reject deletion when current_databases > 0', () => {
    const cluster: Cluster = {
      id: 1,
      identifier: 'cluster-1',
      name: 'Test Cluster',
      host: 'db.example.com',
      port: 5432,
      admin_user: 'postgres',
      auth_method: 'password',
      admin_credential: 'encrypted:abc123',
      is_management_instance: false,
      region: 'us-east-1',
      status: 'offline',
      weight: 100,
      max_databases: 500,
      current_databases: 10,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    }
    const result = validateClusterDelete(cluster)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'current_databases')).toBe(true)
  })
})

describe('calculateUtilization', () => {
  it('should calculate utilization percentage correctly', () => {
    expect(calculateUtilization(50, 100)).toBe(50)
    expect(calculateUtilization(100, 100)).toBe(100)
    expect(calculateUtilization(0, 100)).toBe(0)
    expect(calculateUtilization(25, 100)).toBe(25)
  })

  it('should handle zero max_databases', () => {
    expect(calculateUtilization(0, 0)).toBe(0)
  })

  it('should calculate decimal percentages', () => {
    expect(calculateUtilization(33, 100)).toBe(33)
    expect(calculateUtilization(1, 3)).toBeCloseTo(33.33, 2)
  })
})

describe('calculateClusterMetrics', () => {
  it('should calculate cluster metrics correctly', () => {
    const cluster: Cluster = {
      id: 1,
      identifier: 'cluster-1',
      name: 'Test Cluster',
      host: 'db.example.com',
      port: 5432,
      admin_user: 'postgres',
      auth_method: 'password',
      admin_credential: 'encrypted:abc123',
      is_management_instance: false,
      region: 'us-east-1',
      status: 'online',
      weight: 100,
      max_databases: 500,
      current_databases: 250,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    }

    const metrics = calculateClusterMetrics(cluster)

    expect(metrics.identifier).toBe('cluster-1')
    expect(metrics.max_databases).toBe(500)
    expect(metrics.current_databases).toBe(250)
    expect(metrics.utilization_percentage).toBe(50)
    expect(metrics.available_capacity).toBe(250)
  })

  it('should handle full capacity', () => {
    const cluster: Cluster = {
      id: 1,
      identifier: 'cluster-1',
      name: 'Test Cluster',
      host: 'db.example.com',
      port: 5432,
      admin_user: 'postgres',
      auth_method: 'password',
      admin_credential: 'encrypted:abc123',
      is_management_instance: false,
      region: 'us-east-1',
      status: 'online',
      weight: 100,
      max_databases: 100,
      current_databases: 100,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    }

    const metrics = calculateClusterMetrics(cluster)

    expect(metrics.utilization_percentage).toBe(100)
    expect(metrics.available_capacity).toBe(0)
  })

  it('should handle empty cluster', () => {
    const cluster: Cluster = {
      id: 1,
      identifier: 'cluster-1',
      name: 'Test Cluster',
      host: 'db.example.com',
      port: 5432,
      admin_user: 'postgres',
      auth_method: 'password',
      admin_credential: 'encrypted:abc123',
      is_management_instance: false,
      region: 'us-east-1',
      status: 'online',
      weight: 100,
      max_databases: 100,
      current_databases: 0,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    }

    const metrics = calculateClusterMetrics(cluster)

    expect(metrics.utilization_percentage).toBe(0)
    expect(metrics.available_capacity).toBe(100)
  })
})
