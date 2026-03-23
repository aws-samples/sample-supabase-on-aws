/**
 * Unit tests for API key service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProjectSecretDocument } from '../../src/types/project-secret.js'
import type { SecretsStore } from '../../src/integrations/secrets-manager/types.js'

// Mock dependencies
const mockSecretsStore: SecretsStore = {
  getProjectSecret: vi.fn(),
  putProjectSecret: vi.fn(),
  deleteProjectSecret: vi.fn(),
}

vi.mock('../../src/integrations/secrets-manager/index.js', () => ({
  getSecretsStore: () => mockSecretsStore,
}))

vi.mock('../../src/config/index.js', () => ({
  getEnv: () => ({
    ENCRYPTION_KEY: 'test-encryption-key-32-characters!',
    POSTGRES_HOST: 'localhost',
    POSTGRES_PORT: 5432,
    POSTGRES_PASSWORD: 'postgres',
    POSTGRES_USER_READ_WRITE: 'postgres',
    AWS_REGION: 'us-east-1',
    AWS_SECRETS_PREFIX: 'supabase',
  }),
}))

vi.mock('../../src/modules/project/project.service.js', () => ({
  getProjectByRef: vi.fn().mockResolvedValue({
    id: 1,
    ref: 'test-project',
    name: 'Test Project',
    db_name: 'project_test_project',
    db_host: 'localhost',
    db_port: 5432,
    status: 'ACTIVE_HEALTHY',
  }),
}))

import { createApiKey, listApiKeys, getApiKey, revokeApiKey } from '../../src/modules/api-keys/api-key.service.js'

function makeSecretDoc(overrides?: Partial<ProjectSecretDocument>): ProjectSecretDocument {
  return {
    version: 1,
    project_ref: 'test-project',
    database: {
      DB_URI: 'postgresql://postgres:postgres@localhost:5432/project_test',
      DB_SCHEMAS: 'public',
      DB_ANON_ROLE: 'postgres',
      DB_USE_LEGACY_GUCS: 'false',
    },
    jwt_keys: [
      {
        id: 'jwt-key-1',
        secret: 'test-jwt-secret-for-signing',
        status: 'current',
        algorithm: 'HS256',
        created_at: '2025-01-01T00:00:00Z',
        rotated_at: null,
      },
    ],
    api_keys: [],
    ...overrides,
  }
}

describe('api-key.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createApiKey', () => {
    it('should create a new API key and store it', async () => {
      const doc = makeSecretDoc()
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(doc)
      vi.mocked(mockSecretsStore.putProjectSecret).mockResolvedValue(undefined)

      const result = await createApiKey('test-project', {
        name: 'My Key',
        type: 'publishable',
        role: 'anon',
        description: 'Test key',
      })

      expect(result.name).toBe('My Key')
      expect(result.type).toBe('publishable')
      expect(result.role).toBe('anon')
      expect(result.opaque_key).toMatch(/^sb_publishable_/)
      expect(result.prefix).toMatch(/^sb_publishable_/)
      expect(result.jwt).toBeTruthy()
      expect(result.id).toBeTruthy()

      // Verify secret was updated
      expect(mockSecretsStore.putProjectSecret).toHaveBeenCalledOnce()
      const savedDoc = vi.mocked(mockSecretsStore.putProjectSecret).mock.calls[0]![1]
      expect(savedDoc.api_keys).toHaveLength(1)
      expect(savedDoc.api_keys[0]!.status).toBe('active')
    })

    it('should throw if project secret not found', async () => {
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(null)

      await expect(
        createApiKey('test-project', {
          name: 'My Key',
          type: 'publishable',
          role: 'anon',
        })
      ).rejects.toThrow('Project secret not found')
    })
  })

  describe('listApiKeys', () => {
    it('should return only active keys', async () => {
      const doc = makeSecretDoc({
        api_keys: [
          {
            id: 'key-1', project_ref: 'test-project', name: 'Active Key',
            type: 'publishable', role: 'anon', prefix: 'sb_publishable_abc',
            hashed_secret: 'hash1', jwt: 'jwt1', jwt_key_id: 'jwt-key-1',
            status: 'active', description: null,
            created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', revoked_at: null,
          },
          {
            id: 'key-2', project_ref: 'test-project', name: 'Revoked Key',
            type: 'secret', role: 'service_role', prefix: 'sb_secret_xyz',
            hashed_secret: 'hash2', jwt: 'jwt2', jwt_key_id: 'jwt-key-1',
            status: 'revoked', description: null,
            created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-02T00:00:00Z', revoked_at: '2025-01-02T00:00:00Z',
          },
        ],
      })
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(doc)

      const keys = await listApiKeys('test-project')
      expect(keys).toHaveLength(1)
      expect(keys[0]!.name).toBe('Active Key')
      expect(keys[0]!.status).toBe('active')
    })

    it('should return empty array if no secret doc', async () => {
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(null)
      const keys = await listApiKeys('test-project')
      expect(keys).toHaveLength(0)
    })
  })

  describe('getApiKey', () => {
    it('should return a specific key', async () => {
      const doc = makeSecretDoc({
        api_keys: [
          {
            id: 'key-1', project_ref: 'test-project', name: 'My Key',
            type: 'publishable', role: 'anon', prefix: 'sb_publishable_abc',
            hashed_secret: 'hash1', jwt: 'jwt1', jwt_key_id: 'jwt-key-1',
            status: 'active', description: 'desc',
            created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', revoked_at: null,
          },
        ],
      })
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(doc)

      const key = await getApiKey('test-project', 'key-1')
      expect(key).not.toBeNull()
      expect(key!.name).toBe('My Key')
    })

    it('should return null for non-existent key', async () => {
      const doc = makeSecretDoc()
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(doc)

      const key = await getApiKey('test-project', 'non-existent')
      expect(key).toBeNull()
    })
  })

  describe('revokeApiKey', () => {
    it('should revoke an active key', async () => {
      const doc = makeSecretDoc({
        api_keys: [
          {
            id: 'key-1', project_ref: 'test-project', name: 'My Key',
            type: 'publishable', role: 'anon', prefix: 'sb_publishable_abc',
            hashed_secret: 'hash1', jwt: 'jwt1', jwt_key_id: 'jwt-key-1',
            status: 'active', description: null,
            created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', revoked_at: null,
          },
        ],
      })
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(doc)
      vi.mocked(mockSecretsStore.putProjectSecret).mockResolvedValue(undefined)

      await revokeApiKey('test-project', 'key-1')

      expect(mockSecretsStore.putProjectSecret).toHaveBeenCalledOnce()
      const savedDoc = vi.mocked(mockSecretsStore.putProjectSecret).mock.calls[0]![1]
      expect(savedDoc.api_keys[0]!.status).toBe('revoked')
      expect(savedDoc.api_keys[0]!.revoked_at).toBeTruthy()
    })

    it('should throw if key not found', async () => {
      const doc = makeSecretDoc()
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(doc)

      await expect(revokeApiKey('test-project', 'non-existent')).rejects.toThrow('API key not found')
    })

    it('should throw if key already revoked', async () => {
      const doc = makeSecretDoc({
        api_keys: [
          {
            id: 'key-1', project_ref: 'test-project', name: 'Revoked',
            type: 'publishable', role: 'anon', prefix: 'sb_publishable_abc',
            hashed_secret: 'hash1', jwt: 'jwt1', jwt_key_id: 'jwt-key-1',
            status: 'revoked', description: null,
            created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-02T00:00:00Z', revoked_at: '2025-01-02T00:00:00Z',
          },
        ],
      })
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(doc)

      await expect(revokeApiKey('test-project', 'key-1')).rejects.toThrow('already revoked')
    })
  })
})
