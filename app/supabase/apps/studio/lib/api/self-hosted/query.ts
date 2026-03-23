import { PG_META_URL } from 'lib/constants/index'
import { constructHeaders } from '../apiHelpers'
import { PgMetaDatabaseError, databaseErrorSchema, WrappedResult } from './types'
import { assertSelfHosted, encryptString, getConnectionString } from './util'

export type QueryOptions = {
  query: string
  parameters?: unknown[]
  readOnly?: boolean
  headers?: HeadersInit
  ref?: string
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
  ref,
}: QueryOptions): Promise<WrappedResult<T[]>> {
  assertSelfHosted()

  // 优先使用传入的 x-connection-encrypted，如果没有才生成默认的
  const existingConnectionEncrypted = (headers as Record<string, string>)?.['x-connection-encrypted']
  let connectionStringEncrypted: string

  if (existingConnectionEncrypted) {
    connectionStringEncrypted = existingConnectionEncrypted
  } else if (ref) {
    // 从 TM 获取按项目的数据库凭证，失败则抛错
    const { getDatabaseCredentials } = await import('lib/api/tenant-manager/projects')
    const credentials = await getDatabaseCredentials(ref)
    if (!credentials) {
      throw new Error(`Failed to get database credentials for project ${ref}`)
    }
    const connStr = `postgresql://${credentials.user}:${credentials.password}@${credentials.host}:${credentials.port}/${credentials.db_name}?sslmode=verify-ca`
    connectionStringEncrypted = encryptString(connStr)
  } else {
    // 无 ref, 无 header: 使用本地 env (单租户兼容模式)
    connectionStringEncrypted = encryptString(getConnectionString({ readOnly }))
  }

  const requestBody: { query: string; parameters?: unknown[] } = { query }
  if (parameters !== undefined) {
    requestBody.parameters = parameters
  }

  const response = await fetch(`${PG_META_URL}/query`, {
    method: 'POST',
    headers: constructHeaders({
      ...headers,
      'Content-Type': 'application/json',
      'x-connection-encrypted': connectionStringEncrypted,
    }),
    body: JSON.stringify(requestBody),
  })

  try {
    const result = await response.json()

    if (!response.ok) {
      const { message, code, formattedError } = databaseErrorSchema.parse(result)
      const error = new PgMetaDatabaseError(message, code, response.status, formattedError)
      return { data: undefined, error }
    }

    // Trigger PostgREST schema cache reload if DDL was executed successfully
    if (ref) {
      const { containsDDL } = await import('./ddl-detector')
      if (containsDDL(query)) {
        const { triggerSchemaReload } = await import('lib/api/tenant-manager/projects')
        triggerSchemaReload(ref).catch(() => {})
      }
    }

    return { data: result, error: undefined }
  } catch (error) {
    if (error instanceof Error) {
      return { data: undefined, error }
    }
    throw error
  }
}
