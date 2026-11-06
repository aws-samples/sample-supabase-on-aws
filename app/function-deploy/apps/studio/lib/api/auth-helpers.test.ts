import jwt from 'jsonwebtoken'
import type { NextApiRequest } from 'next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getCurrentUserId } from './auth-helpers'

vi.mock('./self-hosted/project-store-pg', () => ({
  findByRef: vi.fn().mockResolvedValue({ data: { id: 1, ref: 'victimref' }, error: null }),
}))

const JWT_SECRET = 'test-jwt-secret-with-at-least-32-characters'
const ATTACKER_SECRET = 'attacker-chosen-secret-not-the-real-one'

// Mirrors the payload shape of tenant-manager's generateApiKeyJwt (no `sub` claim)
function signApiKey(role: string, secret: string): string {
  return jwt.sign({ iss: 'supabase', ref: 'victimref', role }, secret, { algorithm: 'HS256' })
}

function unsignedToken(payload: object): string {
  const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`
}

function requestWithToken(token: string, url = '/api/v1/health'): NextApiRequest {
  return {
    url,
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
    query: {},
  } as unknown as NextApiRequest
}

describe('getCurrentUserId role claims', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('STUDIO_NO_AUTH_MODE', '')
    vi.stubEnv('SUPABASE_JWT_SECRET', '')
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_API_URL', '')
    vi.stubEnv('GOTRUE_JWT_ISSUER', '')
    vi.stubEnv('JWT_SECRET', JWT_SECRET)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('rejects a service_role token signed with an attacker-chosen key', async () => {
    const forged = signApiKey('service_role', ATTACKER_SECRET)

    expect(await getCurrentUserId(requestWithToken(forged))).toBeNull()
  })

  it('rejects a forged service_role token on a project-scoped route', async () => {
    const forged = signApiKey('service_role', ATTACKER_SECRET)
    const req = requestWithToken(forged, '/api/v1/projects/victimref/secrets')

    expect(await getCurrentUserId(req, 'victimref')).toBeNull()
  })

  it('rejects an unsigned (alg: none) service_role token', async () => {
    const unsigned = unsignedToken({ iss: 'supabase', ref: 'victimref', role: 'service_role' })

    expect(await getCurrentUserId(requestWithToken(unsigned))).toBeNull()
  })

  it('rejects an anon token signed with an attacker-chosen key', async () => {
    const forged = signApiKey('anon', ATTACKER_SECRET)

    expect(await getCurrentUserId(requestWithToken(forged))).toBeNull()
  })

  it('accepts a service_role key signed with the configured JWT secret', async () => {
    const legit = signApiKey('service_role', JWT_SECRET)

    expect(await getCurrentUserId(requestWithToken(legit))).toBe('service_role')
  })

  it('accepts an anon key signed with the configured JWT secret', async () => {
    const legit = signApiKey('anon', JWT_SECRET)

    expect(await getCurrentUserId(requestWithToken(legit))).toBe('anon')
  })

  it('rejects a service_role token when no JWT secret is configured', async () => {
    vi.stubEnv('JWT_SECRET', '')
    const token = signApiKey('service_role', JWT_SECRET)

    expect(await getCurrentUserId(requestWithToken(token))).toBeNull()
  })
})
