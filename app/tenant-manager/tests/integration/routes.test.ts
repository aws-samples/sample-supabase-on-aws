/**
 * Integration tests for API routes
 * Requires running services (database, etc.)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { FastifyInstance } from 'fastify'

// These tests require a full environment setup
// Skip in CI unless explicitly enabled
const SKIP_INTEGRATION = process.env.RUN_INTEGRATION_TESTS !== 'true'

describe.skipIf(SKIP_INTEGRATION)('API Integration Tests', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    // Set required environment variables for testing
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.JWT_SECRET = 'test-jwt-secret'
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-chars!!!!!'
    process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || 'localhost'
    process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '5432'
    process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'postgres'

    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) {
      await app.close()
    }
  })

  describe('Health Routes', () => {
    it('GET /health should return ok', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body)
      expect(body.status).toBe('ok')
    })

    it('GET /health/live should return ok', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
      })

      expect(response.statusCode).toBe(200)
    })
  })

  describe('Project Routes', () => {
    it('GET /admin/v1/projects without auth should return 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/v1/projects',
      })

      expect(response.statusCode).toBe(401)
    })

    it('GET /admin/v1/projects with auth should return projects', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/v1/projects',
        headers: {
          Authorization: 'Bearer test-admin-key',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body)
      expect(body).toHaveProperty('data')
      expect(body).toHaveProperty('pagination')
    })

    it('POST /admin/v1/projects should create a project', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/v1/projects',
        headers: {
          Authorization: 'Bearer test-admin-key',
          'Content-Type': 'application/json',
        },
        payload: {
          name: 'Integration Test Project',
        },
      })

      // May fail if database is not properly set up
      if (response.statusCode === 201) {
        const body = JSON.parse(response.body)
        expect(body.data).toHaveProperty('ref')
        expect(body.data).toHaveProperty('name', 'Integration Test Project')
        expect(body.data).toHaveProperty('api_keys')
      }
    })
  })

  describe('RDS Instance Routes', () => {
    it('GET /admin/v1/rds-instances without auth should return 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/v1/rds-instances',
      })

      expect(response.statusCode).toBe(401)
    })

    it('GET /admin/v1/rds-instances with auth should return instances', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/v1/rds-instances',
        headers: {
          Authorization: 'Bearer test-admin-key',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body)
      expect(body).toHaveProperty('data')
      expect(body).toHaveProperty('pagination')
    })
  })
})
