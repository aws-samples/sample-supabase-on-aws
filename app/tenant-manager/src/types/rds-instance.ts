/**
 * RDS instance types for multi-instance database support
 */

// Database instance status
export type DbInstanceStatus = 'active' | 'maintenance' | 'draining' | 'offline'

// Authentication method for RDS instance credentials
export type AuthMethod = 'password' | 'secrets_manager'

// Database instance for multi-instance support
export interface DbInstance {
  id: number
  identifier: string
  name: string
  host: string
  port: number
  admin_user: string
  auth_method: AuthMethod
  admin_credential: string | null
  is_management_instance: boolean
  region: string
  status: DbInstanceStatus
  weight: number
  max_databases: number
  current_databases: number
  created_at: Date
  updated_at: Date
}

// Instance selection strategy for multi-instance mode
export type InstanceSelectionStrategy =
  | 'least_projects'
  | 'least_connections'
  | 'weighted_random'
  | 'region_affinity'
  | 'explicit'

// Instance selection options
export interface InstanceSelectionOptions {
  strategy?: InstanceSelectionStrategy
  region?: string
  instanceIdentifier?: string
}

// Instance metrics
export interface InstanceMetrics {
  cpu_usage_percent?: number
  memory_usage_percent?: number
  connection_count?: number
  database_count: number
  storage_used_bytes?: number
}

// Input for creating a new RDS instance
export interface CreateRdsInstanceInput {
  identifier: string
  name: string
  host: string
  port?: number
  admin_user?: string
  admin_password?: string
  auth_method?: AuthMethod
  admin_credential?: string  // Secret reference for secrets_manager mode
  region?: string
  weight?: number
  max_databases?: number
}

// Input for updating an RDS instance
export interface UpdateRdsInstanceInput {
  name?: string
  host?: string
  port?: number
  admin_user?: string
  admin_password?: string
  auth_method?: AuthMethod
  admin_credential?: string
  region?: string
  status?: DbInstanceStatus
  weight?: number
  max_databases?: number
}

// RDS instance with metrics
export interface DbInstanceWithMetrics extends DbInstance {
  metrics?: InstanceMetrics
}

// Load score for instance selection
export interface InstanceLoadScore {
  instance: DbInstance
  score: number
  details: {
    schemaScore: number
    cpuScore: number
    connectionScore: number
    weightScore: number
  }
}
