import {
  StorageBackend,
  FunctionFile,
  FunctionMetadata,
  StorageHealthStatus,
  StorageBackendError,
  StorageNotFoundError,
} from './StorageBackend'

/**
 * Database Storage Backend for Edge Functions Metadata
 * 
 * Stores function metadata in PostgreSQL for better performance and query capabilities.
 * Function code files are still stored in the file system or S3.
 */
export class DatabaseStorage implements StorageBackend {
  private readonly connectionString: string
  private codeStorage: StorageBackend | null = null
  private initialized = false
  private static pool: any = null // Singleton connection pool

  constructor(connectionString?: string, codeStorage?: StorageBackend) {
    this.connectionString = connectionString || process.env.DATABASE_URL || ''
    
    // Code storage backend (file system or S3)
    if (codeStorage) {
      this.codeStorage = codeStorage
    }
  }

  /**
   * Initialize database schema
   */
  private async ensureSchema(): Promise<void> {
    if (this.initialized) return
    
    try {
      const pool = await this.getPool()
      const client = await pool.connect()
      
      try {
        await client.query(`
          CREATE SCHEMA IF NOT EXISTS _studio;
          
          CREATE TABLE IF NOT EXISTS _studio.edge_functions_metadata (
            id SERIAL PRIMARY KEY,
            project_ref TEXT NOT NULL,
            slug TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            version TEXT NOT NULL DEFAULT '1.0.0',
            runtime TEXT NOT NULL DEFAULT 'deno',
            entrypoint TEXT NOT NULL DEFAULT 'index.ts',
            user_id TEXT,
            deployment_source TEXT DEFAULT 'api',
            metadata_loaded BOOLEAN NOT NULL DEFAULT false,
            metadata_error TEXT,
            extra_metadata JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(project_ref, slug)
          );
          
          -- Add metadata_loaded column if missing (for existing tables)
          ALTER TABLE _studio.edge_functions_metadata 
            ADD COLUMN IF NOT EXISTS metadata_loaded BOOLEAN NOT NULL DEFAULT false;
          ALTER TABLE _studio.edge_functions_metadata 
            ADD COLUMN IF NOT EXISTS metadata_error TEXT;

          -- Mark all pre-existing records as loaded (they were deployed before this fix)
          UPDATE _studio.edge_functions_metadata 
            SET metadata_loaded = true 
            WHERE metadata_loaded = false 
              AND metadata_error IS NULL 
              AND created_at < NOW() - INTERVAL '1 minute';
          
          CREATE INDEX IF NOT EXISTS idx_edge_functions_project_ref 
            ON _studio.edge_functions_metadata(project_ref);
          CREATE INDEX IF NOT EXISTS idx_edge_functions_slug 
            ON _studio.edge_functions_metadata(slug);
          CREATE INDEX IF NOT EXISTS idx_edge_functions_created_at 
            ON _studio.edge_functions_metadata(created_at DESC);
          
          CREATE OR REPLACE FUNCTION _studio.update_edge_functions_updated_at()
          RETURNS TRIGGER AS $$
          BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
          
          DROP TRIGGER IF EXISTS update_edge_functions_updated_at 
            ON _studio.edge_functions_metadata;
          CREATE TRIGGER update_edge_functions_updated_at
            BEFORE UPDATE ON _studio.edge_functions_metadata
            FOR EACH ROW
            EXECUTE FUNCTION _studio.update_edge_functions_updated_at();
        `)
        
        this.initialized = true
        console.log('[DatabaseStorage] Schema initialized successfully')
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('[DatabaseStorage] Failed to initialize schema:', error)
      throw error
    }
  }

  /**
   * Get the storage backend type
   */
  getType(): string {
    return 'database'
  }

  /**
   * Initialize code storage backend
   */
  private async getCodeStorage(): Promise<StorageBackend> {
    if (!this.codeStorage) {
      // Lazy load to avoid circular dependency
      const { LocalFileSystemStorage } = await import('./LocalFileSystemStorage')
      this.codeStorage = new LocalFileSystemStorage()
    }
    return this.codeStorage
  }

  /**
   * Get singleton connection pool
   * 
   * Pool size considerations:
   * - max: Maximum concurrent connections (not total functions)
   * - For high concurrency (thousands of requests/sec), increase to 50-100
   * - PostgreSQL default max_connections is 100, adjust accordingly
   */
  private async getPool() {
    if (!DatabaseStorage.pool) {
      const { Pool } = await import('pg')
      const maxConnections = parseInt(process.env.DB_POOL_MAX || '50')
      const minConnections = parseInt(process.env.DB_POOL_MIN || '5')
      
      DatabaseStorage.pool = new Pool({
        connectionString: this.connectionString,
        ssl: {
          rejectUnauthorized: true,
          ca: require('fs').readFileSync(process.env.RDS_CA_CERT_PATH || '/etc/ssl/certs/rds-global-bundle.pem', 'utf-8'),
        },
        max: maxConnections,
        min: minConnections,
        idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000'),
        connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT || '5000'),
      })
      console.log(`[DatabaseStorage] Connection pool created (max: ${maxConnections}, min: ${minConnections})`)
    }
    return DatabaseStorage.pool
  }

  /**
   * Get database client from pool
   */
  private async getClient() {
    const pool = await this.getPool()
    return pool.connect()
  }

  /**
   * Perform health check on the storage backend
   */
  async healthCheck(): Promise<StorageHealthStatus> {
    const client = await this.getClient()
    try {
      // Check database connection
      await client.query('SELECT 1')
      
      // Check if metadata table exists
      const tableCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = '_studio' 
          AND table_name = 'edge_functions_metadata'
        )
      `)

      const tableExists = tableCheck.rows[0]?.exists === true

      return {
        healthy: tableExists,
        details: {
          type: 'database',
          tableExists,
          connectionString: this.connectionString.replace(/:[^:@]+@/, ':****@'), // Hide password
        },
      }
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        details: {
          type: 'database',
        },
      }
    } finally {
      client.release()
    }
  }

  /**
   * List all functions in a project
   */
  async list(projectRef: string): Promise<FunctionMetadata[]> {
    await this.ensureSchema()
    const client = await this.getClient()
    try {
      const result = await client.query(
        'SELECT * FROM _studio.edge_functions_metadata WHERE project_ref = $1 AND metadata_loaded = true ORDER BY created_at DESC',
        [projectRef]
      )
      
      return result.rows.map(row => ({
        slug: row.slug,
        name: row.name,
        description: row.description || '',
        version: row.version,
        runtime: row.runtime,
        entrypoint: row.entrypoint,
        projectRef: row.project_ref,
        userId: row.user_id || 'unknown',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...row.extra_metadata,
      }))
    } catch (error) {
      throw new StorageBackendError(
        `Failed to list functions: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'LIST_ERROR',
        { projectRef }
      )
    } finally {
      client.release()
    }
  }

  /**
   * Check if a function exists
   */
  async exists(projectRef: string, functionSlug: string): Promise<boolean> {
    const client = await this.getClient()
    try {
      const result = await client.query(
        'SELECT EXISTS(SELECT 1 FROM _studio.edge_functions_metadata WHERE project_ref = $1 AND slug = $2 AND metadata_loaded = true)',
        [projectRef, functionSlug]
      )
      return result.rows[0]?.exists === true
    } catch (error) {
      return false
    } finally {
      client.release()
    }
  }

  /**
   * Get function metadata
   */
  async getMetadata(projectRef: string, functionSlug: string): Promise<FunctionMetadata | null> {
    await this.ensureSchema()
    const client = await this.getClient()
    try {
      const result = await client.query(
        `SELECT * FROM _studio.edge_functions_metadata 
         WHERE project_ref = $1 AND slug = $2 AND metadata_loaded = true`,
        [projectRef, functionSlug]
      )

      if (result.rows.length === 0) {
        return null
      }

      const row = result.rows[0]
      
      return {
        slug: row.slug,
        name: row.name,
        description: row.description || '',
        version: row.version,
        runtime: row.runtime,
        entrypoint: row.entrypoint,
        projectRef: row.project_ref,
        userId: row.user_id || 'unknown',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...row.extra_metadata,
      }
    } catch (error) {
      throw new StorageBackendError(
        `Failed to get metadata: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'METADATA_ERROR',
        { projectRef, functionSlug }
      )
    } finally {
      client.release()
    }
  }

  /**
   * Store function files and metadata
   * 
   * Uses a two-phase approach to prevent orphan metadata records:
   * 1. INSERT metadata with metadata_loaded = false (marks as "not ready")
   * 2. Write files to code storage (EFS/S3)
   * 3. UPDATE metadata_loaded = true (marks as "ready")
   * If file write fails, the metadata record is cleaned up.
   */
  async store(
    projectRef: string,
    functionSlug: string,
    files: FunctionFile[],
    metadata: FunctionMetadata
  ): Promise<void> {
    await this.ensureSchema()
    const client = await this.getClient()
    try {
      // Phase 1: Insert metadata with metadata_loaded = false
      await client.query(
        `INSERT INTO _studio.edge_functions_metadata 
         (project_ref, slug, name, description, version, runtime, entrypoint, user_id, deployment_source, extra_metadata, metadata_loaded, metadata_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, NULL)
         ON CONFLICT (project_ref, slug) 
         DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           version = EXCLUDED.version,
           runtime = EXCLUDED.runtime,
           entrypoint = EXCLUDED.entrypoint,
           user_id = EXCLUDED.user_id,
           deployment_source = EXCLUDED.deployment_source,
           extra_metadata = EXCLUDED.extra_metadata,
           metadata_loaded = false,
           metadata_error = NULL,
           updated_at = NOW()`,
        [
          projectRef,
          functionSlug,
          metadata.name,
          metadata.description || null,
          metadata.version,
          metadata.runtime,
          metadata.entrypoint,
          metadata.userId || null,
          'api',
          JSON.stringify({}),
        ]
      )

      // Phase 2: Write files to code storage (with retry)
      try {
        const codeStorage = await this.getCodeStorage()
        let lastFileError: Error | null = null

        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await codeStorage.store(projectRef, functionSlug, files, metadata)
            lastFileError = null
            break
          } catch (err) {
            lastFileError = err instanceof Error ? err : new Error(String(err))
            if (attempt < 2) {
              console.warn(`[DatabaseStorage] File write attempt ${attempt} failed for '${functionSlug}', retrying in 1s...`)
              await new Promise(resolve => setTimeout(resolve, 1000))
            }
          }
        }

        if (lastFileError) {
          throw lastFileError
        }
      } catch (fileError) {
        // File write failed — mark the metadata record with error and clean up
        const errorMsg = fileError instanceof Error ? fileError.message : 'Unknown file storage error'
        console.error(`[DatabaseStorage] File write failed for '${functionSlug}', cleaning up metadata:`, errorMsg)

        try {
          await client.query(
            `UPDATE _studio.edge_functions_metadata 
             SET metadata_loaded = false, metadata_error = $3, updated_at = NOW()
             WHERE project_ref = $1 AND slug = $2`,
            [projectRef, functionSlug, errorMsg]
          )
        } catch (cleanupError) {
          console.error(`[DatabaseStorage] Failed to update metadata_error for '${functionSlug}':`, cleanupError)
        }

        throw fileError
      }

      // Phase 3: File write succeeded — mark metadata as ready
      await client.query(
        `UPDATE _studio.edge_functions_metadata 
         SET metadata_loaded = true, metadata_error = NULL, updated_at = NOW()
         WHERE project_ref = $1 AND slug = $2`,
        [projectRef, functionSlug]
      )

      console.log(`[DatabaseStorage] Successfully stored function '${functionSlug}' (metadata + files)`)
    } catch (error) {
      throw new StorageBackendError(
        `Failed to store function: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'STORE_ERROR',
        { projectRef, functionSlug }
      )
    } finally {
      client.release()
    }
  }

  /**
   * Retrieve function files
   */
  async retrieve(projectRef: string, functionSlug: string): Promise<FunctionFile[]> {
    const codeStorage = await this.getCodeStorage()
    return codeStorage.retrieve(projectRef, functionSlug)
  }

  /**
   * Delete a function and all its files
   */
  async delete(projectRef: string, functionSlug: string): Promise<void> {
    const client = await this.getClient()
    try {
      console.log(`[DatabaseStorage] Deleting function '${functionSlug}' from project '${projectRef}'`)
      
      // Delete metadata from database
      const result = await client.query(
        'DELETE FROM _studio.edge_functions_metadata WHERE project_ref = $1 AND slug = $2',
        [projectRef, functionSlug]
      )
      
      console.log(`[DatabaseStorage] Deleted ${result.rowCount} metadata record(s) from database for function '${functionSlug}'`)
      
      // Delete files from code storage
      const codeStorage = await this.getCodeStorage()
      await codeStorage.delete(projectRef, functionSlug)
      
      console.log(`[DatabaseStorage] Successfully deleted function '${functionSlug}' from project '${projectRef}'`)
    } catch (error) {
      console.error(`[DatabaseStorage] Failed to delete function '${functionSlug}':`, error)
      throw new StorageBackendError(
        `Failed to delete function: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'DELETE_ERROR',
        { projectRef, functionSlug }
      )
    } finally {
      client.release()
    }
  }
}
