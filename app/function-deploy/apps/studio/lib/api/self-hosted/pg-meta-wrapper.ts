/**
 * pg-meta Library Wrapper for Multi-Database Support
 * 
 * Wraps the @supabase/pg-meta library to support dynamic database switching
 * based on project ref or explicit database name.
 */

import pgMeta from '@supabase/pg-meta'
import type { Pool } from 'pg'
import { getPool } from './pg-meta-pool-manager'
import { getDatabaseNameForProject } from './project-database'
import { POSTGRES_DATABASE } from './constants'

export interface PgMetaOptions {
  projectRef?: string
  databaseName?: string
  readOnly?: boolean
}

/**
 * Get pg-meta connection pool for the specified options
 */
async function getPgMetaPool(options: PgMetaOptions): Promise<Pool> {
  let databaseName = options.databaseName
  
  // If projectRef is provided, get the corresponding database name
  if (!databaseName && options.projectRef) {
    databaseName = await getDatabaseNameForProject(options.projectRef)
  }
  
  // Use default database if not specified
  if (!databaseName) {
    databaseName = POSTGRES_DATABASE
  }
  
  console.log(`[pg-meta] Using database: ${databaseName}`)
  
  return getPool({
    databaseName,
    readOnly: options.readOnly || false,
  })
}

/**
 * Execute SQL query and parse with Zod schema
 */
async function executeAndParse<T>(
  pool: Pool,
  sqlQuery: { sql: string; zod: any }
): Promise<T> {
  try {
    console.log(`[pg-meta] Executing SQL: ${sqlQuery.sql.substring(0, 200)}...`)
    const result = await pool.query(sqlQuery.sql)
    console.log(`[pg-meta] Query returned ${result.rows.length} rows`)
    return sqlQuery.zod.parse(result.rows)
  } catch (error: any) {
    console.error(`[pg-meta] Query error:`, error.message)
    throw error
  }
}

/**
 * Tables operations
 */
export const tables = {
  async list(params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.tables.list(params)
    return executeAndParse(pool, query)
  },
  
  async retrieve(identifier: any, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.tables.retrieve(identifier)
    const result = await executeAndParse(pool, query)
    return result
  },
  
  async create(table: any, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.tables.create(table)
    await pool.query(query.sql)
    return { success: true }
  },
  
  async update(identifier: any, updates: any, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.tables.update(identifier, updates)
    await pool.query(query.sql)
    return { success: true }
  },
  
  async remove(identifier: any, params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.tables.remove(identifier, params)
    await pool.query(query.sql)
    return { success: true }
  },
}

/**
 * Columns operations
 */
export const columns = {
  async list(params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.columns.list(params)
    return executeAndParse(pool, query)
  },
  
  async retrieve(identifier: any, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.columns.retrieve(identifier)
    return executeAndParse(pool, query)
  },
  
  async create(column: any, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.columns.create(column)
    await pool.query(query.sql)
    return { success: true }
  },
  
  async update(old: any, updates: any, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.columns.update(old, updates)
    await pool.query(query.sql)
    return { success: true }
  },
  
  async remove(column: any, params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.columns.remove(column, params)
    await pool.query(query.sql)
    return { success: true }
  },
}

/**
 * Query operations
 */
export const queryOps = {
  async execute(sql: string, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const result = await pool.query(sql)
    return result.rows
  },
}

/**
 * Schemas operations
 */
export const schemas = {
  async list(params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.schemas.list(params)
    return executeAndParse(pool, query)
  },
}

/**
 * Views operations
 */
export const views = {
  async list(params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.views.list(params)
    return executeAndParse(pool, query)
  },
}

/**
 * Functions operations
 */
export const functions = {
  async list(params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.functions.list(params)
    return executeAndParse(pool, query)
  },
}

/**
 * Extensions operations
 */
export const extensions = {
  async list(params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.extensions.list(params)
    return executeAndParse(pool, query)
  },
}

/**
 * Policies operations
 */
export const policies = {
  async list(params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.policies.list(params)
    return executeAndParse(pool, query)
  },
}

/**
 * Triggers operations
 */
export const triggers = {
  async list(params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.triggers.list(params)
    return executeAndParse(pool, query)
  },
}

/**
 * Types operations
 */
export const types = {
  async list(params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.types.list(params)
    return executeAndParse(pool, query)
  },
}

/**
 * Roles operations
 */
export const roles = {
  async list(params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.roles.list(params)
    return executeAndParse(pool, query)
  },
}

/**
 * Publications operations
 */
export const publications = {
  async list(params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.publications.list(params)
    return executeAndParse(pool, query)
  },
}

/**
 * Config operations
 */
export const config = {
  async list(params: any = {}, options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.config.list(params)
    return executeAndParse(pool, query)
  },
}

/**
 * Version operations
 */
export const version = {
  async retrieve(options: PgMetaOptions = {}) {
    const pool = await getPgMetaPool(options)
    const query = pgMeta.version.retrieve()
    return executeAndParse(pool, query)
  },
}

/**
 * Export all pg-meta functionality
 */
export default {
  tables,
  columns,
  query: queryOps,
  schemas,
  views,
  functions,
  extensions,
  policies,
  triggers,
  types,
  roles,
  publications,
  config,
  version,
}
