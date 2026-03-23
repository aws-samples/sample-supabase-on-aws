/**
 * RDS instance load balancer for multi-instance database support
 * Refactored to use DB-persisted allocation strategies
 */

import {
  findAvailableInstances,
  findRdsInstanceById,
  findRdsInstances,
} from '../../db/repositories/rds-instance.repository.js'
import { findActiveStrategy } from '../../db/repositories/allocation-strategy.repository.js'
import { getStrategy } from './strategies/index.js'
import type { DbInstance } from '../../db/types.js'
import type {
  InstanceLoadScore,
  InstanceMetrics,
} from '../../types/index.js'
import type {
  AllocationStrategyType,
  AllocationContext,
  AllocationResult,
} from '../../types/allocation-strategy.js'

// Weight factors for load scoring (kept for backwards compatibility)
const SCORING_WEIGHTS = {
  schemaCount: 0.4,
  cpuUsage: 0.3,
  connections: 0.2,
  weight: 0.1,
}

/**
 * Calculate a load score for an instance
 * Lower scores indicate better candidates for new projects
 */
export function calculateLoadScore(
  instance: DbInstance,
  metrics?: InstanceMetrics
): InstanceLoadScore {
  const schemaScore = (instance.current_databases / instance.max_databases) * 100
  const cpuScore = metrics?.cpu_usage_percent ?? 50
  const maxConnections = instance.max_databases * 100
  const connectionScore = metrics?.connection_count
    ? (metrics.connection_count / maxConnections) * 100
    : 50
  const weightScore = 100 - Math.min(instance.weight, 200) / 2

  const score =
    schemaScore * SCORING_WEIGHTS.schemaCount +
    cpuScore * SCORING_WEIGHTS.cpuUsage +
    connectionScore * SCORING_WEIGHTS.connections +
    weightScore * SCORING_WEIGHTS.weight

  return {
    instance,
    score,
    details: {
      schemaScore,
      cpuScore,
      connectionScore,
      weightScore,
    },
  }
}

/**
 * Main instance selection function
 * Uses DB-persisted strategy or allows override
 */
export async function selectInstance(options: {
  projectRef: string
  organizationId: number
  region?: string
  instanceIdentifier?: string
  strategyOverride?: AllocationStrategyType
}): Promise<AllocationResult> {
  const { projectRef, organizationId, region, instanceIdentifier, strategyOverride } = options

  // Determine which strategy to use
  let strategyType: AllocationStrategyType
  let strategyConfig: Record<string, unknown> | undefined

  if (strategyOverride) {
    strategyType = strategyOverride
  } else if (instanceIdentifier) {
    // If an instance identifier is provided, use manual strategy
    strategyType = 'manual'
  } else {
    // Look up the active strategy from DB
    const activeStrategy = await findActiveStrategy()
    strategyType = activeStrategy?.strategy_type ?? 'least_connections'
    strategyConfig = activeStrategy?.config ?? undefined
  }

  // Get all instances (strategy will filter eligible ones)
  const instances = await findRdsInstances({})

  if (instances.length === 0) {
    throw new Error('No database instances registered')
  }

  // Build allocation context
  const context: AllocationContext = {
    project_ref: projectRef,
    organization_id: organizationId,
    region,
    instance_identifier: instanceIdentifier,
  }

  // Execute strategy
  const strategy = getStrategy(strategyType)
  return strategy.select(instances, context, strategyConfig ?? undefined)
}

/**
 * Get load scores for all instances
 */
export async function getInstanceLoadScores(): Promise<InstanceLoadScore[]> {
  const instances = await findAvailableInstances()
  return instances.map((instance) => calculateLoadScore(instance))
}

/**
 * Check if an instance can accept new projects
 */
export async function canAcceptProjects(instanceId: number): Promise<boolean> {
  const instance = await findRdsInstanceById(instanceId)
  if (!instance) return false
  return instance.status === 'active' && instance.current_databases < instance.max_databases
}
