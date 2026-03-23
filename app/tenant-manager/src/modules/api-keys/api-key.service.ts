/**
 * API key CRUD service
 * Manages API keys stored in AWS Secrets Manager
 */

import crypto from 'crypto'
import { getSecretsStore } from '../../integrations/secrets-manager/index.js'
import { generateOpaqueKey, generateApiKeyJwt } from '../../common/crypto/api-key-generator.js'
import { getProjectByRef } from '../project/project.service.js'
import { getApiKeysByProjectId } from '../../db/platform-queries.js'
import { NotFoundError, ConflictError } from '../../common/errors/index.js'
import type { CreateApiKeyInput, ApiKeyCreatedResponse, ApiKeyListItem, ApiKey } from '../../types/api-key.js'

/**
 * Create a new API key for a project
 */
export async function createApiKey(
  projectRef: string,
  input: CreateApiKeyInput
): Promise<ApiKeyCreatedResponse> {
  const project = await getProjectByRef(projectRef)
  if (!project) {
    throw new NotFoundError(`Project not found: ${projectRef}`)
  }

  const secretsStore = getSecretsStore()
  const doc = await secretsStore.getProjectSecret(projectRef)
  if (!doc) {
    throw new NotFoundError(`Project secret not found for: ${projectRef}`)
  }

  const currentJwtKey = doc.jwt_keys.find((k) => k.status === 'current')
  if (!currentJwtKey) {
    throw new Error('No current JWT signing key found')
  }

  const apiKeyId = crypto.randomUUID()
  const { opaqueKey, prefix, hashedSecret } = generateOpaqueKey(input.type)
  const jwtToken = generateApiKeyJwt({
    projectRef,
    role: input.role,
    jwtSecret: currentJwtKey.secret,
    keyId: currentJwtKey.id,
    apiKeyId,
  })

  const now = new Date().toISOString()
  const newApiKey: ApiKey = {
    id: apiKeyId,
    project_ref: projectRef,
    name: input.name,
    type: input.type,
    role: input.role,
    prefix,
    hashed_secret: hashedSecret,
    jwt: jwtToken,
    jwt_key_id: currentJwtKey.id,
    status: 'active',
    description: input.description ?? null,
    created_at: now,
    updated_at: now,
    revoked_at: null,
  }

  doc.api_keys.push(newApiKey)
  await secretsStore.putProjectSecret(projectRef, doc)

  return {
    id: apiKeyId,
    name: input.name,
    type: input.type,
    role: input.role,
    prefix,
    opaque_key: opaqueKey,
    jwt: jwtToken,
    description: input.description ?? null,
    created_at: now,
  }
}

/**
 * List all active API keys for a project.
 * Returns opaque keys (sb_publishable_xxx / sb_secret_xxx) from the platform DB,
 * which match what is registered in Kong key-auth.
 */
export async function listApiKeys(projectRef: string): Promise<ApiKeyListItem[]> {
  const project = await getProjectByRef(projectRef)
  if (!project) {
    throw new NotFoundError(`Project not found: ${projectRef}`)
  }

  const secretsStore = getSecretsStore()
  const doc = await secretsStore.getProjectSecret(projectRef)
  if (!doc) {
    return []
  }

  // Fetch opaque keys from platform DB (these match Kong key-auth credentials)
  const dbKeys = await getApiKeysByProjectId(projectRef)
  const opaqueByRole = new Map(dbKeys.map((k) => [k.role, k.key_value]))

  return doc.api_keys
    .filter((k) => k.status === 'active')
    .map((k) => ({
      id: k.id,
      name: k.name,
      type: k.type,
      role: k.role,
      prefix: k.prefix,
      jwt: k.jwt,
      opaque_key: opaqueByRole.get(k.role) ?? '',
      status: k.status,
      description: k.description,
      created_at: k.created_at,
    }))
}

/**
 * Get a single API key by ID
 */
export async function getApiKey(projectRef: string, keyId: string): Promise<ApiKeyListItem | null> {
  const project = await getProjectByRef(projectRef)
  if (!project) {
    throw new NotFoundError(`Project not found: ${projectRef}`)
  }

  const secretsStore = getSecretsStore()
  const doc = await secretsStore.getProjectSecret(projectRef)
  if (!doc) {
    return null
  }

  const key = doc.api_keys.find((k) => k.id === keyId)
  if (!key) {
    return null
  }

  const dbKeys = await getApiKeysByProjectId(projectRef)
  const opaqueByRole = new Map(dbKeys.map((k) => [k.role, k.key_value]))

  return {
    id: key.id,
    name: key.name,
    type: key.type,
    role: key.role,
    prefix: key.prefix,
    jwt: key.jwt,
    opaque_key: opaqueByRole.get(key.role) ?? '',
    status: key.status,
    description: key.description,
    created_at: key.created_at,
  }
}

/**
 * Revoke an API key
 */
export async function revokeApiKey(projectRef: string, keyId: string): Promise<void> {
  const project = await getProjectByRef(projectRef)
  if (!project) {
    throw new NotFoundError(`Project not found: ${projectRef}`)
  }

  const secretsStore = getSecretsStore()
  const doc = await secretsStore.getProjectSecret(projectRef)
  if (!doc) {
    throw new NotFoundError(`Project secret not found for: ${projectRef}`)
  }

  const key = doc.api_keys.find((k) => k.id === keyId)
  if (!key) {
    throw new NotFoundError(`API key not found: ${keyId}`)
  }

  if (key.status === 'revoked') {
    throw new ConflictError(`API key already revoked: ${keyId}`)
  }

  key.status = 'revoked'
  key.revoked_at = new Date().toISOString()
  key.updated_at = new Date().toISOString()

  await secretsStore.putProjectSecret(projectRef, doc)
}
