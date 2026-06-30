import { describe, it, expect } from 'vitest'
import { googleProviderSchema } from '../../src/modules/project/oauth-provider.schemas.js'

describe('googleProviderSchema', () => {
  it('accepts a fully-specified enabled config', () => {
    const result = googleProviderSchema.safeParse({
      enabled: true,
      client_id: 'client-123.apps.googleusercontent.com',
      client_secret: 'GOCSPX-secret',
      redirect_uri: 'https://tenant-a.example.com/auth/v1/callback',
      skip_nonce_check: true,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.enabled).toBe(true)
      expect(result.data.skip_nonce_check).toBe(true)
    }
  })

  it('defaults skip_nonce_check to false', () => {
    const result = googleProviderSchema.safeParse({
      enabled: true,
      client_id: 'c',
      client_secret: 's',
      redirect_uri: 'https://r.example.com/cb',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.skip_nonce_check).toBe(false)
    }
  })

  it('rejects enabled config missing client_id', () => {
    const result = googleProviderSchema.safeParse({
      enabled: true,
      client_secret: 's',
      redirect_uri: 'https://r.example.com/cb',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('client_id'))).toBe(true)
    }
  })

  it('rejects enabled config missing client_secret and redirect_uri', () => {
    const result = googleProviderSchema.safeParse({ enabled: true, client_id: 'c' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.flatMap((i) => i.path)
      expect(paths).toContain('client_secret')
      expect(paths).toContain('redirect_uri')
    }
  })

  it('rejects an invalid redirect_uri URL', () => {
    const result = googleProviderSchema.safeParse({
      enabled: true,
      client_id: 'c',
      client_secret: 's',
      redirect_uri: 'not-a-url',
    })
    expect(result.success).toBe(false)
  })

  it('allows a disabled config without credentials', () => {
    const result = googleProviderSchema.safeParse({ enabled: false })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.enabled).toBe(false)
    }
  })

  it('rejects a non-boolean enabled', () => {
    const result = googleProviderSchema.safeParse({ enabled: 'yes' })
    expect(result.success).toBe(false)
  })
})
