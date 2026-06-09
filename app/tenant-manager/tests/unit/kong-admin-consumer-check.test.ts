/**
 * Unit test: projectConsumerExists() — used by the ref-reuse conflict guard
 * to detect stale Kong consumers left behind by a partial teardown.
 *
 * The implementation calls Kong Admin GET /consumers/{ref}--anon and treats
 * 404 as "not exists", 200 as "exists", any other status as an integration
 * error that must propagate.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

vi.mock('../../src/config/index.js', () => ({
  getEnv: () => ({ KONG_ADMIN_URL: 'http://kong-test:8001' }),
}))

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

import { projectConsumerExists } from '../../src/integrations/kong/kong-admin.client.js'

describe('projectConsumerExists', () => {
  it('returns true when Kong returns 200 for the {ref}--anon consumer', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'c1', username: 'abc--anon' }),
      text: async () => '',
    } as unknown as Response)

    await expect(projectConsumerExists('abc')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://kong-test:8001/consumers/abc--anon',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('returns false when Kong returns 404', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => 'Not Found',
    } as unknown as Response)

    await expect(projectConsumerExists('missing')).resolves.toBe(false)
  })

  it('throws on Kong integration errors (5xx)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'service unavailable',
    } as unknown as Response)

    await expect(projectConsumerExists('blip')).rejects.toThrow(/503/)
  })
})
