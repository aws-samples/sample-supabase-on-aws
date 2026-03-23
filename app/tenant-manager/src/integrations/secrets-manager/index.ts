/**
 * Secrets store factory
 */

import { AwsSecretsManagerStore } from './aws-secrets-manager-store.js'
import type { SecretsStore } from './types.js'

let instance: SecretsStore | null = null

/**
 * Get the singleton SecretsStore instance
 */
export function getSecretsStore(): SecretsStore {
  if (!instance) {
    instance = new AwsSecretsManagerStore()
  }
  return instance
}

export type { SecretsStore } from './types.js'
