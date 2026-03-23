/**
 * Project repository - Kysely-based queries for _tenant.projects table
 * Replaces all dblink-based project queries
 */

import { sql } from 'kysely'
import { getManagementDb } from '../connection.js'
import type { Project, NewProject, ProjectUpdate } from '../types.js'
import type { ProjectStatus, CreationStatus } from '../../types/project.js'

export interface ListProjectsOptions {
  status?: ProjectStatus
  statuses?: string
  region?: string
  db_instance_id?: number
  search?: string
  page?: number
  limit?: number
  sort?: 'name_asc' | 'name_desc' | 'created_asc' | 'created_desc'
}

/**
 * Get a project by ref
 */
export async function findProjectByRef(ref: string): Promise<Project | null> {
  const db = getManagementDb()
  const result = await db
    .selectFrom('_tenant.projects')
    .selectAll()
    .where('ref', '=', ref)
    .executeTakeFirst()
  return result ?? null
}

/**
 * List projects with filtering, sorting, and pagination
 */
export async function findProjects(options: ListProjectsOptions = {}): Promise<Project[]> {
  const { status, statuses, region, db_instance_id, search, page = 1, limit = 50, sort = 'name_asc' } = options
  const offset = (page - 1) * limit
  const db = getManagementDb()

  let query = db.selectFrom('_tenant.projects').selectAll()

  if (status) {
    query = query.where('status', '=', status)
  }
  if (statuses) {
    const statusList = statuses.split(',').map((s) => s.trim()) as ProjectStatus[]
    query = query.where('status', 'in', statusList)
  }
  if (region) {
    query = query.where('region', '=', region)
  }
  if (db_instance_id) {
    query = query.where('db_instance_id', '=', db_instance_id)
  }
  if (search) {
    query = query.where('name', 'ilike', `%${search}%`)
  }

  switch (sort) {
    case 'name_desc':
      query = query.orderBy('name', 'desc')
      break
    case 'created_asc':
      query = query.orderBy('inserted_at', 'asc')
      break
    case 'created_desc':
      query = query.orderBy('inserted_at', 'desc')
      break
    case 'name_asc':
    default:
      query = query.orderBy('name', 'asc')
      break
  }

  return query.limit(limit).offset(offset).execute()
}

/**
 * Count projects with filtering
 */
export async function countProjects(
  options: Omit<ListProjectsOptions, 'page' | 'limit' | 'sort'> = {}
): Promise<number> {
  const { status, statuses, region, db_instance_id, search } = options
  const db = getManagementDb()

  let query = db
    .selectFrom('_tenant.projects')
    .select(sql<number>`count(*)::int`.as('count'))

  if (status) {
    query = query.where('status', '=', status)
  }
  if (statuses) {
    const statusList = statuses.split(',').map((s) => s.trim()) as ProjectStatus[]
    query = query.where('status', 'in', statusList)
  }
  if (region) {
    query = query.where('region', '=', region)
  }
  if (db_instance_id) {
    query = query.where('db_instance_id', '=', db_instance_id)
  }
  if (search) {
    query = query.where('name', 'ilike', `%${search}%`)
  }

  const result = await query.executeTakeFirstOrThrow()
  return result.count
}

/**
 * Insert a new project
 */
export async function insertProject(project: NewProject): Promise<Project> {
  const db = getManagementDb()
  return db
    .insertInto('_tenant.projects')
    .values(project)
    .returningAll()
    .executeTakeFirstOrThrow()
}

/**
 * Update a project by ref
 */
export async function updateProjectByRef(ref: string, updates: ProjectUpdate): Promise<Project | null> {
  const db = getManagementDb()
  const result = await db
    .updateTable('_tenant.projects')
    .set({ ...updates, updated_at: new Date() })
    .where('ref', '=', ref)
    .returningAll()
    .executeTakeFirst()
  return result ?? null
}

/**
 * Delete a project by ref
 */
export async function deleteProjectByRef(ref: string): Promise<boolean> {
  const db = getManagementDb()
  const result = await db
    .deleteFrom('_tenant.projects')
    .where('ref', '=', ref)
    .executeTakeFirst()
  return (result.numDeletedRows ?? 0n) > 0n
}

/**
 * Update project status
 */
export async function updateProjectStatus(
  ref: string,
  status: ProjectStatus,
  creationStatus: CreationStatus
): Promise<boolean> {
  const db = getManagementDb()
  const result = await db
    .updateTable('_tenant.projects')
    .set({ status, creation_status: creationStatus, updated_at: new Date() })
    .where('ref', '=', ref)
    .executeTakeFirst()
  return (result.numUpdatedRows ?? 0n) > 0n
}
