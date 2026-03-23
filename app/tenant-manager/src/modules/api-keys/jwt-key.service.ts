/**
 * JWT key rotation service
 * Manages JWT signing keys stored in AWS Secrets Manager
 */

import crypto from 'crypto'
import { getSecretsStore } from '../../integrations/secrets-manager/index.js'
import { resignApiKeyJwt } from '../../common/crypto/api-key-generator.js'
import { getProjectByRef } from '../project/project.service.js'
import { registerAuthTenant, isAuthMultiTenantEnabled } from '../../integrations/auth/auth.client.js'
import { registerRealtimeTenant } from '../../integrations/realtime/realtime.client.js'
import { getEnv } from '../../config/index.js'
import { findRdsInstanceById } from '../../db/repositories/rds-instance.repository.js'
import { resolveInstanceCredentials } from '../../db/instance-connection.js'
import { NotFoundError, ConflictError } from '../../common/errors/index.js'
import type { JwtKey, JwtKeyPublicInfo, JwtKeyRotationResult } from '../../types/jwt-key.js'

function toPublicInfo(key: JwtKey): JwtKeyPublicInfo {
  return {
    id: key.id,
    status: key.status,
    algorithm: key.algorithm,
    created_at: key.created_at,
    rotated_at: key.rotated_at,
  }
}

/**
 * List JWT signing keys for a project (secrets are not exposed)
 */
export async function listJwtKeys(projectRef: string): Promise<JwtKeyPublicInfo[]> {
  const project = await getProjectByRef(projectRef)
  if (!project) {
    throw new NotFoundError(`Project not found: ${projectRef}`)
  }

  const secretsStore = getSecretsStore()
  const doc = await secretsStore.getProjectSecret(projectRef)
  if (!doc) {
    return []
  }

  return doc.jwt_keys.map(toPublicInfo)
}

/**
 * Create a standby JWT signing key for future rotation
 */
export async function createStandbyKey(projectRef: string): Promise<JwtKeyPublicInfo> {
  const project = await getProjectByRef(projectRef)
  if (!project) {
    throw new NotFoundError(`Project not found: ${projectRef}`)
  }

  const secretsStore = getSecretsStore()
  const doc = await secretsStore.getProjectSecret(projectRef)
  if (!doc) {
    throw new NotFoundError(`Project secret not found for: ${projectRef}`)
  }

  const existing = doc.jwt_keys.find((k) => k.status === 'standby')
  if (existing) {
    throw new ConflictError('A standby key already exists. Rotate or delete it first.')
  }

  const newKey: JwtKey = {
    id: crypto.randomUUID(),
    secret: crypto.randomBytes(32).toString('base64'),
    status: 'standby',
    algorithm: 'HS256',
    created_at: new Date().toISOString(),
    rotated_at: null,
  }

  doc.jwt_keys.push(newKey)
  await secretsStore.putProjectSecret(projectRef, doc)

  return toPublicInfo(newKey)
}

/**
 * Rotate JWT keys: standby -> current -> previous -> (deleted)
 * Re-signs all active API keys with the new current key
 * Updates tenant DB jwt_secret and re-registers external services
 */
export async function rotateJwtKeys(projectRef: string): Promise<JwtKeyRotationResult> {
  const project = await getProjectByRef(projectRef)
  if (!project) {
    throw new NotFoundError(`Project not found: ${projectRef}`)
  }

  const secretsStore = getSecretsStore()
  const doc = await secretsStore.getProjectSecret(projectRef)
  if (!doc) {
    throw new NotFoundError(`Project secret not found for: ${projectRef}`)
  }

  const standbyKey = doc.jwt_keys.find((k) => k.status === 'standby')
  if (!standbyKey) {
    throw new ConflictError('No standby key exists. Create one before rotating.')
  }

  const oldCurrentKey = doc.jwt_keys.find((k) => k.status === 'current')
  if (!oldCurrentKey) {
    throw new Error('No current JWT key found — invalid state')
  }

  const now = new Date().toISOString()

  // Promote standby -> current
  standbyKey.status = 'current'
  standbyKey.rotated_at = now

  // Demote old current -> previous
  oldCurrentKey.status = 'previous'
  oldCurrentKey.rotated_at = now

  // Remove any existing previous key (keep at most: current + previous + standby = 3)
  doc.jwt_keys = doc.jwt_keys.filter(
    (k) => k.id === standbyKey.id || k.id === oldCurrentKey.id
  )

  // Re-sign all active API keys with the new current key
  let resignedCount = 0
  for (const apiKey of doc.api_keys) {
    if (apiKey.status === 'active') {
      apiKey.jwt = resignApiKeyJwt({
        originalJwt: apiKey.jwt,
        newJwtSecret: standbyKey.secret,
        newKeyId: standbyKey.id,
      })
      apiKey.jwt_key_id = standbyKey.id
      apiKey.updated_at = now
      resignedCount++
    }
  }

  // Save the updated document
  await secretsStore.putProjectSecret(projectRef, doc)

  // Re-register with external services using new jwt_secret
  const env = getEnv()

  // Resolve instance-specific password, fall back to global env
  let dbPassword = env.POSTGRES_PASSWORD
  if (project.db_instance_id) {
    const instance = await findRdsInstanceById(project.db_instance_id)
    if (instance) {
      try {
        const rotateConn = await resolveInstanceCredentials(instance)
        dbPassword = rotateConn.password
      } catch { /* fall back to env */ }
    }
  }

  const tenantConfig = {
    projectRef,
    dbName: project.db_name,
    dbHost: project.db_host,
    dbPort: project.db_port,
    dbPassword,
    jwtSecret: standbyKey.secret,
    anonKey: doc.api_keys.find((k) => k.role === 'anon' && k.status === 'active')?.jwt || '',
    serviceRoleKey: doc.api_keys.find((k) => k.role === 'service_role' && k.status === 'active')?.jwt || '',
  }

  if (isAuthMultiTenantEnabled()) {
    await registerAuthTenant(tenantConfig)
  }
  await registerRealtimeTenant(tenantConfig)

  return {
    current: toPublicInfo(standbyKey),
    previous: toPublicInfo(oldCurrentKey),
    api_keys_resigned: resignedCount,
  }
}
