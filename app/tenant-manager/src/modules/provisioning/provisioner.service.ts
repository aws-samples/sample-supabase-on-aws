/**
 * Database provisioning for multi-tenant self-hosted Supabase
 * Handles CREATE DATABASE, initialization, and DROP DATABASE operations
 * Supports per-instance connections for multi-RDS deployments
 */

import { getSystemPool, withTenantClient } from '../../db/connection.js'
import {
  getInstanceSystemPool,
  withInstanceTenantClient,
  type InstanceConnectionInfo,
} from '../../db/instance-connection.js'
import { getEnv } from '../../config/index.js'
import type { ServiceResult } from '../../types/index.js'

const TEMPLATE_DB_NAME = 'supabase_template'

/**
 * Create a new database for a project using template database
 * When conn is provided, creates on the specified RDS instance
 */
export async function createProjectDatabase(
  dbName: string,
  conn?: InstanceConnectionInfo
): Promise<ServiceResult> {
  // Validate database name (prevent SQL injection)
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName)) {
    return {
      success: false,
      error: 'Invalid database name. Must start with letter or underscore and contain only alphanumeric characters.',
    }
  }

  const pool = conn ? getInstanceSystemPool(conn) : getSystemPool()

  // Check if database already exists
  const checkResult = await pool.query(
    'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) as exists',
    [dbName]
  )

  if (checkResult.rows[0]?.exists) {
    return { success: false, error: `Database '${dbName}' already exists` }
  }

  // Try to create using template database
  try {
    await pool.query(`CREATE DATABASE "${dbName}" WITH TEMPLATE "${TEMPLATE_DB_NAME}" OWNER postgres`)
    return { success: true }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // If template doesn't exist or other template-related error, fall back to legacy creation
    if (msg.includes('template') || msg.includes('does not exist') || msg.includes('being accessed by other users')) {
      console.warn('Template database not available, falling back to traditional creation')
      return createProjectDatabaseLegacy(dbName, pool)
    }
    return { success: false, error: `Failed to create database: ${msg}` }
  }
}

/**
 * Create database using legacy method (without template)
 */
async function createProjectDatabaseLegacy(
  dbName: string,
  pool: import('pg').Pool
): Promise<ServiceResult> {
  try {
    await pool.query(
      `CREATE DATABASE "${dbName}" WITH OWNER postgres ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8'`
    )
    return { success: true }
  } catch (error) {
    return { success: false, error: `Failed to create database: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Initialize a project database with required roles, schemas, and extensions
 * Detects if database was created from template and skips unnecessary initialization
 * When conn is provided, operates on the specified RDS instance
 */
export async function initializeProjectDatabase(
  dbName: string,
  conn?: InstanceConnectionInfo
): Promise<ServiceResult> {
  const env = getEnv()
  // Use instance password for authenticator role (each RDS cluster has independent roles)
  const password = conn?.password ?? env.POSTGRES_PASSWORD
  const pool = conn ? getInstanceSystemPool(conn) : getSystemPool()

  // 1. Create roles (if they don't exist globally) - always needed
  // Roles are cluster-level, so must be created on the target instance
  const rolesQuery = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
        CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD '${password}';
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        CREATE ROLE supabase_auth_admin NOINHERIT BYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN
        CREATE ROLE supabase_storage_admin NOINHERIT;
      END IF;
    END
    $$;
    GRANT anon, authenticated, service_role TO authenticator;
    ALTER ROLE supabase_auth_admin BYPASSRLS;
    ALTER ROLE supabase_storage_admin BYPASSRLS;
  `

  try {
    await pool.query(rolesQuery)
  } catch (error) {
    console.error('Failed to create roles:', error instanceof Error ? error.message : error)
    // Roles might already exist, continue
  }

  // Check if database was created from template (auth schema exists)
  try {
    const schemaCheck = conn
      ? await withInstanceTenantClient(conn, dbName, async (client) => {
          const result = await client.query(
            "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'auth') as exists"
          )
          return result.rows[0]?.exists || false
        })
      : await withTenantClient(dbName, async (client) => {
          const result = await client.query(
            "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'auth') as exists"
          )
          return result.rows[0]?.exists || false
        })

    if (schemaCheck) {
      console.debug(`Database ${dbName} was created from template, skipping initialization`)
      return { success: true }
    }
  } catch (error) {
    console.warn(`Schema check failed for ${dbName}: ${error instanceof Error ? error.message : error}, assuming not from template`)
  }

  // Not from template, perform full initialization
  console.debug(`Database ${dbName} not created from template, performing full initialization`)
  return initializeProjectDatabaseFull(dbName, conn)
}

/**
 * Full database initialization for non-template databases
 */
async function initializeProjectDatabaseFull(
  dbName: string,
  conn?: InstanceConnectionInfo
): Promise<ServiceResult> {
  const doInit = async (client: import('pg').Client): Promise<void> => {
    // 1. Initialize schemas and extensions
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE SCHEMA IF NOT EXISTS realtime;
      CREATE SCHEMA IF NOT EXISTS graphql_public;

      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA realtime TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA graphql_public TO anon, authenticated, service_role;

      CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
      CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

      GRANT USAGE, CREATE ON SCHEMA auth TO supabase_auth_admin;
      GRANT ALL ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO supabase_auth_admin;
      GRANT ALL ON ALL ROUTINES IN SCHEMA auth TO supabase_auth_admin;
      ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON TABLES TO supabase_auth_admin;
      ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON SEQUENCES TO supabase_auth_admin;
      ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON ROUTINES TO supabase_auth_admin;

      GRANT USAGE, CREATE ON SCHEMA storage TO supabase_storage_admin;
      GRANT ALL ON ALL TABLES IN SCHEMA storage TO supabase_storage_admin;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO supabase_storage_admin;
      GRANT ALL ON ALL ROUTINES IN SCHEMA storage TO supabase_storage_admin;
      ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT ALL ON TABLES TO supabase_storage_admin;
      ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT ALL ON SEQUENCES TO supabase_storage_admin;
      ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT ALL ON ROUTINES TO supabase_storage_admin;
    `)

    // 2. Create auth helper functions
    await client.query(`
      CREATE OR REPLACE FUNCTION auth.uid()
      RETURNS uuid
      LANGUAGE sql
      STABLE
      AS $$
        SELECT NULLIF(
          COALESCE(
            current_setting('request.jwt.claim.sub', true),
            current_setting('request.jwt.claims', true)::json->>'sub'
          ),
          ''
        )::uuid
      $$;

      CREATE OR REPLACE FUNCTION auth.role()
      RETURNS text
      LANGUAGE sql
      STABLE
      AS $$
        SELECT COALESCE(
          current_setting('request.jwt.claim.role', true),
          current_setting('request.jwt.claims', true)::json->>'role'
        )
      $$;

      CREATE OR REPLACE FUNCTION auth.jwt()
      RETURNS json
      LANGUAGE sql
      STABLE
      AS $$
        SELECT
          COALESCE(
            nullif(current_setting('request.jwt.claims', true), ''),
            '{}'
          )::json
      $$;

      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated, service_role;
    `)

    // 3. Create storage tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS storage.buckets (
        id text PRIMARY KEY,
        name text NOT NULL UNIQUE,
        owner uuid,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        public boolean DEFAULT false,
        avif_autodetection boolean DEFAULT false,
        file_size_limit bigint,
        allowed_mime_types text[],
        owner_id text
      );

      CREATE TABLE IF NOT EXISTS storage.objects (
        id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
        bucket_id text REFERENCES storage.buckets(id),
        name text,
        owner uuid,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        last_accessed_at timestamptz DEFAULT now(),
        metadata jsonb,
        path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
        version text,
        owner_id text,
        user_metadata jsonb
      );

      CREATE INDEX IF NOT EXISTS idx_objects_bucket_id ON storage.objects(bucket_id);
      CREATE INDEX IF NOT EXISTS idx_objects_name ON storage.objects(name);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_objects_bucket_id_name ON storage.objects(bucket_id, name);

      GRANT SELECT, INSERT, UPDATE, DELETE ON storage.buckets TO service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO service_role;
      GRANT SELECT ON storage.buckets TO anon, authenticated;
      GRANT SELECT ON storage.objects TO anon, authenticated;
    `)

    // 3.5. Create optional extensions (may not be available on all platforms)
    for (const ext of ['pgjwt', 'dblink']) {
      try {
        const schemaClause = ' WITH SCHEMA extensions'
        await client.query(`CREATE EXTENSION IF NOT EXISTS "${ext}"${schemaClause}`)
      } catch {
        // Optional, skip if not available
      }
    }

    // 4. Create realtime publication
    try {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
            CREATE PUBLICATION supabase_realtime;
          END IF;
        END
        $$;
      `)
    } catch (error) {
      console.error('Failed to create realtime publication:', error instanceof Error ? error.message : error)
    }

    // 5. Set default privileges
    try {
      await client.query(`
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      `)
    } catch (error) {
      console.error('Failed to set default privileges:', error instanceof Error ? error.message : error)
    }
  }

  try {
    if (conn) {
      await withInstanceTenantClient(conn, dbName, doInit)
    } else {
      await withTenantClient(dbName, doInit)
    }
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: `Failed to initialize database: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Delete a project database
 * When conn is provided, deletes from the specified RDS instance
 */
export async function deleteProjectDatabase(
  dbName: string,
  conn?: InstanceConnectionInfo
): Promise<ServiceResult> {
  // Prevent deleting system databases
  const protectedDatabases = ['postgres', '_supabase', 'template0', 'template1']
  if (protectedDatabases.includes(dbName)) {
    return { success: false, error: `Cannot delete protected database: ${dbName}` }
  }

  // Validate database name
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName)) {
    return { success: false, error: 'Invalid database name' }
  }

  const pool = conn ? getInstanceSystemPool(conn) : getSystemPool()

  // First, terminate all connections to the database
  try {
    await pool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [dbName]
    )
  } catch (error) {
    console.warn('Warning: Failed to terminate connections:', error instanceof Error ? error.message : error)
  }

  // Wait a moment for connections to close
  await new Promise((resolve) => setTimeout(resolve, 500))

  // Drop the database
  try {
    await pool.query(`DROP DATABASE IF EXISTS "${dbName}"`)
    return { success: true }
  } catch (error) {
    return { success: false, error: `Failed to drop database: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Check if a database exists
 */
export async function databaseExists(dbName: string): Promise<boolean> {
  const pool = getSystemPool()
  try {
    const result = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) as exists',
      [dbName]
    )
    return result.rows[0]?.exists || false
  } catch (error) {
    console.error('Failed to check database existence:', error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Get database size in bytes
 */
export async function getDatabaseSize(dbName: string): Promise<number | null> {
  const pool = getSystemPool()
  try {
    const result = await pool.query(
      'SELECT pg_database_size($1)::text as size',
      [dbName]
    )
    return parseInt(result.rows[0]?.size || '0', 10)
  } catch (error) {
    console.error('Failed to get database size:', error instanceof Error ? error.message : error)
    return null
  }
}
