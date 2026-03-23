/**
 * Kysely database type definitions for the _supabase management database
 */

import type { Generated, Insertable, Selectable, Updateable, ColumnType } from 'kysely'
import type { ProjectStatus, CreationStatus } from '../types/project.js'
import type { DbInstanceStatus, AuthMethod } from '../types/rds-instance.js'
import type { AllocationStrategyType } from '../types/allocation-strategy.js'

/**
 * Projects table in _tenant schema
 */
export interface ProjectsTable {
  id: Generated<number>
  ref: string
  name: string
  db_instance_id: number
  db_host: string
  db_port: ColumnType<number, number | undefined, number | undefined>
  db_name: string
  status: ColumnType<ProjectStatus, ProjectStatus | undefined, ProjectStatus | undefined>
  creation_status: ColumnType<CreationStatus, CreationStatus | undefined, CreationStatus | undefined>
  rest_port: ColumnType<number | null, number | null | undefined, number | null | undefined>
  auth_port: ColumnType<number | null, number | null | undefined, number | null | undefined>
  cloud_provider: ColumnType<string, string | undefined, string | undefined>
  region: ColumnType<string, string | undefined, string | undefined>
  organization_id: ColumnType<number, number | undefined, number | undefined>
  inserted_at: ColumnType<Date, Date | undefined, Date | undefined>
  updated_at: ColumnType<Date, Date | undefined, Date | undefined>
}

export type Project = Selectable<ProjectsTable>
export type NewProject = Insertable<ProjectsTable>
export type ProjectUpdate = Updateable<ProjectsTable>

/**
 * DB Instances table in _tenant schema
 */
export interface DbInstancesTable {
  id: Generated<number>
  identifier: string
  name: string
  host: string
  port: ColumnType<number, number | undefined, number | undefined>
  admin_user: ColumnType<string, string | undefined, string | undefined>
  auth_method: ColumnType<AuthMethod, AuthMethod | undefined, AuthMethod | undefined>
  admin_credential: string | null
  is_management_instance: ColumnType<boolean, boolean | undefined, boolean | undefined>
  region: ColumnType<string, string | undefined, string | undefined>
  status: ColumnType<DbInstanceStatus, DbInstanceStatus | undefined, DbInstanceStatus | undefined>
  weight: ColumnType<number, number | undefined, number | undefined>
  max_databases: ColumnType<number, number | undefined, number | undefined>
  current_databases: ColumnType<number, number | undefined, number | undefined>
  created_at: ColumnType<Date, Date | undefined, Date | undefined>
  updated_at: ColumnType<Date, Date | undefined, Date | undefined>
}

export type DbInstance = Selectable<DbInstancesTable>
export type NewDbInstance = Insertable<DbInstancesTable>
export type DbInstanceUpdate = Updateable<DbInstancesTable>

/**
 * Allocation strategies table in _tenant schema
 */
export interface AllocationStrategiesTable {
  id: Generated<string>
  name: string
  strategy_type: ColumnType<AllocationStrategyType, AllocationStrategyType, AllocationStrategyType | undefined>
  description: string | null
  config: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null | undefined>
  is_active: ColumnType<boolean, boolean | undefined, boolean | undefined>
  created_at: ColumnType<Date, Date | undefined, Date | undefined>
  updated_at: ColumnType<Date, Date | undefined, Date | undefined>
}

export type AllocationStrategyRow = Selectable<AllocationStrategiesTable>
export type NewAllocationStrategy = Insertable<AllocationStrategiesTable>
export type AllocationStrategyUpdate = Updateable<AllocationStrategiesTable>

/**
 * Cluster metrics table in _tenant schema
 */
export interface ClusterMetricsTable {
  id: Generated<number>
  cluster_id: number
  timestamp: Date
  max_databases: number
  current_databases: number
  utilization_percentage: number
  created_at: ColumnType<Date, Date | undefined, Date | undefined>
}

export type ClusterMetricsRow = Selectable<ClusterMetricsTable>
export type NewClusterMetrics = Insertable<ClusterMetricsTable>

/**
 * Database schema definition for Kysely
 * Maps to the _tenant schema in _supabase database
 */
export interface Database {
  '_tenant.projects': ProjectsTable
  '_tenant.db_instances': DbInstancesTable
  '_tenant.project_allocation_strategies': AllocationStrategiesTable
  '_tenant.cluster_metrics': ClusterMetricsTable
}
