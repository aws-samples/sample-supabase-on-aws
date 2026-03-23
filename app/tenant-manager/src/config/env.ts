/**
 * Environment variable schema and validation using Zod
 */

import { z } from 'zod'

const envSchema = z.object({
  // Service configuration
  PORT: z.string().default('3001').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Authentication
  ADMIN_API_KEY: z.string().min(1, 'ADMIN_API_KEY is required'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),

  // Encryption key for secrets storage (replaces PG_META_CRYPTO_KEY)
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY is required'),

  // Database (direct connection)
  POSTGRES_HOST: z.string().default('db'),
  POSTGRES_PORT: z.string().default('5432').transform(Number),
  POSTGRES_PASSWORD: z.string().default('postgres'),
  POSTGRES_DB: z.string().default('postgres'),
  POSTGRES_USER_READ_WRITE: z.string().default('supabase_admin'),
  POSTGRES_USER_READ_ONLY: z.string().default('supabase_read_only_user'),

  // Connection pool sizes
  MANAGEMENT_DB_POOL_SIZE: z.string().default('10').transform(Number),
  SYSTEM_DB_POOL_SIZE: z.string().default('5').transform(Number),

  // External services
  GOTRUE_URL: z.string().default('http://auth:9999'),
  GOTRUE_ADMIN_KEY: z.string().optional(),
  GOTRUE_MULTI_TENANT: z.string().transform((v) => v === 'true').default('false'),
  REALTIME_URL: z.string().default('http://realtime:4000'),
  API_JWT_SECRET: z.string().optional(),
  SUPAVISOR_URL: z.string().default('http://supavisor:4000'),
  SUPAVISOR_API_KEY: z.string().optional(),

  // Pooler configuration
  POOLER_DEFAULT_POOL_SIZE: z.string().default('15').transform(Number),
  POOLER_MAX_CLIENT_CONN: z.string().default('200').transform(Number),

  // AWS Secrets Manager
  AWS_REGION: z.string().min(1, 'AWS_REGION is required'),
  AWS_SECRETS_PREFIX: z.string().default('supabase'),
  AWS_ENDPOINT_URL: z.string().optional(),

  // AWS Secrets Manager for RDS credentials (optional, for secrets_manager auth mode)
  AWS_SM_REGION: z.string().optional(),
  AWS_SM_MAX_RETRIES: z.string().default('3').transform(Number),
  AWS_SM_TIMEOUT: z.string().default('5000').transform(Number),

  // Lambda creation (optional - enables PostgREST Lambda provisioning)
  POSTGREST_ECR_IMAGE_URI: z.string().optional(),
  LAMBDA_ROLE_ARN: z.string().optional(),
  VPC_SUBNET_IDS: z.string().optional().transform((v) => v ? v.split(',').map(s => s.trim()) : []),
  VPC_SECURITY_GROUP_IDS: z.string().optional().transform((v) => v ? v.split(',').map(s => s.trim()) : []),
  RDS_SECRET_ARN: z.string().optional(),

  // Kong Admin API
  KONG_ADMIN_URL: z.string().default('http://kong-gateway.supabase.local:8001'),

  // supabase_platform DB (falls back to POSTGRES_* if not set)
  PLATFORM_DB_HOST: z.string().optional(),
  PLATFORM_DB_PORT: z.string().default('5432').transform(Number),
  PLATFORM_DB_NAME: z.string().default('supabase_platform'),
  PLATFORM_DB_USER: z.string().optional(),
  PLATFORM_DB_PASSWORD: z.string().optional(),

  // Metrics collection
  METRICS_COLLECTION_INTERVAL: z.string().default('300000').transform(Number),
  METRICS_RETENTION_DAYS: z.string().default('30').transform(Number),

  // Site URL (for Auth)
  SITE_URL: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

let cachedEnv: Env | null = null

/**
 * Validate and return environment variables
 * Throws if validation fails
 */
export function getEnv(): Env {
  if (cachedEnv) {
    return cachedEnv
  }

  const result = envSchema.safeParse(process.env)

  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n')
    throw new Error(`Environment validation failed:\n${errors}`)
  }

  cachedEnv = result.data
  return cachedEnv
}

/**
 * Get environment without throwing (for optional validation)
 */
export function tryGetEnv(): Env | null {
  try {
    return getEnv()
  } catch {
    return null
  }
}

/**
 * Clear cached environment (for testing)
 */
export function clearEnvCache(): void {
  cachedEnv = null
}
