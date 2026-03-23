/**
 * RDS instance service layer
 * Wraps repository calls with business logic
 */

import {
  findRdsInstances,
  countRdsInstances,
  findRdsInstanceById,
  findRdsInstanceByIdentifier,
  insertRdsInstance,
  updateRdsInstanceById,
  deleteRdsInstanceById,
  setDraining,
  findAvailableInstances,
  type ListRdsInstancesOptions,
} from '../../db/repositories/rds-instance.repository.js'
import { getCredentialProvider } from '../../common/crypto/credential-provider.js'
import { resolveInstanceCredentials, removeInstancePool } from '../../db/instance-connection.js'
import { ensureTemplateExistsOnInstance } from '../provisioning/template-initializer.js'
import type { DbInstance } from '../../db/types.js'
import type { CreateRdsInstanceInput, UpdateRdsInstanceInput } from '../../types/index.js'

export async function listRdsInstances(params: ListRdsInstancesOptions = {}): Promise<DbInstance[]> {
  return findRdsInstances(params)
}

export async function getRdsInstancesCount(params: Omit<ListRdsInstancesOptions, 'page' | 'limit'> = {}): Promise<number> {
  return countRdsInstances(params)
}

export async function getRdsInstanceById(id: number): Promise<DbInstance | null> {
  return findRdsInstanceById(id)
}

export async function getRdsInstanceByIdentifier(identifier: string): Promise<DbInstance | null> {
  return findRdsInstanceByIdentifier(identifier)
}

export async function createRdsInstance(input: CreateRdsInstanceInput): Promise<DbInstance | null> {
  try {
    const authMethod = input.auth_method ?? 'password'
    const provider = getCredentialProvider(authMethod)

    let storedCredential: string | null = null
    if (authMethod === 'secrets_manager' && input.admin_credential) {
      // For secrets_manager: validate and store the reference
      storedCredential = await provider.storeCredential(input.admin_credential)
    } else if (input.admin_password) {
      // For password: encrypt the password
      storedCredential = await provider.storeCredential(input.admin_password)
    }

    const instance = await insertRdsInstance({
      identifier: input.identifier,
      name: input.name,
      host: input.host,
      port: input.port ?? 5432,
      admin_user: input.admin_user ?? 'postgres',
      auth_method: authMethod,
      admin_credential: storedCredential,
      region: input.region ?? 'default',
      weight: input.weight ?? 100,
      max_databases: input.max_databases ?? 100,
    })

    // Best-effort: initialize template on the new instance
    try {
      const conn = await resolveInstanceCredentials(instance)
      await ensureTemplateExistsOnInstance(conn)
    } catch (error) {
      console.warn(
        `Template init failed on ${instance.identifier}, will fall back to legacy creation: ${error instanceof Error ? error.message : error}`
      )
    }

    return instance
  } catch (error) {
    console.error('Failed to create RDS instance:', error instanceof Error ? error.message : error)
    return null
  }
}

export async function updateRdsInstance(id: number, input: UpdateRdsInstanceInput): Promise<DbInstance | null> {
  const updates: Record<string, unknown> = {}

  if (input.name !== undefined) updates['name'] = input.name
  if (input.host !== undefined) updates['host'] = input.host
  if (input.port !== undefined) updates['port'] = input.port
  if (input.admin_user !== undefined) updates['admin_user'] = input.admin_user
  if (input.region !== undefined) updates['region'] = input.region
  if (input.status !== undefined) updates['status'] = input.status
  if (input.weight !== undefined) updates['weight'] = input.weight
  if (input.max_databases !== undefined) updates['max_databases'] = input.max_databases

  // Handle credential updates
  if (input.auth_method !== undefined) {
    updates['auth_method'] = input.auth_method
  }

  if (input.admin_credential !== undefined || input.admin_password !== undefined) {
    // Determine the auth method for credential storage
    const existingInstance = await findRdsInstanceById(id)
    const authMethod = input.auth_method ?? existingInstance?.auth_method ?? 'password'
    const provider = getCredentialProvider(authMethod)

    if (authMethod === 'secrets_manager' && input.admin_credential !== undefined) {
      updates['admin_credential'] = await provider.storeCredential(input.admin_credential)
    } else if (input.admin_password !== undefined) {
      updates['admin_credential'] = await provider.storeCredential(input.admin_password)
    }
  }

  if (Object.keys(updates).length === 0) {
    return findRdsInstanceById(id)
  }

  // Invalidate cached connection pool when connection-related fields change
  if (input.host !== undefined || input.port !== undefined || input.admin_user !== undefined ||
      input.admin_password !== undefined || input.auth_method !== undefined || input.admin_credential !== undefined) {
    await removeInstancePool(id)
  }

  return updateRdsInstanceById(id, updates)
}

export async function deleteRdsInstance(id: number): Promise<boolean> {
  await removeInstancePool(id)
  return deleteRdsInstanceById(id)
}

export async function setInstanceDraining(id: number): Promise<boolean> {
  return setDraining(id)
}

export async function getAvailableInstances(): Promise<DbInstance[]> {
  return findAvailableInstances()
}

/**
 * Test credentials for an instance
 */
export async function testInstanceCredentials(id: number): Promise<{ success: boolean; error?: string }> {
  const instance = await findRdsInstanceById(id)
  if (!instance) {
    return { success: false, error: 'Instance not found' }
  }

  if (!instance.admin_credential) {
    return { success: false, error: 'No credential stored for this instance' }
  }

  try {
    const provider = getCredentialProvider(instance.auth_method)
    await provider.getCredential(instance as any)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}
