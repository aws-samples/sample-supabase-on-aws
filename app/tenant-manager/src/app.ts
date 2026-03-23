/**
 * Fastify application configuration
 */

import Fastify, { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { getEnv } from './config/index.js'
import { errorHandler, notFoundHandler } from './common/middleware/error-handler.js'
import { registerRequestId } from './common/middleware/request-id.js'
import { migrateUp } from './db/migrator.js'
import { getSystemPool } from './db/connection.js'
import { getPlatformPool } from './db/platform-connection.js'
import { findRdsInstances } from './db/repositories/rds-instance.repository.js'
import { resolveInstanceCredentials } from './db/instance-connection.js'
import { ensureTemplateExistsOnInstance } from './modules/provisioning/template-initializer.js'
import { healthRoutes } from './modules/health/health.routes.js'
import { projectRoutes } from './modules/project/project.routes.js'
import { rdsInstanceRoutes } from './modules/rds-instance/rds-instance.routes.js'
import { apiKeyRoutes } from './modules/api-keys/api-key.routes.js'
import { jwtKeyRoutes } from './modules/api-keys/jwt-key.routes.js'
import { allocationStrategyRoutes } from './modules/balancer/allocation-strategy.routes.js'
import { metricsRoutes } from './modules/metrics/metrics.routes.js'
import { runtimeConfigRoutes } from './modules/runtime-config/runtime-config.routes.js'
import { schemaReloadRoutes } from './modules/schema-reload/schema-reload.routes.js'
import { startPeriodicCollection } from './modules/metrics/metrics.service.js'

export async function buildApp(): Promise<FastifyInstance> {
  const env = getEnv()

  const fastify = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
              },
            }
          : undefined,
    },
    disableRequestLogging: env.NODE_ENV === 'production',
  })

  // Register request-id middleware
  registerRequestId(fastify)

  // Register plugins
  await fastify.register(cors, {
    origin: true,
    credentials: true,
  })

  await fastify.register(helmet, {
    contentSecurityPolicy: false,
  })

  // Swagger documentation
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Tenant Manager API',
        description: 'Multi-tenant project management API for self-hosted Supabase',
        version: '0.1.0',
      },
      servers: [
        {
          url: `http://localhost:${env.PORT}`,
          description: 'Development server',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'Admin API key authentication',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  })

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  })

  // Set error handlers
  fastify.setErrorHandler(errorHandler)
  fastify.setNotFoundHandler(notFoundHandler)

  // Ensure _supabase management database exists before running migrations
  try {
    const sysPool = getSystemPool()
    const dbCheck = await sysPool.query(
      `SELECT 1 FROM pg_database WHERE datname = '_supabase'`
    )
    if (dbCheck.rowCount === 0) {
      await sysPool.query(`CREATE DATABASE _supabase`)
      fastify.log.info('Created _supabase management database')
    }
  } catch (error) {
    fastify.log.error(
      'Failed to ensure _supabase database exists: %s',
      error instanceof Error ? error.message : error
    )
    throw error
  }

  // Run database migrations (_supabase / Kysely)
  try {
    await migrateUp()
    fastify.log.info('Database migrations completed')
  } catch (error) {
    fastify.log.error(
      'Failed to run database migrations: %s',
      error instanceof Error ? error.message : error
    )
    throw error
  }

  // Ensure supabase_platform database exists
  const platformDbName = env.PLATFORM_DB_NAME || 'supabase_platform'
  try {
    const sysPool = getSystemPool()
    const platformDbCheck = await sysPool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [platformDbName]
    )
    if (platformDbCheck.rowCount === 0) {
      // CREATE DATABASE cannot use parameterized queries
      await sysPool.query(`CREATE DATABASE "${platformDbName}"`)
      fastify.log.info(`Created ${platformDbName} database`)
    }
  } catch (error) {
    fastify.log.error(
      'Failed to ensure %s database exists: %s',
      platformDbName,
      error instanceof Error ? error.message : error
    )
    throw error
  }

  // Run supabase_platform schema migration (idempotent, all IF NOT EXISTS)
  try {
    const platformPool = getPlatformPool()
    await platformPool.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS projects (
        id            TEXT PRIMARY KEY,
        function_name TEXT NOT NULL,
        function_url  TEXT NOT NULL,
        function_arn  TEXT,
        status        TEXT DEFAULT 'active',
        created_at    TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id    TEXT NOT NULL REFERENCES projects(id),
        name          TEXT NOT NULL,
        key_type      TEXT NOT NULL,
        role          TEXT NOT NULL,
        key_value     TEXT NOT NULL,
        hashed_secret TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT now(),
        UNIQUE (project_id, role)
      );

      CREATE TABLE IF NOT EXISTS jwt_keys (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id    TEXT NOT NULL REFERENCES projects(id),
        secret        TEXT NOT NULL,
        algorithm     TEXT DEFAULT 'HS256',
        status        TEXT DEFAULT 'current',
        created_at    TIMESTAMPTZ DEFAULT now(),
        rotated_at    TIMESTAMPTZ,
        UNIQUE (project_id, status)
      );

      CREATE TABLE IF NOT EXISTS postgrest_config (
        project_id         TEXT PRIMARY KEY REFERENCES projects(id),
        db_uri             TEXT NOT NULL,
        db_schemas         TEXT DEFAULT 'public',
        db_anon_role       TEXT DEFAULT 'anon',
        db_use_legacy_gucs TEXT DEFAULT 'false'
      );

      CREATE INDEX IF NOT EXISTS idx_api_keys_project_id ON api_keys(project_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_key_value ON api_keys(key_value);
      CREATE INDEX IF NOT EXISTS idx_jwt_keys_project_id ON jwt_keys(project_id);
      CREATE INDEX IF NOT EXISTS idx_jwt_keys_project_status ON jwt_keys(project_id, status);
    `)
    fastify.log.info('supabase_platform schema migration completed')
  } catch (error) {
    fastify.log.error(
      'Failed to run supabase_platform schema migration: %s',
      error instanceof Error ? error.message : error
    )
    throw error
  }

  // Ensure template database exists on all registered RDS instances
  try {
    const instances = await findRdsInstances({ status: 'active' })
    for (const instance of instances) {
      try {
        const conn = await resolveInstanceCredentials(instance)
        await ensureTemplateExistsOnInstance(conn)
        fastify.log.info(`Template ensured on instance ${instance.identifier}`)
      } catch (error) {
        fastify.log.warn(
          'Failed to ensure template on instance %s: %s',
          instance.identifier,
          error instanceof Error ? error.message : error
        )
      }
    }
  } catch (error) {
    fastify.log.warn(
      'Failed to enumerate instances for template initialization: %s',
      error instanceof Error ? error.message : error
    )
  }

  // Register routes
  await fastify.register(healthRoutes)
  await fastify.register(projectRoutes)
  await fastify.register(rdsInstanceRoutes)
  await fastify.register(apiKeyRoutes)
  await fastify.register(jwtKeyRoutes)
  await fastify.register(allocationStrategyRoutes)
  await fastify.register(metricsRoutes)
  await fastify.register(runtimeConfigRoutes)
  await fastify.register(schemaReloadRoutes)

  // Start periodic metrics collection
  startPeriodicCollection()

  return fastify
}
