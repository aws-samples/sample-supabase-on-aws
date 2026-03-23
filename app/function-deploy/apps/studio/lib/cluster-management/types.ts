/**
 * Database cluster management types
 */

export interface Cluster {
  id: number
  identifier: string
  name: string
  host: string
  port: number
  admin_user: string
  auth_method: 'password' | 'secrets_manager'
  admin_credential: string
  is_management_instance: boolean
  region: string
  status: 'online' | 'offline' | 'maintenance'
  weight: number
  max_databases: number
  current_databases: number
  created_at: Date
  updated_at: Date
}

export interface ClusterMetrics {
  identifier: string
  max_databases: number
  current_databases: number
  utilization_percentage: number
  available_capacity: number
}
