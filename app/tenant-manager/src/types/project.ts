/**
 * Project-related types for multi-tenant management
 */

// Project status enum matching Supabase Platform statuses
export type ProjectStatus =
  | 'ACTIVE_HEALTHY'
  | 'COMING_UP'
  | 'GOING_DOWN'
  | 'INACTIVE'
  | 'INIT_FAILED'
  | 'REMOVED'
  | 'RESTORING'
  | 'UNKNOWN'
  | 'UPGRADING'
  | 'PAUSING'
  | 'PAUSED'

// Project creation/lifecycle status
export type CreationStatus =
  | 'pending'
  | 'creating_database'
  | 'initializing'
  | 'registering_services'
  | 'completed'
  | 'failed'
  | 'deleting'
  | 'pausing'
  | 'paused'
  | 'restoring'

// Project record in _tenant.projects table
export interface Project {
  id: number
  ref: string
  name: string
  db_instance_id: number
  db_host: string
  db_port: number
  db_name: string
  status: ProjectStatus
  creation_status: CreationStatus
  rest_port: number | null
  auth_port: number | null
  cloud_provider: string
  region: string
  organization_id: number
  inserted_at: Date
  updated_at: Date
}

// Project quota limits
export interface ProjectQuota {
  id: number
  project_id: number
  db_size_limit_bytes: number
  storage_size_limit_bytes: number
  api_requests_per_day: number
}

// Input for creating a new project
export interface CreateProjectInput {
  name: string
  ref?: string // Optional, will be generated if not provided
  db_instance_id?: number // Optional, for multi-instance support
  instance_identifier?: string // Optional, select by identifier
  region?: string
  organization_id?: number
  strategy?: import('./allocation-strategy.js').AllocationStrategyType // Optional, override default strategy
}

// Creation state for rollback tracking
export interface CreationState {
  dbCreated: boolean
  dbInitialized: boolean
  authTenant: boolean
  storageTenant: boolean
  realtimeTenant: boolean
  supavisorTenant: boolean
  postgrestStarted: boolean
  kongRoutes: boolean
  projectRecord: boolean
  platformDbWritten: boolean
  lambdaCreated: boolean
  kongConsumers: boolean
}

// Service tenant registration config
export interface TenantConfig {
  projectRef: string
  dbName: string
  dbHost: string
  dbPort: number
  dbPassword: string
  jwtSecret: string
  anonKey: string
  serviceRoleKey: string
  siteUrl?: string // Optional, for Auth service
}

// Provisioning result
export interface ProvisioningResult {
  success: boolean
  project?: Project
  error?: string
  rollbackPerformed?: boolean
  api_keys?: import('./api-key.js').ApiKeyCreatedResponse[]
}

// Project health check result
export interface ProjectHealthResult {
  healthy: boolean
  database: boolean
  supavisor: boolean
  realtime: boolean
  auth: boolean
  errors: string[]
}
