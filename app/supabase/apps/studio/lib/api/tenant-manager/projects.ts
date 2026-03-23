/**
 * Project service wrapper for Tenant-Manager
 * Provides functions that match the Studio API patterns
 */

import { tenantManagerFetch } from './client'
import { encryptString } from 'lib/api/self-hosted/util'

// Project types matching Tenant-Manager responses
export interface Project {
  id: number
  ref: string
  name: string
  db_instance_id?: number
  db_host: string
  db_port: number
  db_name: string
  jwt_secret?: string
  anon_key?: string
  service_role_key?: string
  status: string
  creation_status: string
  rest_port?: number
  auth_port?: number
  cloud_provider: string
  region: string
  organization_id: number
  inserted_at: string
  updated_at: string
}

interface TenantManagerProjectsResponse {
  data: Project[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

interface CreateProjectInput {
  name: string
  ref?: string
  db_instance_id?: number
  region?: string
}

interface ProvisioningResult {
  success: boolean
  project?: Project & {
    anon_key?: string
    service_role_key?: string
  }
  error?: string
  rollbackPerformed?: boolean
}

/**
 * List all projects from Tenant-Manager
 */
export async function listProjects(): Promise<Project[]> {
  const response = await tenantManagerFetch<TenantManagerProjectsResponse['data']>(
    '/admin/v1/projects?limit=1000'
  )

  if (response.error) {
    console.error('Failed to list projects from Tenant-Manager:', response.error)
    return []
  }

  return response.data || []
}

/**
 * Get a single project by ref
 */
export async function getProject(ref: string): Promise<Project | null> {
  const response = await tenantManagerFetch<Project>(`/admin/v1/projects/${ref}`)

  if (response.error) {
    if (response.error.statusCode === 404) {
      return null
    }
    console.error('Failed to get project from Tenant-Manager:', response.error)
    return null
  }

  return response.data || null
}

/**
 * Provision a new project via Tenant-Manager
 */
export async function provisionProject(input: CreateProjectInput): Promise<ProvisioningResult> {
  const response = await tenantManagerFetch<{
    id: number
    ref: string
    name: string
    db_instance_id?: number
    db_host: string
    db_port: number
    db_name: string
    status: string
    creation_status: string
    cloud_provider: string
    region: string
    organization_id: number
    inserted_at: string
    updated_at: string
    keys?: {
      anon_key: string
      service_role_key: string
    }
  }>('/admin/v1/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  })

  if (response.error) {
    return {
      success: false,
      error: response.error.message,
      rollbackPerformed: false,
    }
  }

  if (!response.data) {
    return {
      success: false,
      error: 'No data returned from Tenant-Manager',
      rollbackPerformed: false,
    }
  }

  // Map the response to include keys at the top level for backward compatibility
  const project = {
    ...response.data,
    anon_key: response.data.keys?.anon_key,
    service_role_key: response.data.keys?.service_role_key,
  }

  return {
    success: true,
    project,
    rollbackPerformed: false,
  }
}

/**
 * Deprovision a project via Tenant-Manager
 */
export async function deprovisionProject(
  ref: string
): Promise<{ success: boolean; error?: string }> {
  const response = await tenantManagerFetch<void>(`/admin/v1/projects/${ref}`, {
    method: 'DELETE',
  })

  if (response.error) {
    return {
      success: false,
      error: response.error.message,
    }
  }

  return { success: true }
}

/**
 * Parameters for listing projects by organization
 */
interface ListProjectsByOrgParams {
  limit?: number
  offset?: number
  sort?: 'name_asc' | 'name_desc' | 'created_asc' | 'created_desc'
  search?: string
  statuses?: string[]
}

/**
 * Response type for organization projects listing
 */
interface OrganizationProjectsResponse {
  pagination: {
    count: number
    limit: number
    offset: number
  }
  projects: {
    cloud_provider: string
    databases: {
      identifier: string
      region: string
      status: string
      type: 'PRIMARY' | 'READ_REPLICA'
    }[]
    inserted_at: string
    is_branch: boolean
    name: string
    ref: string
    region: string
    status: string
  }[]
}

/**
 * List projects by organization with pagination, sorting, and filtering
 */
export async function listProjectsByOrganization(
  params: ListProjectsByOrgParams
): Promise<OrganizationProjectsResponse> {
  const { limit = 96, offset = 0, sort = 'name_asc', search, statuses } = params

  // Convert offset/limit to page/limit for Tenant-Manager
  const page = Math.floor(offset / limit) + 1

  // Build query parameters
  const queryParams = new URLSearchParams({
    page: page.toString(),
    limit: limit.toString(),
    sort,
  })

  if (search) {
    queryParams.set('search', search)
  }

  if (statuses && statuses.length > 0) {
    queryParams.set('statuses', statuses.join(','))
  }

  const response = await tenantManagerFetch<Project[]>(
    `/admin/v1/projects?${queryParams.toString()}`
  )

  if (response.error) {
    console.error('Failed to list projects by organization from Tenant-Manager:', response.error)
    return {
      pagination: { count: 0, limit, offset },
      projects: [],
    }
  }

  const projects = response.data || []

  // Map to response format expected by Studio
  const mappedProjects = projects.map((project) => ({
    cloud_provider: project.cloud_provider,
    databases: [
      {
        identifier: project.ref,
        region: project.region,
        status: project.status,
        type: 'PRIMARY' as const,
      },
    ],
    inserted_at: project.inserted_at,
    is_branch: false,
    name: project.name,
    ref: project.ref,
    region: project.region,
    status: project.status,
  }))

  return {
    pagination: {
      count: projects.length,
      limit,
      offset,
    },
    projects: mappedProjects,
  }
}

export interface DatabaseCredentials {
  project_ref: string
  db_name: string
  host: string
  port: number
  user: string
  password: string
}

export async function getDatabaseCredentials(ref: string): Promise<DatabaseCredentials | null> {
  const response = await tenantManagerFetch<DatabaseCredentials>(
    `/admin/v1/projects/${ref}/database-credentials`
  )
  if (response.error) {
    console.error('Failed to get database credentials from TM:', response.error)
    return null
  }
  return response.data || null
}

/**
 * 根据项目信息生成加密的连接字符串
 */
/**
 * Trigger PostgREST schema cache reload for a project.
 * Fire-and-forget — caller should `.catch(() => {})`.
 */
export async function triggerSchemaReload(ref: string): Promise<void> {
  const response = await tenantManagerFetch<{ message: string }>(
    `/internal/v1/projects/${ref}/reload-schema`,
    { method: 'POST', body: '{}' },
  )
  if (response.error) {
    console.warn(`[schema-reload] Failed to trigger reload for ${ref}:`, response.error.message)
  } else {
    console.log(`[schema-reload] Reload triggered for ${ref}`)
  }
}

export async function getEncryptedConnectionStringForProject(project: Project): Promise<string> {
  const credentials = await getDatabaseCredentials(project.ref)
  if (!credentials) {
    throw new Error(`Failed to get database credentials for project ${project.ref}`)
  }
  const connectionString = `postgresql://${credentials.user}:${credentials.password}@${credentials.host}:${credentials.port}/${credentials.db_name}?sslmode=verify-ca`
  return encryptString(connectionString)
}
