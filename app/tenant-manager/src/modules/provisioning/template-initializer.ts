/**
 * Template database initializer for multi-tenant Supabase
 * Ensures the supabase_template database exists for fast project creation
 * Supports both default host (legacy) and per-instance template creation
 */

import pg from 'pg'
import { getSystemPool, withTenantClient } from '../../db/connection.js'
import {
  getInstanceSystemPool,
  withInstanceTenantClient,
  type InstanceConnectionInfo,
} from '../../db/instance-connection.js'
import { AUTH_SCHEMA_DDL } from './auth-schema.js'

const TEMPLATE_DB_NAME = 'supabase_template'

/**
 * Check if the template database exists
 * Accepts an optional pool to check on a specific instance
 */
export async function templateExists(pool?: pg.Pool): Promise<boolean> {
  const p = pool ?? getSystemPool()
  try {
    const result = await p.query(
      'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) as exists',
      [TEMPLATE_DB_NAME]
    )
    return result.rows[0]?.exists || false
  } catch (error) {
    console.error('Failed to check template existence:', error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Ensure the template database exists on the default host (legacy)
 * Kept for backward compatibility but no longer called from app.ts
 */
export async function ensureTemplateExists(): Promise<void> {
  const exists = await templateExists()

  if (exists) {
    console.debug('Template database already exists')
    return
  }

  console.debug('Creating template database...')
  const pool = getSystemPool()

  // Create the template database
  try {
    await pool.query(`
      CREATE DATABASE "${TEMPLATE_DB_NAME}"
      WITH OWNER postgres
           ENCODING 'UTF8'
           LC_COLLATE 'en_US.UTF-8'
           LC_CTYPE 'en_US.UTF-8'
           TEMPLATE template0
    `)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('Failed to create template database:', msg)
    throw new Error(`Failed to create template database: ${msg}`)
  }

  // Ensure admin roles have BYPASSRLS (cluster-level, must run via system pool)
  try {
    await pool.query(`
      ALTER ROLE supabase_auth_admin BYPASSRLS;
      ALTER ROLE supabase_storage_admin BYPASSRLS;
    `)
  } catch (error) {
    console.debug('  Note: Could not set BYPASSRLS on admin roles:', error instanceof Error ? error.message : error)
  }

  // Initialize template contents
  await withTenantClient(TEMPLATE_DB_NAME, initializeTemplateWithClient)

  // Mark as template database
  try {
    await pool.query('UPDATE pg_database SET datistemplate = true WHERE datname = $1', [TEMPLATE_DB_NAME])
  } catch (error) {
    console.error('Failed to mark database as template:', error instanceof Error ? error.message : error)
  }

  console.debug('Template database created successfully')
}

/**
 * Ensure the template database exists on a specific RDS instance
 * Used during startup (for all registered instances) and when registering new instances
 */
export async function ensureTemplateExistsOnInstance(conn: InstanceConnectionInfo): Promise<void> {
  const pool = getInstanceSystemPool(conn)

  const exists = await templateExists(pool)
  if (exists) {
    console.debug(`Template database already exists on instance ${conn.instanceId}`)
    return
  }

  console.debug(`Creating template database on instance ${conn.instanceId} (${conn.host}:${conn.port})...`)

  // Ensure required cluster-level roles exist on this instance
  // Roles are per-cluster, so a fresh RDS instance won't have them
  console.debug('  Ensuring required roles exist...')
  try {
    await pool.query(`
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
          CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD '${conn.password}';
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
          CREATE ROLE supabase_auth_admin NOINHERIT BYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN
          CREATE ROLE supabase_storage_admin NOINHERIT;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_admin') THEN
          CREATE ROLE supabase_admin BYPASSRLS LOGIN PASSWORD '${conn.password}';
        END IF;
      END
      $$;
      GRANT anon, authenticated, service_role TO authenticator;
    `)
  } catch (error) {
    console.debug('  Note: Role creation had issues:', error instanceof Error ? error.message : error)
  }

  // Create the template database on the instance
  try {
    await pool.query(`
      CREATE DATABASE "${TEMPLATE_DB_NAME}"
      WITH OWNER postgres
           ENCODING 'UTF8'
           LC_COLLATE 'en_US.UTF-8'
           LC_CTYPE 'en_US.UTF-8'
           TEMPLATE template0
    `)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`Failed to create template database on instance ${conn.instanceId}:`, msg)
    throw new Error(`Failed to create template database on instance ${conn.instanceId}: ${msg}`)
  }

  // Ensure admin roles have BYPASSRLS
  try {
    await pool.query(`
      ALTER ROLE supabase_auth_admin BYPASSRLS;
      ALTER ROLE supabase_storage_admin BYPASSRLS;
    `)
  } catch (error) {
    console.debug('  Note: Could not set BYPASSRLS on admin roles:', error instanceof Error ? error.message : error)
  }

  // Initialize template contents on the instance
  await withInstanceTenantClient(conn, TEMPLATE_DB_NAME, initializeTemplateWithClient)

  // Mark as template database
  try {
    await pool.query('UPDATE pg_database SET datistemplate = true WHERE datname = $1', [TEMPLATE_DB_NAME])
  } catch (error) {
    console.error('Failed to mark database as template:', error instanceof Error ? error.message : error)
  }

  console.debug(`Template database created successfully on instance ${conn.instanceId}`)
}

/**
 * Core template initialization logic — accepts a pg.Client connected to the template database
 * Shared between default-host and per-instance initialization paths
 */
async function initializeTemplateWithClient(client: pg.Client): Promise<void> {
    // Step 1: Create schemas
    console.debug('  Creating schemas...')
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE SCHEMA IF NOT EXISTS realtime;
      CREATE SCHEMA IF NOT EXISTS _realtime;
      CREATE SCHEMA IF NOT EXISTS graphql_public;
      CREATE SCHEMA IF NOT EXISTS supabase_functions;
    `)

    // Step 2: Grant schema usage permissions
    console.debug('  Granting schema permissions...')
    await client.query(`
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA realtime TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA _realtime TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA graphql_public TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA supabase_functions TO postgres, anon, authenticated, service_role;

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

    // Step 3: Create core extensions
    console.debug('  Creating extensions...')
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
      CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
    `)

    // Step 3.1: Create optional extensions (may not be available on all platforms, e.g. AWS RDS)
    console.debug('  Creating optional extensions...')
    const optionalExtensions = ['pgjwt', 'dblink', 'pg_stat_statements', 'pg_graphql', 'pg_net', 'supabase_vault']
    for (const ext of optionalExtensions) {
      const schemaClause = ext === 'pg_net' ? ' WITH SCHEMA extensions' : ''
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS "${ext}"${schemaClause}`)
      } catch (error) {
        console.debug(`    Note: Extension ${ext} not available: ${error instanceof Error ? error.message : error}`)
      }
    }

    // Step 4: Create auth helper functions
    console.debug('  Creating auth functions...')
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

    // Step 5: Create storage tables
    console.debug('  Creating storage tables...')
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

    // Step 5.1: Create supabase_functions tables
    console.debug('  Creating supabase_functions tables...')
    try {
      await client.query(`
        ALTER DEFAULT PRIVILEGES IN SCHEMA supabase_functions GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA supabase_functions GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA supabase_functions GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;

        CREATE TABLE IF NOT EXISTS supabase_functions.migrations (
          version text PRIMARY KEY,
          inserted_at timestamptz NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS supabase_functions.hooks (
          id bigserial PRIMARY KEY,
          hook_table_id integer NOT NULL,
          hook_name text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT NOW(),
          request_id bigint
        );

        CREATE INDEX IF NOT EXISTS supabase_functions_hooks_request_id_idx ON supabase_functions.hooks USING btree (request_id);
        CREATE INDEX IF NOT EXISTS supabase_functions_hooks_h_table_id_h_name_idx ON supabase_functions.hooks USING btree (hook_table_id, hook_name);

        GRANT SELECT, INSERT, UPDATE, DELETE ON supabase_functions.migrations TO postgres, anon, authenticated, service_role;
        GRANT SELECT, INSERT, UPDATE, DELETE ON supabase_functions.hooks TO postgres, anon, authenticated, service_role;
        GRANT USAGE ON SEQUENCE supabase_functions.hooks_id_seq TO postgres, anon, authenticated, service_role;
      `)
    } catch (error) {
      console.warn('Warning: Failed to create supabase_functions tables:', error instanceof Error ? error.message : error)
    }

    // Step 6: Create realtime publication
    console.debug('  Creating realtime publication...')
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
      console.warn('Warning: Failed to create realtime publication:', error instanceof Error ? error.message : error)
    }

    // Step 7: Set default privileges
    console.debug('  Setting default privileges...')
    try {
      await client.query(`
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE ON SEQUENCES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      `)
    } catch (error) {
      console.warn('Warning: Failed to set default privileges:', error instanceof Error ? error.message : error)
    }

    // Step 8: Create auth tables (from GoTrue migrations)
    console.debug('  Creating auth tables...')
    await createAuthTables(client)
}

/**
 * Create auth tables from consolidated GoTrue migrations
 */
async function createAuthTables(client: import('pg').Client): Promise<void> {
  const ddlChunks = splitAuthDDL(AUTH_SCHEMA_DDL)

  for (let i = 0; i < ddlChunks.length; i++) {
    const chunk = ddlChunks[i]
    if (!chunk || !chunk.trim()) continue

    try {
      await client.query(chunk)
    } catch (error) {
      console.debug(`    Note: Auth DDL chunk ${i + 1}/${ddlChunks.length} had issue: ${error instanceof Error ? error.message : error}`)
    }
  }

  console.debug('    Auth tables created successfully')
}

/**
 * Split the auth DDL into executable chunks
 */
function splitAuthDDL(ddl: string): string[] {
  const sections = ddl.split(/-- ={40,}/)
  const chunks: string[] = []

  for (const section of sections) {
    const trimmed = section.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('--') && !trimmed.includes('CREATE') && !trimmed.includes('ALTER')) {
      continue
    }

    if (trimmed.length > 10000) {
      const statements = splitStatements(trimmed)
      chunks.push(...statements)
    } else {
      chunks.push(trimmed)
    }
  }

  return chunks
}

/**
 * Split SQL text into individual statements
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inDollarQuote = false
  let dollarTag = ''

  const lines = sql.split('\n')

  for (const line of lines) {
    const dollarMatch = line.match(/\$([a-zA-Z_]*)\$/)
    if (dollarMatch) {
      const tag = dollarMatch[0]
      if (!inDollarQuote) {
        inDollarQuote = true
        dollarTag = tag
      } else if (tag === dollarTag) {
        inDollarQuote = false
        dollarTag = ''
      }
    }

    current += line + '\n'

    if (!inDollarQuote && line.trim().endsWith(';')) {
      const trimmed = current.trim()
      if (trimmed) {
        statements.push(trimmed)
      }
      current = ''
    }
  }

  if (current.trim()) {
    statements.push(current.trim())
  }

  return statements
}
