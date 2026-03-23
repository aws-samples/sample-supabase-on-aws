import { NextApiRequest, NextApiResponse } from 'next'
import { withSecureWriteAccess, ProjectIsolationContext } from 'lib/api/secure-api-wrapper'
import { 
  projectSecretsStorage, 
  validateSecretName, 
  validateSecretValue,
  hashToken,
  type SecretsResponse,
  type CreateSecretsRequest,
  type DeleteSecretsRequest,
  type SecretResponse
} from 'lib/self-hosted-api'
import { listAPIKeysAsSecrets } from 'lib/api/tenant-manager'

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
        error: { message: `Method ${method} Not Allowed` } 
      })
      return
  }
}

/**
 * GET /api/v1/projects/{ref}/secrets
 * Retrieves project secrets including API keys from Tenant-Manager
 */
export const handleGet = async (
  req: NextApiRequest, 
  res: NextApiResponse, 
  context: ProjectIsolationContext
): Promise<void> => {
  const { projectRef } = context

  try {
    // Load user secrets for this project
    const secrets = await projectSecretsStorage.loadProjectSecrets(projectRef)
    
    // Return only secret names, digest, and metadata (not actual values for security)
    const secretResponses: SecretResponse[] = secrets.map(secret => ({
      name: secret.name,
      value: hashToken(secret.value), // Return SHA256 digest instead of actual value
      updated_at: secret.updated_at
    }))

    // Get API keys from Tenant-Manager (AWS Secrets Manager)
    const apiKeySecrets = await listAPIKeysAsSecrets(projectRef)

    // Combine API keys with user secrets (API keys first)
    const allSecrets = [...apiKeySecrets, ...secretResponses]

    // Return array directly (frontend expects array, not object with secrets property)
    res.status(200).json(allSecrets)
  } catch (error) {
    console.error('Error retrieving project secrets:', error)
    res.status(500).json({
      data: null,
      error: { 
        message: 'Failed to retrieve project secrets',
        code: 'SECRETS_RETRIEVAL_ERROR'
      }
    })
  }
}

/**
 * POST /api/v1/projects/{ref}/secrets
 * Creates or updates project secrets
 */
export const handlePost = async (
  req: NextApiRequest, 
  res: NextApiResponse, 
  context: ProjectIsolationContext
): Promise<void> => {
  const { projectRef, userId } = context
  
  // Frontend sends array directly, not wrapped in object
  const secrets = Array.isArray(req.body) ? req.body : req.body.secrets

  // Validate request body
  if (!secrets || !Array.isArray(secrets) || secrets.length === 0) {
    res.status(400).json({
      data: null,
      error: { 
        message: 'Request must include a non-empty array of secrets',
        code: 'INVALID_REQUEST_BODY'
      }
    })
    return
  }

  // Validate each secret
  for (const secret of secrets) {
    if (!secret.name || !secret.value) {
      res.status(400).json({
        data: null,
        error: { 
          message: 'Each secret must have both name and value',
          code: 'INVALID_SECRET_FORMAT'
        }
      })
      return
    }

    // Validate secret name format (environment variable naming)
    if (!validateSecretName(secret.name)) {
      res.status(400).json({
        data: null,
        error: { 
          message: `Invalid secret name format: ${secret.name}. Secret names must start with a letter (a-z, A-Z), contain only alphanumeric characters and underscores, and be 1-100 characters long. Examples: api_key, DATABASE_URL, supabase_secret`,
          code: 'INVALID_SECRET_NAME'
        }
      })
      return
    }

    // Validate secret value
    if (!validateSecretValue(secret.value)) {
      res.status(400).json({
        data: null,
        error: { 
          message: `Invalid secret value for: ${secret.name}`,
          code: 'INVALID_SECRET_VALUE'
        }
      })
      return
    }
  }

  try {
    // Update or create secrets
    await projectSecretsStorage.updateProjectSecrets(
      projectRef,
      secrets,
      userId || 'system'
    )

    // Return updated secrets list (names and digests only)
    const updatedSecrets = await projectSecretsStorage.loadProjectSecrets(projectRef)
    const secretResponses: SecretResponse[] = updatedSecrets.map(secret => ({
      name: secret.name,
      value: hashToken(secret.value), // Return SHA256 digest instead of actual value
      updated_at: secret.updated_at
    }))

    // Return array directly (frontend expects array, not object with secrets property)
    res.status(201).json(secretResponses)
  } catch (error) {
    console.error('Error creating/updating project secrets:', error)
    res.status(500).json({
      data: null,
      error: { 
        message: 'Failed to create or update project secrets',
        code: 'SECRETS_UPDATE_ERROR'
      }
    })
  }
}

/**
 * DELETE /api/v1/projects/{ref}/secrets
 * Removes project secrets
 */
export const handleDelete = async (
  req: NextApiRequest, 
  res: NextApiResponse, 
  context: ProjectIsolationContext
): Promise<void> => {
  const { projectRef } = context
  
  // Frontend might send array directly or wrapped in object
  const secretNames = Array.isArray(req.body) ? req.body : req.body.secretNames

  // Validate request body
  if (!secretNames || !Array.isArray(secretNames) || secretNames.length === 0) {
    res.status(400).json({
      data: null,
      error: { 
        message: 'Request must include a non-empty array of secret names to delete',
        code: 'INVALID_REQUEST_BODY'
      }
    })
    return
  }

  // Validate secret names
  for (const secretName of secretNames) {
    if (!secretName || typeof secretName !== 'string') {
      res.status(400).json({
        data: null,
        error: { 
          message: 'All secret names must be non-empty strings',
          code: 'INVALID_SECRET_NAME'
        }
      })
      return
    }
  }

  try {
    // Remove secrets
    await projectSecretsStorage.removeProjectSecrets(projectRef, secretNames)

    // Return updated secrets list
    const remainingSecrets = await projectSecretsStorage.loadProjectSecrets(projectRef)
    const secretResponses: SecretResponse[] = remainingSecrets.map(secret => ({
      name: secret.name,
      value: hashToken(secret.value), // Return SHA256 digest instead of actual value
      updated_at: secret.updated_at
    }))

    // Return array directly (frontend expects array, not object with secrets property)
    res.status(200).json(secretResponses)
  } catch (error) {
    console.error('Error deleting project secrets:', error)
    res.status(500).json({
      data: null,
      error: { 
        message: 'Failed to delete project secrets',
        code: 'SECRETS_DELETE_ERROR'
      }
    })
  }
}