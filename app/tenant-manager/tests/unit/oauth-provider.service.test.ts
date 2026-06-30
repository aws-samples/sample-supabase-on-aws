import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

// Required env for getEnv() (used by the encryption module).
beforeAll(() => {
  process.env.ADMIN_API_KEY = 'test-admin-key'
  process.env.JWT_SECRET = 'test-jwt-secret'
  process.env.ENCRYPTION_KEY = 'test-encryption-key-0123456789'
  process.env.AWS_REGION = 'us-east-1'
})

// In-memory stand-in for the platform DB, keyed by `${projectId}:${provider}`.
const store = new Map<string, Record<string, unknown>>()

vi.mock('../../src/db/platform-queries.js', () => ({
  upsertExternalOAuthProvider: vi.fn(
    async (
      projectId: string,
      provider: string,
      input: {
        enabled: boolean
        clientId: string
        encryptedSecret: string
        redirectUri: string | null
        skipNonceCheck: boolean
      },
    ) => {
      store.set(`${projectId}:${provider}`, {
        project_id: projectId,
        provider,
        enabled: input.enabled,
        client_id: input.clientId,
        client_secret: input.encryptedSecret,
        redirect_uri: input.redirectUri,
        skip_nonce_check: input.skipNonceCheck,
      })
    },
  ),
  getExternalOAuthProvider: vi.fn(async (projectId: string, provider: string) => {
    return store.get(`${projectId}:${provider}`) ?? null
  }),
  getExternalOAuthProviders: vi.fn(async (projectId: string) => {
    return [...store.values()].filter((r) => r.project_id === projectId)
  }),
  deleteExternalOAuthProvider: vi.fn(async (projectId: string, provider: string) => {
    store.delete(`${projectId}:${provider}`)
  }),
}))

beforeEach(() => {
  store.clear()
})

const REF = 'tenant-a'
const baseInput = {
  enabled: true,
  client_id: 'client-123.apps.googleusercontent.com',
  client_secret: 'GOCSPX-super-secret',
  redirect_uri: 'https://tenant-a.example.com/auth/v1/callback',
  skip_nonce_check: false,
}

describe('oauth-provider.service', () => {
  it('encrypts client_secret before storing (never plaintext)', async () => {
    const { setGoogleProvider } = await import('../../src/modules/project/oauth-provider.service.js')
    await setGoogleProvider(REF, baseInput)

    const stored = store.get(`${REF}:google`)!
    expect(stored.client_secret).not.toBe(baseInput.client_secret)
    expect(stored.client_secret).not.toContain('GOCSPX')
    expect(String(stored.client_secret).length).toBeGreaterThan(0)
  })

  it('buildExternalConfigForGoTrue decrypts and emits GoTrue shape', async () => {
    const { setGoogleProvider, buildExternalConfigForGoTrue } = await import(
      '../../src/modules/project/oauth-provider.service.js'
    )
    await setGoogleProvider(REF, baseInput)

    const config = await buildExternalConfigForGoTrue(REF)
    expect(config).not.toBeNull()
    expect(config!.google).toBeDefined()
    const g = config!.google!
    // client_id is an array to match GoTrue's ClientID []string
    expect(Array.isArray(g.client_id)).toBe(true)
    expect(g.client_id).toEqual([baseInput.client_id])
    // secret is decrypted back to the original plaintext
    expect(g.secret).toBe(baseInput.client_secret)
    expect(g.redirect_uri).toBe(baseInput.redirect_uri)
    expect(g.enabled).toBe(true)
    expect(g.skip_nonce_check).toBe(false)
  })

  it('buildExternalConfigForGoTrue returns null when nothing configured', async () => {
    const { buildExternalConfigForGoTrue } = await import(
      '../../src/modules/project/oauth-provider.service.js'
    )
    expect(await buildExternalConfigForGoTrue(REF)).toBeNull()
  })

  it('getGoogleProviderMasked hides the secret but reports it is set', async () => {
    const { setGoogleProvider, getGoogleProviderMasked } = await import(
      '../../src/modules/project/oauth-provider.service.js'
    )
    await setGoogleProvider(REF, baseInput)

    const masked = await getGoogleProviderMasked(REF)
    expect(masked).not.toBeNull()
    expect(masked!.client_id).toBe(baseInput.client_id)
    expect(masked!.secret_set).toBe(true)
    // The masked view must not expose the secret value under any field.
    expect(JSON.stringify(masked)).not.toContain('GOCSPX')
    expect(JSON.stringify(masked)).not.toContain(baseInput.client_secret)
  })

  it('getGoogleProviderMasked returns null when not configured', async () => {
    const { getGoogleProviderMasked } = await import(
      '../../src/modules/project/oauth-provider.service.js'
    )
    expect(await getGoogleProviderMasked(REF)).toBeNull()
  })

  it('disabled config stores empty secret and reports secret_set=false', async () => {
    const { setGoogleProvider, getGoogleProviderMasked, buildExternalConfigForGoTrue } = await import(
      '../../src/modules/project/oauth-provider.service.js'
    )
    await setGoogleProvider(REF, { enabled: false })

    const masked = await getGoogleProviderMasked(REF)
    expect(masked!.enabled).toBe(false)
    expect(masked!.secret_set).toBe(false)

    const config = await buildExternalConfigForGoTrue(REF)
    expect(config!.google!.enabled).toBe(false)
    expect(config!.google!.secret).toBe('')
    expect(config!.google!.client_id).toEqual([])
  })

  it('deleteGoogleProvider removes the config', async () => {
    const { setGoogleProvider, deleteGoogleProvider, getGoogleProviderMasked } = await import(
      '../../src/modules/project/oauth-provider.service.js'
    )
    await setGoogleProvider(REF, baseInput)
    await deleteGoogleProvider(REF)
    expect(await getGoogleProviderMasked(REF)).toBeNull()
  })
})
