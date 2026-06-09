import { describe, expect, it } from 'vitest'

import { SYSTEM_RESERVED_NAMES, isReserved } from './system-reserved-names'

describe('SYSTEM_RESERVED_NAMES', () => {
  it('contains the four documented system secret names', () => {
    expect(SYSTEM_RESERVED_NAMES).toEqual([
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_URL',
      'SUPABASE_PUBLIC_URL',
    ])
  })

  it('is a readonly tuple at the type level', () => {
    // Compile-time check: assigning to an index should fail under TS strict.
    // Runtime: the array is frozen.
    expect(Object.isFrozen(SYSTEM_RESERVED_NAMES)).toBe(true)
  })
})

describe('isReserved', () => {
  it.each([
    ['SUPABASE_ANON_KEY', true],
    ['SUPABASE_SERVICE_ROLE_KEY', true],
    ['SUPABASE_URL', true],
    ['SUPABASE_PUBLIC_URL', true],
  ])('recognizes %s as reserved', (name, expected) => {
    expect(isReserved(name)).toBe(expected)
  })

  it.each([
    'MY_KEY',
    'TEST_GO_KEY',
    'supabase_anon_key', // case-sensitive
    'SUPABASE_ANON_KEY ', // trailing space
    '',
  ])('rejects %s as non-reserved', (name) => {
    expect(isReserved(name)).toBe(false)
  })
})
