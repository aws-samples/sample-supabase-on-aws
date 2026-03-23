/**
 * Unit tests for rds-balancer service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { calculateLoadScore } from '../../src/modules/balancer/rds-balancer.service.js'
import type { InstanceMetrics } from '../../src/types/index.js'
import type { DbInstance } from '../../src/db/types.js'

// Mock the config module
vi.mock('../../src/config/index.js', () => ({
  getEnv: () => ({
    ADMIN_API_KEY: 'test-api-key',
    JWT_SECRET: 'test-jwt-secret',
    ENCRYPTION_KEY: 'test-encryption-key-32-chars!!!!!',
    POSTGRES_HOST: 'db',
    POSTGRES_PORT: 5432,
    POSTGRES_PASSWORD: 'postgres',
    POSTGRES_DB: 'postgres',
    POSTGRES_USER_READ_WRITE: 'supabase_admin',
    POSTGRES_USER_READ_ONLY: 'supabase_read_only_user',
  }),
}))

describe('rds-balancer', () => {
  describe('calculateLoadScore', () => {
    const createMockInstance = (overrides: Partial<DbInstance> = {}): DbInstance => ({
      id: 1,
      identifier: 'test-instance',
      name: 'Test Instance',
      host: 'localhost',
      port: 5432,
      admin_user: 'postgres',
      admin_pass_encrypted: null,
      is_management_instance: false,
      region: 'default',
      status: 'active',
      weight: 100,
      max_databases: 100,
      current_databases: 50,
      created_at: new Date(),
      ...overrides,
    })

    it('should calculate score based on database utilization', () => {
      // 50% utilized
      const instance1 = createMockInstance({ current_databases: 50, max_databases: 100 })
      const score1 = calculateLoadScore(instance1)

      // 10% utilized
      const instance2 = createMockInstance({ current_databases: 10, max_databases: 100 })
      const score2 = calculateLoadScore(instance2)

      // Lower utilization should have lower score
      expect(score2.score).toBeLessThan(score1.score)
    })

    it('should factor in weight', () => {
      // Same utilization, different weights
      const heavyWeight = createMockInstance({ weight: 200 })
      const lightWeight = createMockInstance({ weight: 50 })

      const scoreHeavy = calculateLoadScore(heavyWeight)
      const scoreLight = calculateLoadScore(lightWeight)

      // Higher weight should result in lower score (more preferred)
      expect(scoreHeavy.score).toBeLessThan(scoreLight.score)
    })

    it('should factor in metrics when provided', () => {
      const instance = createMockInstance()

      const lowMetrics: InstanceMetrics = {
        cpu_usage_percent: 10,
        connection_count: 50,
        database_count: 50,
      }

      const highMetrics: InstanceMetrics = {
        cpu_usage_percent: 90,
        connection_count: 5000,
        database_count: 50,
      }

      const scoreLow = calculateLoadScore(instance, lowMetrics)
      const scoreHigh = calculateLoadScore(instance, highMetrics)

      // Lower resource usage should have lower score
      expect(scoreLow.score).toBeLessThan(scoreHigh.score)
    })

    it('should include score details breakdown', () => {
      const instance = createMockInstance()
      const score = calculateLoadScore(instance)

      expect(score.details).toHaveProperty('schemaScore')
      expect(score.details).toHaveProperty('cpuScore')
      expect(score.details).toHaveProperty('connectionScore')
      expect(score.details).toHaveProperty('weightScore')
    })

    it('should handle edge cases', () => {
      // Empty instance
      const emptyInstance = createMockInstance({ current_databases: 0, max_databases: 100 })
      const emptyScore = calculateLoadScore(emptyInstance)
      expect(emptyScore.details.schemaScore).toBe(0)

      // Full instance
      const fullInstance = createMockInstance({ current_databases: 100, max_databases: 100 })
      const fullScore = calculateLoadScore(fullInstance)
      expect(fullScore.details.schemaScore).toBe(100)
    })

    it('should return the instance in the result', () => {
      const instance = createMockInstance()
      const score = calculateLoadScore(instance)

      expect(score.instance).toBe(instance)
    })
  })
})
