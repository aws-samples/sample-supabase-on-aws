/**
 * Merges system-default secrets with user-defined secrets so that:
 *  - every name appears at most once in the output
 *  - a same-named user secret overrides the system value (value + updated_at)
 *  - system-only secrets keep their original insertion order
 *  - user-only secrets are appended in their input order, with later entries
 *    overriding earlier ones (last-write-wins for duplicates inside `user`)
 */

export type SecretSource = 'system' | 'user'

export interface MergedSecret {
  name: string
  value: string
  updated_at?: string
  source: SecretSource
}

export function mergeSecrets(
  system: ReadonlyArray<MergedSecret>,
  user: ReadonlyArray<MergedSecret>
): MergedSecret[] {
  const byName = new Map<string, MergedSecret>()
  const order: string[] = []

  for (const secret of system) {
    if (!byName.has(secret.name)) {
      order.push(secret.name)
    }
    byName.set(secret.name, secret)
  }

  for (const secret of user) {
    if (!byName.has(secret.name)) {
      order.push(secret.name)
    }
    byName.set(secret.name, secret)
  }

  return order.map((name) => byName.get(name)!)
}
