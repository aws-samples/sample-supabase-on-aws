/**
 * Unit tests for the storage-api integration client.
 *
 * Phase 2 §1 — wires tenant-manager into supabase/storage-api's MULTI_TENANT
 * Admin API (port 5001) so that:
 *   - provisionProject → POST /tenants/{ref} with that tenant's DB URL +
 *     JWT secret + anon/service keys
 *   - deprovisionProject → DELETE /tenants/{ref}
 *
 * Storage tenant registration is best-effort: if the storage service is down,
 * the rest of the project lifecycle should keep working. Errors surface as
 * structured ServiceResult, never exceptions.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

vi.mock('../../src/config/index.js', () => ({
  getEnv: () => ({
    STORAGE_ADMIN_URL: 'http://storage-api.test:5001',
    ADMIN_API_KEY: 'test-admin-key',
    JWT_SECRET: 'test-jwt-secret',
  }),
}))

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

import {
  registerStorageTenant,
  deleteStorageTenant,
} from '../../src/integrations/storage/storage.client.js'

const tenantConfig = {
  projectRef: 'abc',
  dbName: 'project_abc',
  dbHost: 'worker-rds.example.com',
  dbPort: 5432,
  dbPassword: 'secret',
  jwtSecret: 'jwt-secret',
  anonKey: 'sb_publishable_xxx',
  serviceRoleKey: 'sb_secret_xxx',
}

describe('registerStorageTenant', () => {
  it('POSTs the tenant payload to /tenants/:ref with admin API key', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    } as unknown as Response)

    const result = await registerStorageTenant(tenantConfig)

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://storage-api.test:5001/tenants/abc')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['apikey']).toBe('test-admin-key')
    expect(headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      anonKey: 'sb_publishable_xxx',
      serviceKey: 'sb_secret_xxx',
      jwtSecret: 'jwt-secret',
    })
    expect(body.databaseUrl).toContain('worker-rds.example.com')
    expect(body.databaseUrl).toContain('project_abc')
    expect(body.databaseUrl).toContain('sslmode=verify-ca')
  })

  it('returns success: false with the response body when storage-api errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'tenant exists',
      json: async () => ({}),
    } as unknown as Response)

    const result = await registerStorageTenant(tenantConfig)
    expect(result.success).toBe(false)
    expect(result.error).toContain('400')
    expect(result.error).toContain('tenant exists')
  })

  it('returns success: false on network failure (does NOT throw)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const result = await registerStorageTenant(tenantConfig)
    expect(result.success).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('URL-encodes the project ref to avoid path injection', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    } as unknown as Response)

    await registerStorageTenant({ ...tenantConfig, projectRef: 'a/b' })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('http://storage-api.test:5001/tenants/a%2Fb')
  })
})

describe('deleteStorageTenant', () => {
  it('DELETEs /tenants/:ref', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: async () => '',
      json: async () => ({}),
    } as unknown as Response)

    const result = await deleteStorageTenant('abc')

    expect(result.success).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://storage-api.test:5001/tenants/abc')
    expect(init.method).toBe('DELETE')
    expect((init.headers as Record<string, string>)['apikey']).toBe('test-admin-key')
  })

  it('treats 404 as success (idempotent delete)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'not found',
      json: async () => ({}),
    } as unknown as Response)

    const result = await deleteStorageTenant('gone')
    expect(result.success).toBe(true)
  })

  it('returns error on 5xx', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'oops',
      json: async () => ({}),
    } as unknown as Response)

    const result = await deleteStorageTenant('abc')
    expect(result.success).toBe(false)
    expect(result.error).toContain('500')
  })
})
