/**
 * Unit tests for project-service
 * Note: Most functionality requires database access, so these are limited unit tests
 */

import { describe, it, expect, vi } from 'vitest'

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
    GOTRUE_URL: 'http://auth:9999',
    GOTRUE_MULTI_TENANT: false,
    REALTIME_URL: 'http://realtime:4000',
    SUPAVISOR_URL: 'http://supavisor:4000',
    POOLER_DEFAULT_POOL_SIZE: 15,
    POOLER_MAX_CLIENT_CONN: 200,
  }),
}))

// Mock database connection
vi.mock('../../src/db/connection.js', () => ({
  getManagementDb: vi.fn(),
  getSystemPool: vi.fn(),
  withTenantClient: vi.fn(),
}))

// Mock repositories
vi.mock('../../src/db/repositories/project.repository.js', () => ({
  findProjectByRef: vi.fn(),
  findProjects: vi.fn().mockResolvedValue([]),
  countProjects: vi.fn().mockResolvedValue(0),
  insertProject: vi.fn(),
  updateProjectByRef: vi.fn(),
  deleteProjectByRef: vi.fn(),
  updateProjectStatus: vi.fn(),
}))

// Mock external services
vi.mock('../../src/integrations/supavisor/supavisor.client.js', () => ({
  registerSupavisorTenant: vi.fn().mockResolvedValue({ success: true }),
  deleteSupavisorTenant: vi.fn().mockResolvedValue({ success: true }),
  getSupavisorTenant: vi.fn().mockResolvedValue({ success: true, data: {} }),
}))

vi.mock('../../src/integrations/realtime/realtime.client.js', () => ({
  registerRealtimeTenant: vi.fn().mockResolvedValue({ success: true }),
  deleteRealtimeTenant: vi.fn().mockResolvedValue({ success: true }),
  getRealtimeTenant: vi.fn().mockResolvedValue({ success: true, data: {} }),
}))

vi.mock('../../src/integrations/auth/auth.client.js', () => ({
  registerAuthTenant: vi.fn().mockResolvedValue({ success: true }),
  deleteAuthTenant: vi.fn().mockResolvedValue({ success: true }),
  getAuthTenant: vi.fn().mockResolvedValue({ success: true, data: {} }),
  isAuthMultiTenantEnabled: vi.fn().mockReturnValue(false),
}))

// Mock provisioning
vi.mock('../../src/modules/provisioning/provisioner.service.js', () => ({
  createProjectDatabase: vi.fn().mockResolvedValue({ success: true }),
  initializeProjectDatabase: vi.fn().mockResolvedValue({ success: true }),
  deleteProjectDatabase: vi.fn().mockResolvedValue({ success: true }),
}))

describe('project-service', () => {
  describe('module loading', () => {
    it('should export expected functions', async () => {
      const projectService = await import('../../src/modules/project/project.service.js')

      expect(typeof projectService.provisionProject).toBe('function')
      expect(typeof projectService.deprovisionProject).toBe('function')
      expect(typeof projectService.getProjectByRef).toBe('function')
      expect(typeof projectService.listProjects).toBe('function')
      expect(typeof projectService.pauseProject).toBe('function')
      expect(typeof projectService.restoreProject).toBe('function')
      expect(typeof projectService.checkProjectHealth).toBe('function')
    })
  })

  describe('key-generator integration', () => {
    it('should be able to import key-generator functions', async () => {
      const keyGenerator = await import('../../src/common/crypto/key-generator.js')

      expect(typeof keyGenerator.generateProjectRef).toBe('function')
      expect(typeof keyGenerator.generateDbName).toBe('function')
      expect(typeof keyGenerator.generateJwtSecret).toBe('function')
    })
  })
})
