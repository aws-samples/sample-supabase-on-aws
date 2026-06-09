import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mocks must be declared before importing the SUT.
vi.mock('./tenant-manager', () => ({
  listAPIKeysAsSecrets: vi.fn(),
}))

import { listAPIKeysAsSecrets } from './tenant-manager'
import { buildSystemSecrets, MissingBaseDomainError } from './system-secrets'

const mockedTM = vi.mocked(listAPIKeysAsSecrets)

describe('buildSystemSecrets', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, SUPABASE_BASE_DOMAIN: 'supabase.example.com' }
    mockedTM.mockReset()
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  it('returns four system secrets when TM returns ANON + SERVICE_ROLE', async () => {
    mockedTM.mockResolvedValueOnce([
      { name: 'SUPABASE_ANON_KEY', value: 'sb_publishable_abc', updated_at: '2026-05-26T00:00:00.000Z' },
      { name: 'SUPABASE_SERVICE_ROLE_KEY', value: 'sb_secret_xyz', updated_at: '2026-05-26T00:00:00.000Z' },
    ])

    const result = await buildSystemSecrets('abc123')

    expect(result.map((s) => s.name)).toEqual([
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_URL',
      'SUPABASE_PUBLIC_URL',
    ])
    expect(result.find((s) => s.name === 'SUPABASE_URL')!.value).toBe('https://abc123.supabase.example.com')
    expect(result.find((s) => s.name === 'SUPABASE_PUBLIC_URL')!.value).toBe('https://abc123.supabase.example.com')
    expect(result.every((s) => s.source === 'system')).toBe(true)
  })

  it('keeps URL and PUBLIC_URL when tenant-manager is degraded (returns [])', async () => {
    mockedTM.mockResolvedValueOnce([])

    const result = await buildSystemSecrets('abc123')

    // ANON / SERVICE_ROLE are absent because TM has nothing to give,
    // but URL and PUBLIC_URL must still appear.
    expect(result.map((s) => s.name)).toEqual(['SUPABASE_URL', 'SUPABASE_PUBLIC_URL'])
  })

  it('throws MissingBaseDomainError when SUPABASE_BASE_DOMAIN is unset', async () => {
    delete process.env.SUPABASE_BASE_DOMAIN
    mockedTM.mockResolvedValueOnce([])

    await expect(buildSystemSecrets('abc123')).rejects.toBeInstanceOf(MissingBaseDomainError)
  })

  it('builds project URL using exact ref subdomain (no hardcoded values)', async () => {
    mockedTM.mockResolvedValueOnce([])
    const result = await buildSystemSecrets('zzz999')
    expect(result.find((s) => s.name === 'SUPABASE_URL')!.value).toBe('https://zzz999.supabase.example.com')
  })
})
