/**
 * Unit tests for ClusterManagementService
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ClusterManagementService } from './cluster-management-service'
import type { ClusterRepository } from './cluster-repository'
import type { Cluster } from './types'

// Mock repository
const createMockRepository = (): ClusterRepository => ({
  findById: vi.fn(),
  findByIdentifier: vi.fn(),
  findAll: vi.fn(),
  findByStatus: vi.fn(),
  findByRegion: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  updateStatus: vi.fn(),
  updateCapacity: vi.fn(),
  incrementCurrentDatabases: vi.fn(),
  decrementCurrentDatabases: vi.fn(),
})

describe('ClusterManagementService', () => {
  let service: ClusterManagementService
  let mockRepository: ClusterRepository
  const connectionString = 'postgresql://localhost:5432/test'
  const encryptionKey = 'test-encryption-key-32-characters'

  beforeEach(() => {
    mockRepository = createMockRepository()
    service = new ClusterManagementService(mockRepository, encryptionKey)
  })

  describe('registerCluster', () => {
    it('should register a cluster with password auth', async () => {
      const input = {
        identifier: 'cluster-1',
        name: 'Test Cluster',
        host: 'localhost',
        port: 5432,
        admin_user: 'postgres',
        auth_method: 'password' as const,
        credential: 'test-password',
        region: 'us-east-1',
        weight: 100,
        max_databases: 100,
      }

      const expectedCluster: Cluster = {
        id: 1,
        ...input,
        admin_credential: 'encrypted:test',
        is_management_instance: false,
        status: 'offline',
        current_databases: 0,
        created_at: new Date(),
        updated_at: new Date(),
      }

      vi.mocked(mockRepository.findByIdentifier).mockResolvedValue(null)
      vi.mocked(mockRepository.create).mockResolvedValue(expectedCluster)

      const result = await service.registerCluster(input, connectionString)

      expect(result).toBeDefined()
      expect(result.status).toBe('offline')
      expect(result.identifier).toBe(input.identifier)
      expect(mockRepository.findByIdentifier).toHaveBeenCalledWith(
        input.identifier,
        connectionString
      )
      expect(mockRepository.create).toHaveBeenCalled()
    })

    it('should reject duplicate identifier', async () => {
      const input = {
        identifier: 'cluster-1',
        name: 'Test Cluster',
        host: 'localhost',
        port: 5432,
        admin_user: 'postgres',
        auth_method: 'password' as const,
        credential: 'test-password',
        region: 'us-east-1',
        weight: 100,
        max_databases: 100,
      }

      const existingCluster: Cluster = {
        id: 1,
        ...input,
        admin_credential: 'encrypted:test',
        is_management_instance: false,
        status: 'offline',
        current_databases: 0,
        created_at: new Date(),
        updated_at: new Date(),
      }

      vi.mocked(mockRepository.findByIdentifier).mockResolvedValue(existingCluster)

      await expect(
        service.registerCluster(input, connectionString)
      ).rejects.toThrow("Cluster with identifier 'cluster-1' already exists")
    })

    it('should reject missing required fields', async () => {
      const input = {
        identifier: '',
        name: 'Test Cluster',
        host: 'localhost',
        port: 5432,
        admin_user: 'postgres',
        auth_method: 'password' as const,
        credential: 'test-password',
        region: 'us-east-1',
        weight: 100,
        max_databases: 100,
      }

      await expect(
        service.registerCluster(input, connectionString)
      ).rejects.toThrow("Required field 'identifier' is missing")
    })

    it('should reject invalid auth_method', async () => {
      const input = {
        identifier: 'cluster-1',
        name: 'Test Cluster',
        host: 'localhost',
        port: 5432,
        admin_user: 'postgres',
        auth_method: 'invalid' as any,
        credential: 'test-password',
        region: 'us-east-1',
        weight: 100,
        max_databases: 100,
      }

      await expect(
        service.registerCluster(input, connectionString)
      ).rejects.toThrow('Invalid auth_method')
    })
  })

  describe('bringOnline', () => {
    it('should bring a cluster online', async () => {
      const identifier = 'cluster-1'
      const cluster: Cluster = {
        id: 1,
        identifier,
        name: 'Test Cluster',
        host: 'localhost',
        port: 5432,
        admin_user: 'postgres',
        auth_method: 'password',
        admin_credential: 'encrypted:test',
        is_management_instance: false,
        region: 'us-east-1',
        status: 'offline',
        weight: 100,
        max_databases: 100,
        current_databases: 0,
        created_at: new Date(),
        updated_at: new Date(),
      }

      const onlineCluster = { ...cluster, status: 'online' as const }

      vi.mocked(mockRepository.findByIdentifier).mockResolvedValue(cluster)
      vi.mocked(mockRepository.updateStatus).mockResolvedValue(onlineCluster)

      const result = await service.bringOnline(identifier, connectionString)

      expect(result.status).toBe('online')
      expect(mockRepository.updateStatus).toHaveBeenCalledWith(
        identifier,
        'online',
        connectionString
      )
    })

    it('should reject if cluster not found', async () => {
      const identifier = 'nonexistent'

      vi.mocked(mockRepository.findByIdentifier).mockResolvedValue(null)

      await expect(
        service.bringOnline(identifier, connectionString)
      ).rejects.toThrow("Cluster with identifier 'nonexistent' not found")
    })
  })

  describe('takeOffline', () => {
    it('should take a cluster offline', async () => {
      const identifier = 'cluster-1'
      const cluster: Cluster = {
        id: 1,
        identifier,
        name: 'Test Cluster',
        host: 'localhost',
        port: 5432,
        admin_user: 'postgres',
        auth_method: 'password',
        admin_credential: 'encrypted:test',
        is_management_instance: false,
        region: 'us-east-1',
        status: 'online',
        weight: 100,
        max_databases: 100,
        current_databases: 0,
        created_at: new Date(),
        updated_at: new Date(),
      }

      const offlineCluster = { ...cluster, status: 'offline' as const }

      vi.mocked(mockRepository.findByIdentifier).mockResolvedValue(cluster)
      vi.mocked(mockRepository.updateStatus).mockResolvedValue(offlineCluster)

      const result = await service.takeOffline(identifier, connectionString)

      expect(result.status).toBe('offline')
      expect(mockRepository.updateStatus).toHaveBeenCalledWith(
        identifier,
        'offline',
        connectionString
      )
    })
  })

  describe('deleteCluster', () => {
    it('should delete a cluster with zero databases', async () => {
      const identifier = 'cluster-1'
      const cluster: Cluster = {
        id: 1,
        identifier,
        name: 'Test Cluster',
        host: 'localhost',
        port: 5432,
        admin_user: 'postgres',
        auth_method: 'password',
        admin_credential: 'encrypted:test',
        is_management_instance: false,
        region: 'us-east-1',
        status: 'offline',
        weight: 100,
        max_databases: 100,
        current_databases: 0,
        created_at: new Date(),
        updated_at: new Date(),
      }

      vi.mocked(mockRepository.findByIdentifier).mockResolvedValue(cluster)
      vi.mocked(mockRepository.delete).mockResolvedValue(undefined)

      await service.deleteCluster(identifier, false, connectionString)

      expect(mockRepository.delete).toHaveBeenCalledWith(cluster.id, connectionString)
    })

    it('should reject deletion if cluster has active databases', async () => {
      const identifier = 'cluster-1'
      const cluster: Cluster = {
        id: 1,
        identifier,
        name: 'Test Cluster',
        host: 'localhost',
        port: 5432,
        admin_user: 'postgres',
        auth_method: 'password',
        admin_credential: 'encrypted:test',
        is_management_instance: false,
        region: 'us-east-1',
        status: 'offline',
        weight: 100,
        max_databases: 100,
        current_databases: 5,
        created_at: new Date(),
        updated_at: new Date(),
      }

      vi.mocked(mockRepository.findByIdentifier).mockResolvedValue(cluster)

      await expect(
        service.deleteCluster(identifier, false, connectionString)
      ).rejects.toThrow('Cannot delete cluster')
    })
  })

  describe('updateCapacity', () => {
    it('should update capacity when new value is greater than current databases', async () => {
      const identifier = 'cluster-1'
      const cluster: Cluster = {
        id: 1,
        identifier,
        name: 'Test Cluster',
        host: 'localhost',
        port: 5432,
        admin_user: 'postgres',
        auth_method: 'password',
        admin_credential: 'encrypted:test',
        is_management_instance: false,
        region: 'us-east-1',
        status: 'online',
        weight: 100,
        max_databases: 100,
        current_databases: 50,
        created_at: new Date(),
        updated_at: new Date(),
      }

      const updatedCluster = { ...cluster, max_databases: 200 }

      vi.mocked(mockRepository.findByIdentifier).mockResolvedValue(cluster)
      vi.mocked(mockRepository.updateCapacity).mockResolvedValue(updatedCluster)

      const result = await service.updateCapacity(identifier, 200, connectionString)

      expect(result.max_databases).toBe(200)
      expect(mockRepository.updateCapacity).toHaveBeenCalledWith(
        identifier,
        200,
        connectionString
      )
    })

    it('should reject capacity update if new value is less than or equal to current databases', async () => {
      const identifier = 'cluster-1'
      const cluster: Cluster = {
        id: 1,
        identifier,
        name: 'Test Cluster',
        host: 'localhost',
        port: 5432,
        admin_user: 'postgres',
        auth_method: 'password',
        admin_credential: 'encrypted:test',
        is_management_instance: false,
        region: 'us-east-1',
        status: 'online',
        weight: 100,
        max_databases: 100,
        current_databases: 50,
        created_at: new Date(),
        updated_at: new Date(),
      }

      vi.mocked(mockRepository.findByIdentifier).mockResolvedValue(cluster)

      await expect(
        service.updateCapacity(identifier, 50, connectionString)
      ).rejects.toThrow('Cannot update capacity')
    })
  })

  describe('getClusterStatus', () => {
    it('should return clusters with utilization metrics', async () => {
      const clusters: Cluster[] = [
        {
          id: 1,
          identifier: 'cluster-1',
          name: 'Cluster 1',
          host: 'localhost',
          port: 5432,
          admin_user: 'postgres',
          auth_method: 'password',
          admin_credential: 'encrypted:test',
          is_management_instance: false,
          region: 'us-east-1',
          status: 'online',
          weight: 100,
          max_databases: 100,
          current_databases: 80,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 2,
          identifier: 'cluster-2',
          name: 'Cluster 2',
          host: 'localhost',
          port: 5433,
          admin_user: 'postgres',
          auth_method: 'password',
          admin_credential: 'encrypted:test',
          is_management_instance: false,
          region: 'us-east-1',
          status: 'online',
          weight: 100,
          max_databases: 100,
          current_databases: 20,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]

      vi.mocked(mockRepository.findAll).mockResolvedValue(clusters)

      const result = await service.getClusterStatus(connectionString)

      expect(result.clusters).toHaveLength(2)
      expect(result.clusters[0].utilization_percentage).toBe(80)
      expect(result.clusters[1].utilization_percentage).toBe(20)
      // Should be sorted by utilization descending
      expect(result.clusters[0].identifier).toBe('cluster-1')
      expect(result.summary.total_clusters).toBe(2)
      expect(result.summary.online_clusters).toBe(2)
    })

    it('should filter by region', async () => {
      const clusters: Cluster[] = [
        {
          id: 1,
          identifier: 'cluster-1',
          name: 'Cluster 1',
          host: 'localhost',
          port: 5432,
          admin_user: 'postgres',
          auth_method: 'password',
          admin_credential: 'encrypted:test',
          is_management_instance: false,
          region: 'us-east-1',
          status: 'online',
          weight: 100,
          max_databases: 100,
          current_databases: 50,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]

      vi.mocked(mockRepository.findByRegion).mockResolvedValue(clusters)

      const result = await service.getClusterStatus(connectionString, {
        region: 'us-east-1',
      })

      expect(result.clusters).toHaveLength(1)
      expect(mockRepository.findByRegion).toHaveBeenCalledWith(
        'us-east-1',
        connectionString
      )
    })
  })

  describe('getPlatformMetrics', () => {
    it('should calculate platform-wide metrics', async () => {
      const clusters: Cluster[] = [
        {
          id: 1,
          identifier: 'cluster-1',
          name: 'Cluster 1',
          host: 'localhost',
          port: 5432,
          admin_user: 'postgres',
          auth_method: 'password',
          admin_credential: 'encrypted:test',
          is_management_instance: false,
          region: 'us-east-1',
          status: 'online',
          weight: 100,
          max_databases: 100,
          current_databases: 80,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 2,
          identifier: 'cluster-2',
          name: 'Cluster 2',
          host: 'localhost',
          port: 5433,
          admin_user: 'postgres',
          auth_method: 'password',
          admin_credential: 'encrypted:test',
          is_management_instance: false,
          region: 'us-east-1',
          status: 'online',
          weight: 100,
          max_databases: 100,
          current_databases: 20,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]

      vi.mocked(mockRepository.findAll).mockResolvedValue(clusters)

      const result = await service.getPlatformMetrics(connectionString)

      expect(result.total_clusters).toBe(2)
      expect(result.online_clusters).toBe(2)
      expect(result.total_capacity).toBe(200)
      expect(result.total_allocated).toBe(100)
      expect(result.platform_utilization_percentage).toBe(50)
      expect(result.max_utilized_cluster?.identifier).toBe('cluster-1')
      expect(result.min_utilized_cluster?.identifier).toBe('cluster-2')
    })
  })
})
