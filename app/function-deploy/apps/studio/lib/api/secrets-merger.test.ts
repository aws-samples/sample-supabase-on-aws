import { describe, expect, it } from 'vitest'

import { mergeSecrets, type MergedSecret } from './secrets-merger'

const sys = (name: string, value: string, updated_at = '2026-05-26T00:00:00.000Z'): MergedSecret => ({
  name,
  value,
  updated_at,
  source: 'system',
})

const usr = (name: string, value: string, updated_at = '2026-05-26T01:00:00.000Z'): MergedSecret => ({
  name,
  value,
  updated_at,
  source: 'user',
})

describe('mergeSecrets', () => {
  it('returns system secrets unchanged when there are no user secrets', () => {
    const system = [
      sys('SUPABASE_ANON_KEY', 'sb_publishable_xxx'),
      sys('SUPABASE_URL', 'https://abc.example.com'),
    ]
    expect(mergeSecrets(system, [])).toEqual(system)
  })

  it('appends non-reserved user secrets after system secrets', () => {
    const system = [sys('SUPABASE_ANON_KEY', 'sys_anon')]
    const user = [usr('MY_KEY', 'user_value')]
    const result = mergeSecrets(system, user)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('SUPABASE_ANON_KEY')
    expect(result[1]).toEqual({
      name: 'MY_KEY',
      value: 'user_value',
      updated_at: '2026-05-26T01:00:00.000Z',
      source: 'user',
    })
  })

  it('lets a user secret override a same-named system secret without producing duplicates', () => {
    const system = [
      sys('SUPABASE_ANON_KEY', 'sys_anon'),
      sys('SUPABASE_URL', 'https://abc.example.com'),
    ]
    const user = [usr('SUPABASE_ANON_KEY', 'user_anon_override', '2026-05-27T00:00:00.000Z')]
    const result = mergeSecrets(system, user)
    expect(result).toHaveLength(2)
    const anon = result.find((s) => s.name === 'SUPABASE_ANON_KEY')!
    expect(anon.value).toBe('user_anon_override')
    expect(anon.updated_at).toBe('2026-05-27T00:00:00.000Z')
    expect(anon.source).toBe('user')
    // Non-overridden system secret stays put.
    expect(result.find((s) => s.name === 'SUPABASE_URL')!.value).toBe('https://abc.example.com')
  })

  it('keeps URL/PUBLIC_URL system defaults even when tenant-manager is degraded', () => {
    // Simulates the case where listAPIKeysAsSecrets returned [] (TM down),
    // but buildSystemSecrets still produced URL/PUBLIC_URL.
    const system = [
      sys('SUPABASE_URL', 'https://abc.example.com'),
      sys('SUPABASE_PUBLIC_URL', 'https://abc.example.com'),
    ]
    const user = [usr('MY_KEY', 'mine')]
    const result = mergeSecrets(system, user)
    expect(result.map((s) => s.name)).toEqual(['SUPABASE_URL', 'SUPABASE_PUBLIC_URL', 'MY_KEY'])
  })

  it('deduplicates when user provides the same name twice (last write wins)', () => {
    const system: MergedSecret[] = []
    const user = [
      usr('MY_KEY', 'first', '2026-05-26T01:00:00.000Z'),
      usr('MY_KEY', 'second', '2026-05-26T02:00:00.000Z'),
    ]
    const result = mergeSecrets(system, user)
    expect(result).toHaveLength(1)
    expect(result[0].value).toBe('second')
    expect(result[0].updated_at).toBe('2026-05-26T02:00:00.000Z')
  })

  it('preserves system insertion order before user-only additions', () => {
    const system = [
      sys('SUPABASE_ANON_KEY', 'a'),
      sys('SUPABASE_SERVICE_ROLE_KEY', 'b'),
      sys('SUPABASE_URL', 'c'),
      sys('SUPABASE_PUBLIC_URL', 'd'),
    ]
    const user = [usr('Z_LATER', 'z'), usr('A_LATER', 'a2')]
    const names = mergeSecrets(system, user).map((s) => s.name)
    expect(names).toEqual([
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_URL',
      'SUPABASE_PUBLIC_URL',
      'Z_LATER',
      'A_LATER',
    ])
  })
})
