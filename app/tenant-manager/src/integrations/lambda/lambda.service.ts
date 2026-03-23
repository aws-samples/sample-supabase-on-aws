/**
 * AWS Lambda management for PostgREST functions.
 * Ported from project-service/create-pgrest-lambda.ts
 */

import {
  LambdaClient,
  CreateFunctionCommand,
  GetFunctionCommand,
  GetFunctionUrlConfigCommand,
  CreateFunctionUrlConfigCommand,
  DeleteFunctionCommand,
  PublishVersionCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda'
import { getEnv } from '../../config/index.js'

export interface LambdaCreationResult {
  functionName: string
  functionArn: string
  functionUrl: string
}

let client: LambdaClient | null = null

function getLambdaClient(): LambdaClient {
  if (!client) {
    client = new LambdaClient({ region: getEnv().AWS_REGION })
  }
  return client
}

/**
 * Create a PostgREST Lambda function or return existing.
 * Waits for Active state and ensures Function URL exists.
 */
export async function createPostgrestLambda(projectRef: string): Promise<LambdaCreationResult> {
  const env = getEnv()
  const lambdaClient = getLambdaClient()
  const functionName = `postgrest-${projectRef}`

  if (!env.POSTGREST_ECR_IMAGE_URI || !env.LAMBDA_ROLE_ARN) {
    throw new Error('POSTGREST_ECR_IMAGE_URI and LAMBDA_ROLE_ARN are required for Lambda creation')
  }

  let functionArn: string

  try {
    const existing = await lambdaClient.send(
      new GetFunctionCommand({ FunctionName: functionName }),
    )
    functionArn = existing.Configuration!.FunctionArn!
    const state = existing.Configuration?.State
    if (state !== 'Active') {
      await waitForLambdaActive(lambdaClient, functionName)
    }
    console.debug(`[lambda] Function already exists: ${functionName} (${functionArn})`)
  } catch (error: unknown) {
    if (!(error instanceof ResourceNotFoundException)) throw error

    console.debug(`[lambda] Creating function: ${functionName}`)

    // Only include VpcConfig if subnet and security group IDs are provided
    const vpcConfig =
      env.VPC_SUBNET_IDS.length > 0 && env.VPC_SECURITY_GROUP_IDS.length > 0
        ? {
            SubnetIds: env.VPC_SUBNET_IDS,
            SecurityGroupIds: env.VPC_SECURITY_GROUP_IDS,
          }
        : undefined

    const result = await lambdaClient.send(
      new CreateFunctionCommand({
        FunctionName: functionName,
        PackageType: 'Image',
        Code: { ImageUri: env.POSTGREST_ECR_IMAGE_URI },
        Role: env.LAMBDA_ROLE_ARN,
        Timeout: 30,
        MemorySize: 512,
        Environment: { Variables: { PROJECT_ID: projectRef } },
        VpcConfig: vpcConfig,
      }),
    )
    functionArn = result.FunctionArn!
    console.debug(`[lambda] Function created: ${functionName} (${functionArn})`)
    await waitForLambdaActive(lambdaClient, functionName)
  }

  // Publish a version for immutable deployment tracking
  const version = await lambdaClient.send(
    new PublishVersionCommand({ FunctionName: functionName }),
  )
  console.debug(`[lambda] Published version ${version.Version} for ${functionName}`)

  const functionUrl = await ensureFunctionUrl(lambdaClient, functionName)

  return { functionName, functionArn, functionUrl }
}

/**
 * Delete a PostgREST Lambda function (for deprovision/rollback).
 */
export async function deletePostgrestLambda(projectRef: string): Promise<void> {
  const lambdaClient = getLambdaClient()
  const functionName = `postgrest-${projectRef}`
  try {
    await lambdaClient.send(new DeleteFunctionCommand({ FunctionName: functionName }))
    console.debug(`[lambda] Deleted function: ${functionName}`)
  } catch (error: unknown) {
    if (error instanceof ResourceNotFoundException) return
    throw error
  }
}

/**
 * Check if Lambda creation is enabled (required env vars present).
 */
export function isLambdaCreationEnabled(): boolean {
  const env = getEnv()
  return !!(env.POSTGREST_ECR_IMAGE_URI && env.LAMBDA_ROLE_ARN)
}

/**
 * Clear cached Lambda client (for testing).
 */
export function clearLambdaClient(): void {
  client = null
}

async function waitForLambdaActive(lambdaClient: LambdaClient, functionName: string): Promise<void> {
  console.debug(`[lambda] Waiting for ${functionName} to become Active...`)
  const maxWaitMs = 360_000
  const pollIntervalMs = 2_000
  const startTime = Date.now()
  let state = 'Pending'

  while (state !== 'Active') {
    if (Date.now() - startTime > maxWaitMs) {
      throw new Error(
        `Lambda ${functionName} did not become Active within ${maxWaitMs / 1000}s. Last state: ${state}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    const result = await lambdaClient.send(
      new GetFunctionCommand({ FunctionName: functionName }),
    )
    state = result.Configuration?.State || 'Pending'
    console.debug(`[lambda] ${functionName} state: ${state}`)
  }

  console.debug(`[lambda] ${functionName} is Active`)
}

async function ensureFunctionUrl(lambdaClient: LambdaClient, functionName: string): Promise<string> {
  try {
    const config = await lambdaClient.send(
      new GetFunctionUrlConfigCommand({ FunctionName: functionName }),
    )
    console.debug(`[lambda] Function URL exists: ${config.FunctionUrl}`)
    return config.FunctionUrl!
  } catch (error: unknown) {
    if (!(error instanceof ResourceNotFoundException)) throw error
  }

  console.debug(`[lambda] Creating Function URL for ${functionName}...`)
  const result = await lambdaClient.send(
    new CreateFunctionUrlConfigCommand({
      FunctionName: functionName,
      AuthType: 'AWS_IAM',
      Cors: {
        AllowOrigins: ['*'],
        AllowMethods: ['*'],
        AllowHeaders: ['*'],
        MaxAge: 86400,
      },
    }),
  )
  console.debug(`[lambda] Function URL created: ${result.FunctionUrl}`)
  return result.FunctionUrl!
}
