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
  isRealtimeMultiTenantEnabled: vi.fn().mockReturnValue(false),
}))

// Platform DB queries — setPlatformProjectStatus is the data-plane half of
// pause/resume that this suite verifies.
vi.mock('../../src/db/platform-queries.js', () => ({
  upsertPlatformProject: vi.fn().mockResolvedValue(undefined),
  updatePlatformProject: vi.fn().mockResolvedValue(undefined),
  upsertJwtKey: vi.fn().mockResolvedValue(undefined),
  upsertApiKey: vi.fn().mockResolvedValue(undefined),
  upsertPostgrestConfig: vi.fn().mockResolvedValue(undefined),
  deletePlatformProjectData: vi.fn().mockResolvedValue(undefined),
  setPlatformProjectStatus: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/integrations/storage/storage.client.js', () => ({
  registerStorageTenant: vi.fn().mockResolvedValue({ success: true }),
  deleteStorageTenant: vi.fn().mockResolvedValue({ success: true }),
}))

// Secrets store — restoreProject reads JWT/api keys back from here.
vi.mock('../../src/integrations/secrets-manager/index.js', () => ({
  getSecretsStore: vi.fn(() => ({
    getProjectSecret: vi.fn().mockResolvedValue({
      jwt_keys: [{ status: 'current', secret: 's' }],
      api_keys: [
        { role: 'anon', status: 'active', jwt: 'a' },
        { role: 'service_role', status: 'active', jwt: 'sr' },
      ],
    }),
  })),
}))

vi.mock('../../src/db/repositories/rds-instance.repository.js', () => ({
  findRdsInstanceById: vi.fn().mockResolvedValue(null),
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

  describe('pauseProject — data-plane stop', () => {
    it('flips platform DB status to paused for an ACTIVE_HEALTHY project', async () => {
      const { findProjectByRef } = await import('../../src/db/repositories/project.repository.js')
      const { setPlatformProjectStatus } = await import('../../src/db/platform-queries.js')
      const { pauseProject } = await import('../../src/modules/project/project.service.js')
      vi.mocked(findProjectByRef).mockResolvedValue({ ref: 'p1', status: 'ACTIVE_HEALTHY' } as never)

      const result = await pauseProject('p1')

      expect(result.success).toBe(true)
      // The core fix: data-plane gate (platform DB) must be flipped to 'paused'.
      expect(setPlatformProjectStatus).toHaveBeenCalledWith('p1', 'paused')
    })

    it('rejects pausing a project that is not ACTIVE_HEALTHY (state guard)', async () => {
      const { findProjectByRef } = await import('../../src/db/repositories/project.repository.js')
      const { setPlatformProjectStatus } = await import('../../src/db/platform-queries.js')
      const { pauseProject } = await import('../../src/modules/project/project.service.js')
      vi.mocked(findProjectByRef).mockResolvedValue({ ref: 'p2', status: 'COMING_UP' } as never)
      vi.mocked(setPlatformProjectStatus).mockClear()

      const result = await pauseProject('p2')

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/ACTIVE_HEALTHY/)
      expect(setPlatformProjectStatus).not.toHaveBeenCalled()
    })

    it('is idempotent for an already-PAUSED project', async () => {
      const { findProjectByRef } = await import('../../src/db/repositories/project.repository.js')
      const { pauseProject } = await import('../../src/modules/project/project.service.js')
      vi.mocked(findProjectByRef).mockResolvedValue({ ref: 'p3', status: 'PAUSED' } as never)

      const result = await pauseProject('p3')
      expect(result.success).toBe(true)
    })
  })

  describe('restoreProject — data-plane resume', () => {
    it('flips platform DB status back to active', async () => {
      const { findProjectByRef } = await import('../../src/db/repositories/project.repository.js')
      const { setPlatformProjectStatus } = await import('../../src/db/platform-queries.js')
      const { restoreProject } = await import('../../src/modules/project/project.service.js')
      vi.mocked(setPlatformProjectStatus).mockClear()
      vi.mocked(findProjectByRef).mockResolvedValue({
        ref: 'p4', status: 'PAUSED', db_name: 'project_p4', db_host: 'h', db_port: 5432, db_instance_id: null,
      } as never)

      const result = await restoreProject('p4')

      expect(result.success).toBe(true)
      expect(setPlatformProjectStatus).toHaveBeenCalledWith('p4', 'active')
    })

    it('rejects restoring a project that is not PAUSED', async () => {
      const { findProjectByRef } = await import('../../src/db/repositories/project.repository.js')
      const { restoreProject } = await import('../../src/modules/project/project.service.js')
      vi.mocked(findProjectByRef).mockResolvedValue({ ref: 'p5', status: 'ACTIVE_HEALTHY' } as never)

      const result = await restoreProject('p5')
      expect(result.success).toBe(false)
    })

    it('does NOT flip to RESTORING when the secret doc is missing active keys (no stuck state)', async () => {
      const { findProjectByRef, updateProjectStatus } = await import('../../src/db/repositories/project.repository.js')
      const { getSecretsStore } = await import('../../src/integrations/secrets-manager/index.js')
      const { restoreProject } = await import('../../src/modules/project/project.service.js')
      vi.mocked(updateProjectStatus).mockClear()
      vi.mocked(findProjectByRef).mockResolvedValue({
        ref: 'p6', status: 'PAUSED', db_name: 'project_p6', db_host: 'h', db_port: 5432, db_instance_id: null,
      } as never)
      // Secret doc with a current JWT key but NO active api keys → validation fails.
      vi.mocked(getSecretsStore).mockReturnValueOnce({
        getProjectSecret: vi.fn().mockResolvedValue({
          jwt_keys: [{ status: 'current', secret: 's' }],
          api_keys: [],
        }),
      } as never)

      const result = await restoreProject('p6')

      expect(result.success).toBe(false)
      // The fix: status must NOT have been flipped to RESTORING, so the project
      // stays PAUSED and remains resumable (no unrecoverable stuck state).
      const flippedToRestoring = vi.mocked(updateProjectStatus).mock.calls.some(
        (c) => c[1] === 'RESTORING',
      )
      expect(flippedToRestoring).toBe(false)
    })

    it('is re-entrant from a stuck RESTORING state once the secret doc is valid', async () => {
      const { findProjectByRef } = await import('../../src/db/repositories/project.repository.js')
      const { setPlatformProjectStatus } = await import('../../src/db/platform-queries.js')
      const { restoreProject } = await import('../../src/modules/project/project.service.js')
      vi.mocked(setPlatformProjectStatus).mockClear()
      // A project left stuck in RESTORING by an earlier failure must be recoverable.
      vi.mocked(findProjectByRef).mockResolvedValue({
        ref: 'p7', status: 'RESTORING', db_name: 'project_p7', db_host: 'h', db_port: 5432, db_instance_id: null,
      } as never)

      const result = await restoreProject('p7')

      expect(result.success).toBe(true)
      expect(setPlatformProjectStatus).toHaveBeenCalledWith('p7', 'active')
    })
  })
})
