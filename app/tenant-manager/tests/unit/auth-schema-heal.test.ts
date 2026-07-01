/**
 * Unit tests for the auth-schema self-heal.
 *
 * Verifies the three guarantees that make the startup heal safe:
 *   1. precise   — every heal statement only ADDs columns/constraints
 *                  idempotently; it never DROPs, DELETEs, or rewrites data.
 *   2. complete  — the statement set covers the columns GoTrue needs
 *                  (flow_state OAuth context + oauth_clients auth method).
 *   3. fail-open — healAuthSchemaOnInstance heals the template and every
 *                  tenant DB, pages through all tenants, and a single failing
 *                  database never aborts the run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Collected calls: which databases got connected, and which statements ran.
const connectedDbs: string[] = []
const ranStatements: string[] = []
// Database names whose client should throw on connect (simulate locked/paused).
let failingDbs = new Set<string>()

vi.mock('../../src/db/instance-connection.js', () => ({
  // withInstanceTenantClient(conn, dbName, fn): record the db, optionally fail,
  // otherwise hand fn a fake client whose query() records statements.
  withInstanceTenantClient: vi.fn(async (_conn: unknown, dbName: string, fn: (c: unknown) => Promise<unknown>) => {
    connectedDbs.push(dbName)
    if (failingDbs.has(dbName)) {
      throw new Error(`connection refused for ${dbName}`)
    }
    const fakeClient = {
      query: vi.fn(async (sql: string) => {
        ranStatements.push(sql)
        return { rows: [], rowCount: 0 }
      }),
    }
    return fn(fakeClient)
  }),
  getInstanceSystemPool: vi.fn(),
}))

// findProjects is paged; default returns nothing, individual tests override.
const findProjectsMock = vi.fn()
vi.mock('../../src/db/repositories/project.repository.js', () => ({
  findProjects: (...args: unknown[]) => findProjectsMock(...args),
}))

const conn = { instanceId: 7, host: 'h', port: 5432, user: 'postgres', password: 'pw' }

function project(db_name: string) {
  return { id: 1, ref: db_name, name: db_name, db_instance_id: 7, db_name } as unknown
}

describe('AUTH_SCHEMA_HEAL_STATEMENTS', () => {
  it('only contains idempotent additive statements (no destructive DDL)', async () => {
    const { AUTH_SCHEMA_HEAL_STATEMENTS } = await import('../../src/modules/provisioning/auth-schema.js')
    expect(AUTH_SCHEMA_HEAL_STATEMENTS.length).toBeGreaterThan(0)

    for (const stmt of AUTH_SCHEMA_HEAL_STATEMENTS) {
      const upper = stmt.toUpperCase()
      // Never destructive: no dropping tables/columns/constraints, no data loss.
      expect(upper).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT|DATABASE|SCHEMA|INDEX)/)
      expect(upper).not.toMatch(/\bDELETE\b/)
      expect(upper).not.toMatch(/\bTRUNCATE\b/)
      // Each is one of: additive column add, an idempotent DO-block, or a
      // constraint RELAXATION (ALTER COLUMN ... DROP NOT NULL) — the last is
      // safe (loosens a constraint, touches no data) and needed to bring
      // legacy template-cloned tenants in line with the current nullable schema.
      const isColumnAdd = /ADD COLUMN IF NOT EXISTS/i.test(stmt)
      const isGuardedDo = /^DO \$\$/i.test(stmt.trim()) && /DUPLICATE_OBJECT/i.test(upper)
      const isDropNotNull = /ALTER COLUMN \w+ DROP NOT NULL/i.test(stmt)
      expect(isColumnAdd || isGuardedDo || isDropNotNull).toBe(true)
    }
  })

  it('covers the flow_state and oauth_clients columns GoTrue requires', async () => {
    const { AUTH_SCHEMA_HEAL_STATEMENTS } = await import('../../src/modules/provisioning/auth-schema.js')
    const joined = AUTH_SCHEMA_HEAL_STATEMENTS.join('\n')
    for (const col of [
      'invite_token',
      'referrer',
      'oauth_client_state_id',
      'linking_target_id',
      'email_optional',
      'token_endpoint_auth_method',
    ]) {
      expect(joined).toContain(col)
    }
  })
})

describe('healAuthSchemaOnInstance', () => {
  beforeEach(() => {
    connectedDbs.length = 0
    ranStatements.length = 0
    failingDbs = new Set()
    findProjectsMock.mockReset()
  })

  it('heals the template and every tenant database', async () => {
    findProjectsMock.mockResolvedValueOnce([project('project_a'), project('project_b')]).mockResolvedValueOnce([])
    const { healAuthSchemaOnInstance } = await import('../../src/modules/provisioning/template-initializer.js')

    await healAuthSchemaOnInstance(conn)

    expect(connectedDbs).toContain('supabase_template')
    expect(connectedDbs).toContain('project_a')
    expect(connectedDbs).toContain('project_b')
    // Heal statements ran against each healthy database.
    expect(ranStatements.some((s) => /email_optional/.test(s))).toBe(true)
  })

  it('is fail-open: one failing tenant DB does not abort the rest', async () => {
    failingDbs = new Set(['project_locked'])
    findProjectsMock
      .mockResolvedValueOnce([project('project_locked'), project('project_ok')])
      .mockResolvedValueOnce([])
    const { healAuthSchemaOnInstance } = await import('../../src/modules/provisioning/template-initializer.js')

    // Must not throw even though project_locked rejects on connect.
    await expect(healAuthSchemaOnInstance(conn)).resolves.toBeUndefined()
    // The healthy tenant after the failing one was still processed.
    expect(connectedDbs).toContain('project_ok')
  })

  it('is fail-open: template heal failure does not block tenant heal', async () => {
    failingDbs = new Set(['supabase_template'])
    findProjectsMock.mockResolvedValueOnce([project('project_ok')]).mockResolvedValueOnce([])
    const { healAuthSchemaOnInstance } = await import('../../src/modules/provisioning/template-initializer.js')

    await expect(healAuthSchemaOnInstance(conn)).resolves.toBeUndefined()
    expect(connectedDbs).toContain('project_ok')
  })

  it('pages through tenants and stops on a short/empty page (no silent cap)', async () => {
    // First page is full (100), second page partial -> stop after second.
    const fullPage = Array.from({ length: 100 }, (_, i) => project(`project_${i}`))
    findProjectsMock.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([project('project_tail')])
    const { healAuthSchemaOnInstance } = await import('../../src/modules/provisioning/template-initializer.js')

    await healAuthSchemaOnInstance(conn)

    expect(findProjectsMock).toHaveBeenCalledTimes(2)
    expect(connectedDbs).toContain('project_tail')
    // Paged with increasing page numbers and a stable page size.
    expect(findProjectsMock.mock.calls[0][0]).toMatchObject({ db_instance_id: 7, page: 1, limit: 100 })
    expect(findProjectsMock.mock.calls[1][0]).toMatchObject({ db_instance_id: 7, page: 2, limit: 100 })
  })

  it('skips tenant heal enumeration failure without throwing', async () => {
    findProjectsMock.mockRejectedValueOnce(new Error('management DB down'))
    const { healAuthSchemaOnInstance } = await import('../../src/modules/provisioning/template-initializer.js')

    await expect(healAuthSchemaOnInstance(conn)).resolves.toBeUndefined()
    // Template was still healed before enumeration was attempted.
    expect(connectedDbs).toContain('supabase_template')
  })
})
