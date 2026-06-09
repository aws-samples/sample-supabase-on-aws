/**
 * Unit tests for the Edge Function metadata repository.
 *
 * Tests focus on the public surface — list/get/upsert/delete by
 * (project_ref, slug). The Kysely query builder is mocked so these tests
 * stay hermetic (no DB).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const executeTakeFirst = vi.fn()
const executeMany = vi.fn()
const onConflict = vi.fn()
const where = vi.fn()
const orderBy = vi.fn()
const limit = vi.fn()
const offset = vi.fn()
const selectAll = vi.fn()
const selectFrom = vi.fn()
const insertInto = vi.fn()
const updateTable = vi.fn()
const set = vi.fn()
const values = vi.fn()
const deleteFrom = vi.fn()
const returningAll = vi.fn()
const doUpdateSet = vi.fn()
const columns = vi.fn()

// A tiny chainable Kysely-shaped mock. Each method returns the same `chain`
// object so tests can stub the terminal `.execute*` call.
function chain(): any {
  const c: any = {}
  c.selectAll = vi.fn().mockReturnValue(c)
  c.where = vi.fn().mockReturnValue(c)
  c.orderBy = vi.fn().mockReturnValue(c)
  c.limit = vi.fn().mockReturnValue(c)
  c.offset = vi.fn().mockReturnValue(c)
  c.execute = vi.fn().mockResolvedValue([])
  c.executeTakeFirst = vi.fn().mockResolvedValue(null)
  c.values = vi.fn().mockReturnValue(c)
  c.set = vi.fn().mockReturnValue(c)
  c.returningAll = vi.fn().mockReturnValue(c)
  c.onConflict = vi.fn().mockImplementation((cb: (oc: any) => any) => {
    const oc: any = {}
    oc.columns = vi.fn().mockReturnValue(oc)
    oc.doUpdateSet = vi.fn().mockReturnValue(oc)
    cb(oc)
    return c
  })
  return c
}

const dbMock: any = {
  selectFrom: vi.fn(),
  insertInto: vi.fn(),
  updateTable: vi.fn(),
  deleteFrom: vi.fn(),
}

vi.mock('../../src/db/connection.js', () => ({
  getManagementDb: () => dbMock,
}))

beforeEach(() => {
  dbMock.selectFrom.mockImplementation(() => chain())
  dbMock.insertInto.mockImplementation(() => chain())
  dbMock.updateTable.mockImplementation(() => chain())
  dbMock.deleteFrom.mockImplementation(() => chain())
})

import {
  findFunction,
  listFunctions,
  upsertFunction,
  deleteFunction,
} from '../../src/db/repositories/function.repository.js'

describe('function.repository', () => {
  describe('findFunction', () => {
    it('queries _tenant.functions by composite key (project_ref, slug)', async () => {
      const c = chain()
      c.executeTakeFirst.mockResolvedValueOnce({
        project_ref: 'abc',
        slug: 'webhook-handler',
        verify_jwt: false,
      })
      dbMock.selectFrom.mockReturnValueOnce(c)

      const result = await findFunction('abc', 'webhook-handler')

      expect(dbMock.selectFrom).toHaveBeenCalledWith('_tenant.functions')
      expect(c.where).toHaveBeenCalledWith('project_ref', '=', 'abc')
      expect(c.where).toHaveBeenCalledWith('slug', '=', 'webhook-handler')
      expect(result).toEqual({
        project_ref: 'abc',
        slug: 'webhook-handler',
        verify_jwt: false,
      })
    })

    it('returns null when the row does not exist', async () => {
      const c = chain()
      c.executeTakeFirst.mockResolvedValueOnce(undefined)
      dbMock.selectFrom.mockReturnValueOnce(c)

      const result = await findFunction('abc', 'missing')

      expect(result).toBeNull()
    })
  })

  describe('listFunctions', () => {
    it('returns all functions for a project ordered by slug', async () => {
      const c = chain()
      c.execute.mockResolvedValueOnce([
        { project_ref: 'abc', slug: 'a-fn', verify_jwt: true },
        { project_ref: 'abc', slug: 'z-fn', verify_jwt: false },
      ])
      dbMock.selectFrom.mockReturnValueOnce(c)

      const result = await listFunctions('abc')

      expect(dbMock.selectFrom).toHaveBeenCalledWith('_tenant.functions')
      expect(c.where).toHaveBeenCalledWith('project_ref', '=', 'abc')
      expect(c.orderBy).toHaveBeenCalledWith('slug', 'asc')
      expect(result).toHaveLength(2)
    })
  })

  describe('upsertFunction', () => {
    it('uses ON CONFLICT (project_ref, slug) DO UPDATE so callers can blindly call it', async () => {
      const c = chain()
      c.executeTakeFirst.mockResolvedValueOnce({
        project_ref: 'abc',
        slug: 'fn',
        verify_jwt: false,
      })
      dbMock.insertInto.mockReturnValueOnce(c)

      const result = await upsertFunction({
        project_ref: 'abc',
        slug: 'fn',
        verify_jwt: false,
      })

      expect(dbMock.insertInto).toHaveBeenCalledWith('_tenant.functions')
      expect(c.values).toHaveBeenCalledWith(
        expect.objectContaining({ project_ref: 'abc', slug: 'fn', verify_jwt: false })
      )
      expect(c.onConflict).toHaveBeenCalled()
      expect(result.verify_jwt).toBe(false)
    })

    it('always bumps updated_at on conflict (so cache invalidators see a change)', async () => {
      const c = chain()
      c.executeTakeFirst.mockResolvedValueOnce({
        project_ref: 'abc',
        slug: 'fn',
        verify_jwt: true,
      })
      dbMock.insertInto.mockReturnValueOnce(c)

      await upsertFunction({ project_ref: 'abc', slug: 'fn', verify_jwt: true })

      // The onConflict closure must touch updated_at — we verify by inspecting
      // the captured onConflict callback's effect on a stub builder.
      const onConflictCall = c.onConflict.mock.calls[0][0]
      const ocBuilder: any = {
        columns: vi.fn().mockReturnThis(),
        doUpdateSet: vi.fn().mockReturnThis(),
      }
      onConflictCall(ocBuilder)
      expect(ocBuilder.columns).toHaveBeenCalledWith(['project_ref', 'slug'])
      expect(ocBuilder.doUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ updated_at: expect.anything() })
      )
    })
  })

  describe('deleteFunction', () => {
    it('deletes by composite key and reports rows-affected', async () => {
      const c = chain()
      c.execute.mockResolvedValueOnce([{ numDeletedRows: 1n }])
      dbMock.deleteFrom.mockReturnValueOnce(c)

      const ok = await deleteFunction('abc', 'fn')

      expect(dbMock.deleteFrom).toHaveBeenCalledWith('_tenant.functions')
      expect(c.where).toHaveBeenCalledWith('project_ref', '=', 'abc')
      expect(c.where).toHaveBeenCalledWith('slug', '=', 'fn')
      expect(ok).toBe(true)
    })

    it('returns false when no row is deleted', async () => {
      const c = chain()
      c.execute.mockResolvedValueOnce([{ numDeletedRows: 0n }])
      dbMock.deleteFrom.mockReturnValueOnce(c)

      const ok = await deleteFunction('abc', 'nope')

      expect(ok).toBe(false)
    })
  })
})
