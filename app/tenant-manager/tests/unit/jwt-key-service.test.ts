/**
 * Unit tests for JWT key service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'
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
    GOTRUE_URL: 'http://auth:9999',
    GOTRUE_MULTI_TENANT: false,
    REALTIME_URL: 'http://realtime:4000',
    JWT_SECRET: 'test-jwt-secret',
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

vi.mock('../../src/db/connection.js', () => ({
  withTenantClient: vi.fn().mockImplementation(async (_dbName: string, fn: (client: unknown) => Promise<unknown>) => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      escapeIdentifier: (id: string) => `"${id}"`,
    }
    return fn(mockClient)
  }),
}))

vi.mock('../../src/integrations/auth/auth.client.js', () => ({
  registerAuthTenant: vi.fn().mockResolvedValue({ success: true }),
  isAuthMultiTenantEnabled: vi.fn().mockReturnValue(false),
}))

vi.mock('../../src/integrations/realtime/realtime.client.js', () => ({
  registerRealtimeTenant: vi.fn().mockResolvedValue({ success: true }),
}))

import { listJwtKeys, createStandbyKey, rotateJwtKeys } from '../../src/modules/api-keys/jwt-key.service.js'
import { generateApiKeyJwt } from '../../src/common/crypto/api-key-generator.js'

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
        id: 'jwt-key-current',
        secret: 'current-jwt-secret-base64',
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

describe('jwt-key.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('listJwtKeys', () => {
    it('should return public info without secrets', async () => {
      const doc = makeSecretDoc()
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(doc)

      const keys = await listJwtKeys('test-project')
      expect(keys).toHaveLength(1)
      expect(keys[0]!.id).toBe('jwt-key-current')
      expect(keys[0]!.status).toBe('current')
      expect(keys[0]!.algorithm).toBe('HS256')
      // Ensure secret is NOT exposed
      expect((keys[0] as Record<string, unknown>)['secret']).toBeUndefined()
    })

    it('should return empty array if no secret doc', async () => {
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(null)
      const keys = await listJwtKeys('test-project')
      expect(keys).toHaveLength(0)
    })
  })

  describe('createStandbyKey', () => {
    it('should create a standby key', async () => {
      const doc = makeSecretDoc()
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(doc)
      vi.mocked(mockSecretsStore.putProjectSecret).mockResolvedValue(undefined)

      const result = await createStandbyKey('test-project')
      expect(result.status).toBe('standby')
      expect(result.algorithm).toBe('HS256')
      expect(result.id).toBeTruthy()

      expect(mockSecretsStore.putProjectSecret).toHaveBeenCalledOnce()
      const savedDoc = vi.mocked(mockSecretsStore.putProjectSecret).mock.calls[0]![1]
      expect(savedDoc.jwt_keys).toHaveLength(2)
      expect(savedDoc.jwt_keys[1]!.status).toBe('standby')
    })

    it('should throw if standby already exists', async () => {
      const doc = makeSecretDoc({
        jwt_keys: [
          {
            id: 'jwt-key-current', secret: 'current-secret',
            status: 'current', algorithm: 'HS256',
            created_at: '2025-01-01T00:00:00Z', rotated_at: null,
          },
          {
            id: 'jwt-key-standby', secret: 'standby-secret',
            status: 'standby', algorithm: 'HS256',
            created_at: '2025-01-02T00:00:00Z', rotated_at: null,
          },
        ],
      })
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(doc)

      await expect(createStandbyKey('test-project')).rejects.toThrow('standby key already exists')
    })
  })

  describe('rotateJwtKeys', () => {
    it('should rotate keys and re-sign API keys', async () => {
      const currentSecret = 'current-jwt-secret-for-test'
      const standbySecret = 'standby-jwt-secret-for-test'

      const anonJwt = generateApiKeyJwt({
        projectRef: 'test-project',
        role: 'anon',
        jwtSecret: currentSecret,
        keyId: 'jwt-key-current',
        apiKeyId: 'api-key-1',
      })

      const doc = makeSecretDoc({
        jwt_keys: [
          {
            id: 'jwt-key-current', secret: currentSecret,
            status: 'current', algorithm: 'HS256',
            created_at: '2025-01-01T00:00:00Z', rotated_at: null,
          },
          {
            id: 'jwt-key-standby', secret: standbySecret,
            status: 'standby', algorithm: 'HS256',
            created_at: '2025-01-02T00:00:00Z', rotated_at: null,
          },
        ],
        api_keys: [
          {
            id: 'api-key-1', project_ref: 'test-project', name: 'Anon Key',
            type: 'publishable', role: 'anon', prefix: 'sb_publishable_abc',
            hashed_secret: 'hash1', jwt: anonJwt, jwt_key_id: 'jwt-key-current',
            status: 'active', description: null,
            created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', revoked_at: null,
          },
        ],
      })
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(doc)
      vi.mocked(mockSecretsStore.putProjectSecret).mockResolvedValue(undefined)

      const result = await rotateJwtKeys('test-project')

      expect(result.current.id).toBe('jwt-key-standby')
      expect(result.current.status).toBe('current')
      expect(result.previous).not.toBeNull()
      expect(result.previous!.id).toBe('jwt-key-current')
      expect(result.previous!.status).toBe('previous')
      expect(result.api_keys_resigned).toBe(1)

      // Verify the re-signed JWT is valid with the new secret
      const savedDoc = vi.mocked(mockSecretsStore.putProjectSecret).mock.calls[0]![1]
      const resignedJwt = savedDoc.api_keys[0]!.jwt
      const decoded = jwt.verify(resignedJwt, standbySecret) as jwt.JwtPayload
      expect(decoded['role']).toBe('anon')
      expect(decoded['ref']).toBe('test-project')

      // Verify new kid in header
      const headers = jwt.decode(resignedJwt, { complete: true })
      expect(headers?.header.kid).toBe('jwt-key-standby')
    })

    it('should throw if no standby key exists', async () => {
      const doc = makeSecretDoc() // only current key
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(doc)

      await expect(rotateJwtKeys('test-project')).rejects.toThrow('No standby key exists')
    })

    it('should not re-sign revoked keys', async () => {
      const currentSecret = 'current-secret'
      const standbySecret = 'standby-secret'

      const activeJwt = generateApiKeyJwt({
        projectRef: 'test-project',
        role: 'anon',
        jwtSecret: currentSecret,
        keyId: 'jwt-key-current',
        apiKeyId: 'api-key-1',
      })

      const revokedJwt = generateApiKeyJwt({
        projectRef: 'test-project',
        role: 'service_role',
        jwtSecret: currentSecret,
        keyId: 'jwt-key-current',
        apiKeyId: 'api-key-2',
      })

      const doc = makeSecretDoc({
        jwt_keys: [
          {
            id: 'jwt-key-current', secret: currentSecret,
            status: 'current', algorithm: 'HS256',
            created_at: '2025-01-01T00:00:00Z', rotated_at: null,
          },
          {
            id: 'jwt-key-standby', secret: standbySecret,
            status: 'standby', algorithm: 'HS256',
            created_at: '2025-01-02T00:00:00Z', rotated_at: null,
          },
        ],
        api_keys: [
          {
            id: 'api-key-1', project_ref: 'test-project', name: 'Active',
            type: 'publishable', role: 'anon', prefix: 'sb_publishable_abc',
            hashed_secret: 'hash1', jwt: activeJwt, jwt_key_id: 'jwt-key-current',
            status: 'active', description: null,
            created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', revoked_at: null,
          },
          {
            id: 'api-key-2', project_ref: 'test-project', name: 'Revoked',
            type: 'secret', role: 'service_role', prefix: 'sb_secret_xyz',
            hashed_secret: 'hash2', jwt: revokedJwt, jwt_key_id: 'jwt-key-current',
            status: 'revoked', description: null,
            created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-02T00:00:00Z', revoked_at: '2025-01-02T00:00:00Z',
          },
        ],
      })
      vi.mocked(mockSecretsStore.getProjectSecret).mockResolvedValue(doc)
      vi.mocked(mockSecretsStore.putProjectSecret).mockResolvedValue(undefined)

      const result = await rotateJwtKeys('test-project')
      expect(result.api_keys_resigned).toBe(1) // only active key

      // Verify the revoked key's JWT was NOT re-signed
      const savedDoc = vi.mocked(mockSecretsStore.putProjectSecret).mock.calls[0]![1]
      const revokedKey = savedDoc.api_keys.find((k) => k.id === 'api-key-2')!
      expect(revokedKey.jwt).toBe(revokedJwt) // unchanged
    })
  })
})
