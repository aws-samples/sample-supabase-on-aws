/**
 * Allocation Strategy Interface and Base Implementation
 * 
 * This module defines the interface for cluster allocation strategies
 * and provides a base class with common filtering logic.
 */

import type { Cluster } from './types'

/**
 * Context provided for allocation decisions
 */
export interface AllocationContext {
  project_id: string
  organization_id: string
  region_preference?: string
  metadata?: Record<string, any>
}

/**
 * Result of an allocation decision
 */
export interface AllocationResult {
  cluster_identifier: string
  reason: string
}

/**
 * Interface for allocation strategy implementations
 * 
 * Each strategy must implement the selectCluster method to choose
 * an appropriate cluster based on the provided context.
 */
export interface AllocationStrategy {
  /**
   * Select a cluster for project allocation
   * 
   * @param clusters - Available clusters to choose from
   * @param context - Context information for the allocation decision
   * @returns Allocation result with selected cluster identifier and reason
   * @throws Error if no suitable cluster is available
   */
  selectCluster(clusters: Cluster[], context: AllocationContext): AllocationResult
}

/**
 * Base class providing common filtering logic for allocation strategies
 * 
 * This class filters clusters based on:
 * - Status: Only 'online' clusters are considered
 * - Capacity: Only clusters with available capacity (current_databases < max_databases)
 */
export abstract class BaseAllocationStrategy implements AllocationStrategy {
  abstract selectCluster(clusters: Cluster[], context: AllocationContext): AllocationResult

  /**
   * Filter clusters to only include those eligible for allocation
   * 
   * Requirements: 5.3, 5.4, 8.4
   * - Excludes clusters with status 'offline' or 'maintenance'
   * - Excludes clusters at or over capacity
   * 
   * @param clusters - All clusters to filter
   * @returns Filtered list of eligible clusters
   */
  protected filterEligibleClusters(clusters: Cluster[]): Cluster[] {
    return clusters.filter(
      (cluster) =>
        cluster.status === 'online' &&
        cluster.current_databases < cluster.max_databases
    )
  }

  /**
   * Validate that at least one eligible cluster exists
   * 
   * @param clusters - Filtered eligible clusters
   * @throws Error if no eligible clusters are available
   */
  protected validateEligibleClusters(clusters: Cluster[]): void {
    if (clusters.length === 0) {
      throw new Error('No eligible clusters available for allocation')
    }
  }

  /**
   * Calculate utilization percentage for a cluster
   * 
   * @param cluster - The cluster to calculate utilization for
   * @returns Utilization percentage (0-100)
   */
  protected calculateUtilization(cluster: Cluster): number {
    if (cluster.max_databases === 0) {
      return 100
    }
    return (cluster.current_databases / cluster.max_databases) * 100
  }
}
