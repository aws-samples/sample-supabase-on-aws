import { NextApiRequest, NextApiResponse } from 'next'
import { withSecureWriteAccess, ProjectIsolationContext } from 'lib/api/secure-api-wrapper'
import {
  projectSecretsStorage,
  validateSecretName,
  validateSecretValue,
  SecretsCorruptedError,
  SecretsLockTimeoutError,
} from 'lib/self-hosted-api'
import { buildSystemSecrets, MissingBaseDomainError } from 'lib/api/system-secrets'
import { mergeSecrets, type MergedSecret } from 'lib/api/secrets-merger'
import { isReserved } from 'lib/api/system-reserved-names'

export default withSecureWriteAccess(handler)

async function handler(req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res, context)
    case 'POST':
      return handlePost(req, res, context)
    case 'DELETE':
      return handleDelete(req, res, context)
    default:
      res.setHeader('Allow', ['GET', 'POST', 'DELETE'])
      res.status(405).json({
        data: null,
        error: { message: `Method ${method} Not Allowed` },
      })
      return
  }
}

interface SecretApiResponseEntry {
  name: string
  value: string
  updated_at?: string
}

function toApiResponse(secrets: ReadonlyArray<MergedSecret>): SecretApiResponseEntry[] {
  return secrets.map((s) => ({
    name: s.name,
    value: s.value,
    updated_at: s.updated_at,
  }))
}

function userSecretsToMerged(records: ReadonlyArray<{ name: string; value: string; updated_at: string }>): MergedSecret[] {
  return records.map((r) => ({
    name: r.name,
    value: r.value,
    updated_at: r.updated_at,
    source: 'user',
  }))
}

function respondCorrupted(res: NextApiResponse, error: unknown) {
  console.error('Secrets file corrupted/unreadable:', error)
  res.status(500).json({
    data: null,
    error: {
      message: 'Project secrets are unreadable. Contact support to recover or rotate the encryption key.',
      code: 'SECRETS_DECRYPT_FAILED',
    },
  })
}

function respondBusy(res: NextApiResponse, error: unknown) {
  console.error('Secrets file lock timeout:', error)
  res.status(503).json({
    data: null,
    error: {
      message: 'Project secrets are temporarily locked by another writer. Please retry shortly.',
      code: 'SECRETS_LOCK_TIMEOUT',
    },
  })
}

function respondMisconfigured(res: NextApiResponse, error: unknown) {
  console.error('Server misconfiguration while building system secrets:', error)
  res.status(500).json({
    data: null,
    error: {
      message: 'Server is misconfigured (SUPABASE_BASE_DOMAIN is not set).',
      code: 'SERVER_MISCONFIGURED',
    },
  })
}

/**
 * GET /api/v1/projects/{ref}/secrets
 * Returns the merged list of system + user secrets in plaintext.
 * Same name => user value wins; system reserved names always reappear.
 */
export const handleGet = async (
  req: NextApiRequest,
  res: NextApiResponse,
  context: ProjectIsolationContext
): Promise<void> => {
  const { projectRef } = context

  let system: MergedSecret[]
  try {
    system = await buildSystemSecrets(projectRef)
  } catch (error) {
    if (error instanceof MissingBaseDomainError) {
      return respondMisconfigured(res, error)
    }
    console.error('Failed to build system secrets:', error)
    res.status(500).json({
      data: null,
      error: {
        message: 'Failed to build system secrets',
        code: 'SECRETS_RETRIEVAL_ERROR',
      },
    })
    return
  }

  let userRecords
  try {
    userRecords = await projectSecretsStorage.loadProjectSecrets(projectRef)
  } catch (error) {
    if (error instanceof SecretsCorruptedError) {
      return respondCorrupted(res, error)
    }
    console.error('Error retrieving project secrets:', error)
    res.status(500).json({
      data: null,
      error: {
        message: 'Failed to retrieve project secrets',
        code: 'SECRETS_RETRIEVAL_ERROR',
      },
    })
    return
  }

  const merged = mergeSecrets(system, userSecretsToMerged(userRecords))
  res.status(200).json(toApiResponse(merged))
}

/**
 * POST /api/v1/projects/{ref}/secrets
 * Creates or overwrites user-defined secret entries.
 * Reserved names are accepted: they override the system default until DELETE'd.
 */
export const handlePost = async (
  req: NextApiRequest,
  res: NextApiResponse,
  context: ProjectIsolationContext
): Promise<void> => {
  const { projectRef, userId } = context
  const secrets = Array.isArray(req.body) ? req.body : req.body?.secrets

  if (!secrets || !Array.isArray(secrets) || secrets.length === 0) {
    res.status(400).json({
      data: null,
      error: {
        message: 'Request must include a non-empty array of secrets',
        code: 'INVALID_REQUEST_BODY',
      },
    })
    return
  }

  for (const secret of secrets) {
    if (!secret?.name || !secret?.value) {
      res.status(400).json({
        data: null,
        error: { message: 'Each secret must have both name and value', code: 'INVALID_SECRET_FORMAT' },
      })
      return
    }
    if (!validateSecretName(secret.name)) {
      res.status(400).json({
        data: null,
        error: {
          message: `Invalid secret name format: ${secret.name}. Secret names must start with a letter (a-z, A-Z), contain only alphanumeric characters and underscores, and be 1-100 characters long.`,
          code: 'INVALID_SECRET_NAME',
        },
      })
      return
    }
    if (!validateSecretValue(secret.value)) {
      res.status(400).json({
        data: null,
        error: { message: `Invalid secret value for: ${secret.name}`, code: 'INVALID_SECRET_VALUE' },
      })
      return
    }
  }

  try {
    await projectSecretsStorage.updateProjectSecrets(projectRef, secrets, userId || 'system')
  } catch (error) {
    if (error instanceof SecretsLockTimeoutError) {
      return respondBusy(res, error)
    }
    if (error instanceof SecretsCorruptedError) {
      return respondCorrupted(res, error)
    }
    console.error('Error creating/updating project secrets:', error)
    res.status(500).json({
      data: null,
      error: { message: 'Failed to create or update project secrets', code: 'SECRETS_UPDATE_ERROR' },
    })
    return
  }

  return reflectMergedState(projectRef, res, 201)
}

/**
 * DELETE /api/v1/projects/{ref}/secrets
 * Removes user-defined entries. For reserved names this only strips the user
 * override — the system default reappears in the next GET response.
 */
export const handleDelete = async (
  req: NextApiRequest,
  res: NextApiResponse,
  context: ProjectIsolationContext
): Promise<void> => {
  const { projectRef } = context
  const secretNames = Array.isArray(req.body) ? req.body : req.body?.secretNames

  if (!secretNames || !Array.isArray(secretNames) || secretNames.length === 0) {
    res.status(400).json({
      data: null,
      error: {
        message: 'Request must include a non-empty array of secret names to delete',
        code: 'INVALID_REQUEST_BODY',
      },
    })
    return
  }

  for (const name of secretNames) {
    if (!name || typeof name !== 'string') {
      res.status(400).json({
        data: null,
        error: { message: 'All secret names must be non-empty strings', code: 'INVALID_SECRET_NAME' },
      })
      return
    }
  }

  try {
    await projectSecretsStorage.removeProjectSecrets(projectRef, secretNames)
  } catch (error) {
    if (error instanceof SecretsLockTimeoutError) {
      return respondBusy(res, error)
    }
    if (error instanceof SecretsCorruptedError) {
      return respondCorrupted(res, error)
    }
    console.error('Error deleting project secrets:', error)
    res.status(500).json({
      data: null,
      error: { message: 'Failed to delete project secrets', code: 'SECRETS_DELETE_ERROR' },
    })
    return
  }

  // Note about reserved names: removal succeeds even when the name is reserved.
  // The system default is rebuilt on the next GET, so the row reappears with
  // the platform-provided value. We log a debug trail for traceability.
  const reservedRemoved = secretNames.filter(isReserved)
  if (reservedRemoved.length > 0) {
    console.info(
      `Reserved secret overrides removed for ${projectRef}: ${reservedRemoved.join(', ')}; system defaults will be served on next GET.`
    )
  }

  return reflectMergedState(projectRef, res, 200)
}

async function reflectMergedState(projectRef: string, res: NextApiResponse, status: number) {
  let system: MergedSecret[]
  try {
    system = await buildSystemSecrets(projectRef)
  } catch (error) {
    if (error instanceof MissingBaseDomainError) {
      return respondMisconfigured(res, error)
    }
    console.error('Failed to build system secrets after mutation:', error)
    res.status(500).json({
      data: null,
      error: { message: 'Failed to retrieve project secrets after update', code: 'SECRETS_RETRIEVAL_ERROR' },
    })
    return
  }

  let userRecords
  try {
    userRecords = await projectSecretsStorage.loadProjectSecrets(projectRef)
  } catch (error) {
    if (error instanceof SecretsCorruptedError) {
      return respondCorrupted(res, error)
    }
    console.error('Error retrieving project secrets after mutation:', error)
    res.status(500).json({
      data: null,
      error: { message: 'Failed to retrieve project secrets after update', code: 'SECRETS_RETRIEVAL_ERROR' },
    })
    return
  }

  const merged = mergeSecrets(system, userSecretsToMerged(userRecords))
  res.status(status).json(toApiResponse(merged))
}
