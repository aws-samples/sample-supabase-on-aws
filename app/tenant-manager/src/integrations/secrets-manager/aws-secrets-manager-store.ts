/**
 * AWS Secrets Manager implementation of SecretsStore
 * Stores one secret per project: {prefix}/{projectRef}
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager'
import { getEnv } from '../../config/index.js'
import type { ProjectSecretDocument } from '../../types/project-secret.js'
import type { SecretsStore } from './types.js'

let client: SecretsManagerClient | null = null

function getClient(): SecretsManagerClient {
  if (!client) {
    const env = getEnv()
    client = new SecretsManagerClient({
      region: env.AWS_REGION,
      ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
    })
  }
  return client
}

function getSecretName(projectRef: string): string {
  const env = getEnv()
  return `${env.AWS_SECRETS_PREFIX}/${projectRef}`
}

export class AwsSecretsManagerStore implements SecretsStore {
  async getProjectSecret(projectRef: string): Promise<ProjectSecretDocument | null> {
    try {
      const result = await getClient().send(
        new GetSecretValueCommand({ SecretId: getSecretName(projectRef) })
      )

      if (!result.SecretString) {
        return null
      }

      return JSON.parse(result.SecretString) as ProjectSecretDocument
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        return null
      }
      throw error
    }
  }

  async putProjectSecret(projectRef: string, doc: ProjectSecretDocument): Promise<void> {
    const secretName = getSecretName(projectRef)
    const secretString = JSON.stringify(doc)

    try {
      await getClient().send(
        new PutSecretValueCommand({
          SecretId: secretName,
          SecretString: secretString,
        })
      )
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        // Secret doesn't exist yet, create it
        await getClient().send(
          new CreateSecretCommand({
            Name: secretName,
            SecretString: secretString,
            Description: `Supabase project secret for ${projectRef}`,
          })
        )
        return
      }
      throw error
    }
  }

  async deleteProjectSecret(projectRef: string): Promise<void> {
    try {
      await getClient().send(
        new DeleteSecretCommand({
          SecretId: getSecretName(projectRef),
          ForceDeleteWithoutRecovery: true,
        })
      )
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        // Already deleted, no-op
        return
      }
      throw error
    }
  }
}
