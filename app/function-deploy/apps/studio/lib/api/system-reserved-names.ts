/**
 * Names of secrets that the platform always provides.
 * Users may override their values via POST, but the names themselves
 * always reappear from system defaults after a DELETE.
 */
export const SYSTEM_RESERVED_NAMES = Object.freeze([
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_URL',
  'SUPABASE_PUBLIC_URL',
] as const)

export type SystemReservedName = (typeof SYSTEM_RESERVED_NAMES)[number]

const reservedSet: ReadonlySet<string> = new Set(SYSTEM_RESERVED_NAMES)

export function isReserved(name: string): boolean {
  return reservedSet.has(name)
}
