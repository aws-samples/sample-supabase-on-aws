import { PG_META_URL } from 'lib/constants/index'
import { constructHeaders } from '../apiHelpers'
import { PgMetaDatabaseError, databaseErrorSchema, WrappedResult } from './types'
import { assertSelfHosted, encryptString, getConnectionString } from './util'

/**
 * Splits a SQL query string into individual statements, respecting PostgreSQL quoting rules.
 * Handles:
 * - Dollar-quoted strings ($$, $tag$, etc.)
 * - Single-quoted strings
 * - Double-quoted identifiers
 * - Line comments (--)
 * - Block comments (/* *\/)
 */
function splitSQLStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0
  
  while (i < sql.length) {
    const char = sql[i]
    const nextChar = sql[i + 1]
    
    // Handle dollar-quoted strings ($$...$$ or $tag$...$tag$)
    if (char === '$') {
      const dollarMatch = sql.substring(i).match(/^(\$[a-zA-Z0-9_]*\$)/)
      if (dollarMatch) {
        const dollarTag = dollarMatch[1]
        const endIndex = sql.indexOf(dollarTag, i + dollarTag.length)
        if (endIndex !== -1) {
          // Include the entire dollar-quoted string
          current += sql.substring(i, endIndex + dollarTag.length)
          i = endIndex + dollarTag.length
          continue
        }
      }
    }
    
    // Handle single-quoted strings
    if (char === "'") {
      current += char
      i++
      while (i < sql.length) {
        current += sql[i]
        if (sql[i] === "'") {
          // Check for escaped quote ('')
          if (sql[i + 1] === "'") {
            current += sql[i + 1]
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    
    // Handle double-quoted identifiers
    if (char === '"') {
      current += char
      i++
      while (i < sql.length) {
        current += sql[i]
        if (sql[i] === '"') {
          // Check for escaped quote ("")
          if (sql[i + 1] === '"') {
            current += sql[i + 1]
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    
    // Handle line comments (--)
    if (char === '-' && nextChar === '-') {
      current += char + nextChar
      i += 2
      while (i < sql.length && sql[i] !== '\n') {
        current += sql[i]
        i++
      }
      if (i < sql.length) {
        current += sql[i] // Include the newline
        i++
      }
      continue
    }
    
    // Handle block comments (/* */)
    if (char === '/' && nextChar === '*') {
      current += char + nextChar
      i += 2
      while (i < sql.length - 1) {
        current += sql[i]
        if (sql[i] === '*' && sql[i + 1] === '/') {
          current += sql[i + 1]
          i += 2
          break
        }
        i++
      }
      continue
    }
    
    // Handle statement terminator (semicolon)
    if (char === ';') {
      current += char
      const trimmed = current.trim()
      if (trimmed) {
        statements.push(trimmed)
      }
      current = ''
      i++
      continue
    }
    
    // Regular character
    current += char
    i++
  }
  
  // Add any remaining statement
  const trimmed = current.trim()
  if (trimmed) {
    statements.push(trimmed)
  }
  
  return statements
}

export type QueryOptions = {
  query: string
  parameters?: unknown[]
  readOnly?: boolean
  headers?: HeadersInit
  databaseName?: string
  projectRef?: string
}

/**
 * Executes a SQL query against the self-hosted Postgres instance via pg-meta service.
 *
 * _Only call this from server-side self-hosted code._
 */
export async function executeQuery<T = unknown>({
  query,
  parameters,
  readOnly = false,
  headers,
  databaseName,
  projectRef,
}: QueryOptions): Promise<WrappedResult<T[]>> {
  assertSelfHosted()

  // If projectRef is provided, get the corresponding database name
  if (projectRef && !databaseName) {
    const { getDatabaseNameForProject } = await import('./project-database')
    databaseName = await getDatabaseNameForProject(projectRef)
    console.log(`[executeQuery] Resolved projectRef ${projectRef} to database: ${databaseName}`)
  }

  console.log('Database:', databaseName || 'default')

  // Execute query directly using connection pool, not through pg-meta service
  // Because pg-meta service does not support dynamic database switching
  try {
    const { getPool } = await import('./pg-meta-pool-manager')
    const { POSTGRES_DATABASE } = await import('./constants')
    const dbName = databaseName || POSTGRES_DATABASE
    const pool = await getPool({ databaseName: dbName, readOnly })
    
    console.log(`[executeQuery] Executing query on database: ${dbName}`)
    console.log(`[executeQuery] Query (first 500 chars):`, query.substring(0, 500))
    
    // Split multi-statement queries and execute them sequentially
    // This is needed because pg library doesn't support multiple statements in a single query() call
    const statements = splitSQLStatements(query)
    
    let result
    if (statements.length > 1) {
      console.log(`[executeQuery] Detected ${statements.length} statements, executing sequentially`)
      // Execute all but the last statement
      for (let i = 0; i < statements.length - 1; i++) {
        const stmt = statements[i].trim()
        console.log(`[executeQuery] Executing statement ${i + 1}/${statements.length}:`, stmt.substring(0, 100))
        await pool.query(stmt, i === 0 ? parameters : undefined)
      }
      // Execute the last statement and capture its result
      const lastStmt = statements[statements.length - 1].trim()
      console.log(`[executeQuery] Executing final statement:`, lastStmt.substring(0, 100))
      result = await pool.query(lastStmt, statements.length === 1 ? parameters : undefined)
    } else {
      result = await pool.query(query, parameters)
    }
    
    console.log(`[executeQuery] Raw result:`, { rowCount: result?.rowCount, rows: result?.rows?.length, command: result?.command })
    
    // Handle cases where result might be empty
    const rows = result?.rows || []
    
    // Convert bigint strings to numbers for better compatibility
    // PostgreSQL returns bigint as strings to avoid JS number precision issues
    // but for most dashboard queries, we want numbers
    const processedRows = rows.map((row: any) => {
      const processedRow: any = {}
      for (const [key, value] of Object.entries(row)) {
        // Convert numeric strings to numbers if they're valid integers
        if (typeof value === 'string' && /^-?\d+$/.test(value)) {
          const num = parseInt(value, 10)
          // Only convert if it's within safe integer range
          if (Number.isSafeInteger(num)) {
            processedRow[key] = num
          } else {
            processedRow[key] = value
          }
        } else {
          processedRow[key] = value
        }
      }
      return processedRow
    })
    
    console.log(`[executeQuery] Query returned ${processedRows.length} rows`)

    // Trigger PostgREST schema cache reload if DDL was executed successfully
    if (projectRef) {
      const { containsDDL } = await import('./ddl-detector')
      if (containsDDL(query)) {
        const { triggerSchemaReload } = await import('lib/api/tenant-manager/projects')
        triggerSchemaReload(projectRef).catch(() => {})
      }
    }

    return { data: processedRows, error: undefined }
  } catch (error: any) {
    console.error('[executeQuery] Query error:', error)
    
    if (error.code) {
      // PostgreSQL error
      const pgError = new PgMetaDatabaseError(
        error.message,
        error.code,
        500,
        error.message
      )
      return { data: undefined, error: pgError }
    }
    
    return { data: undefined, error }
  }

}
