/**
 * Cluster Table Component
 * 
 * Displays database clusters in a table with action buttons
 * Supports pagination and search by identifier/name
 * Validates: Requirements 12.2, 12.8, 12.9, 12.12
 */

import { useState, useMemo } from 'react'
import { Cluster } from 'data/database-clusters'
import {
  useDatabaseClusterOnlineMutation,
  useDatabaseClusterOfflineMutation,
  useDatabaseClusterDeleteMutation,
} from 'data/database-clusters'
import {
  Badge,
  Button,
  Card,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Input,
} from 'ui'
import { toast } from 'sonner'
import ConfirmationModal from 'ui-patterns/Dialogs/ConfirmationModal'
import { Play, Square, Trash2, Plus, Search, ChevronLeft, ChevronRight } from 'lucide-react'

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]
const DEFAULT_PAGE_SIZE = 20

interface ClusterTableProps {
  clusters: Array<Cluster & { utilization_percentage: number }>
  onRefresh: () => void
  onAddCluster: () => void
  onSelectCluster?: (cluster: { identifier: string; name: string }) => void
  selectedClusterIdentifier?: string | null
}

export const ClusterTable = ({ 
  clusters, 
  onRefresh, 
  onAddCluster,
  onSelectCluster,
  selectedClusterIdentifier 
}: ClusterTableProps) => {
  const [deleteCluster, setDeleteCluster] = useState<Cluster | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)

  // Filter clusters by search query (identifier or name)
  const filteredClusters = useMemo(() => {
    if (!searchQuery.trim()) return clusters
    const query = searchQuery.toLowerCase().trim()
    return clusters.filter(
      (cluster) =>
        cluster.identifier.toLowerCase().includes(query) ||
        cluster.name.toLowerCase().includes(query)
    )
  }, [clusters, searchQuery])

  // Pagination calculations
  const totalPages = Math.ceil(filteredClusters.length / pageSize)
  const startIndex = (currentPage - 1) * pageSize
  const endIndex = startIndex + pageSize
  const paginatedClusters = filteredClusters.slice(startIndex, endIndex)

  // Reset to first page when search query or page size changes
  const handleSearchChange = (value: string) => {
    setSearchQuery(value)
    setCurrentPage(1)
  }

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize)
    setCurrentPage(1)
  }

  const onlineMutation = useDatabaseClusterOnlineMutation({
    onSuccess: () => {
      toast.success('Cluster brought online successfully')
      onRefresh()
    },
    onError: (error) => {
      toast.error(`Failed to bring cluster online: ${error.message}`)
    },
  })

  const offlineMutation = useDatabaseClusterOfflineMutation({
    onSuccess: () => {
      toast.success('Cluster taken offline successfully')
      onRefresh()
    },
    onError: (error) => {
      toast.error(`Failed to take cluster offline: ${error.message}`)
    },
  })

  const deleteMutation = useDatabaseClusterDeleteMutation({
    onSuccess: () => {
      toast.success('Cluster deleted successfully')
      setDeleteCluster(null)
      onRefresh()
    },
    onError: (error) => {
      toast.error(`Failed to delete cluster: ${error.message}`)
    },
  })

  const handleOnline = (cluster: Cluster) => {
    onlineMutation.mutate({
      identifier: cluster.identifier,
    })
  }

  const handleOffline = (cluster: Cluster) => {
    offlineMutation.mutate({
      identifier: cluster.identifier,
    })
  }

  const handleDelete = () => {
    if (!deleteCluster) return

    deleteMutation.mutate({
      identifier: deleteCluster.identifier,
      delete_secret: false,
    })
  }

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'success' | 'warning' | 'destructive'> = {
      online: 'success',
      offline: 'default',
      maintenance: 'warning',
    }
    return (
      <Badge variant={variants[status] || 'default'}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
    )
  }

  const getAuthMethodBadge = (authMethod: string) => {
    return (
      <Badge variant="default">
        {authMethod === 'password' ? 'Password' : 'Secrets Manager'}
      </Badge>
    )
  }

  const getUtilizationColor = (utilization: number) => {
    if (utilization >= 80) return 'text-red-600'
    if (utilization >= 60) return 'text-yellow-600'
    return 'text-green-600'
  }

  return (
    <>
      {/* Search and Add Cluster Header */}
      <div className="flex items-center justify-between mb-4 gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground-light" />
          <Input
            placeholder="Search by identifier or name..."
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button onClick={onAddCluster} icon={<Plus />}>
          Add Cluster
        </Button>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Identifier</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Auth Method</TableHead>
              <TableHead>Utilization</TableHead>
              <TableHead>Capacity</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedClusters.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-foreground-light">
                  {searchQuery
                    ? `No clusters found matching "${searchQuery}"`
                    : 'No clusters found. Add your first cluster to get started.'}
                </TableCell>
              </TableRow>
            ) : (
              paginatedClusters.map((cluster) => (
                <TableRow 
                  key={cluster.id}
                  className={`cursor-pointer hover:bg-surface-100 ${
                    selectedClusterIdentifier === cluster.identifier ? 'bg-surface-200' : ''
                  }`}
                  onClick={() => onSelectCluster?.({ identifier: cluster.identifier, name: cluster.name })}
                >
                  <TableCell className="font-mono text-sm">{cluster.identifier}</TableCell>
                  <TableCell>{cluster.name}</TableCell>
                  <TableCell className="font-mono text-sm">{cluster.host}</TableCell>
                  <TableCell>{cluster.region}</TableCell>
                  <TableCell>{getStatusBadge(cluster.status)}</TableCell>
                  <TableCell>{getAuthMethodBadge(cluster.auth_method)}</TableCell>
                  <TableCell>
                    <span className={getUtilizationColor(cluster.utilization_percentage)}>
                      {cluster.utilization_percentage.toFixed(1)}%
                    </span>
                  </TableCell>
                  <TableCell>
                    {cluster.current_databases} / {cluster.max_databases}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                      {cluster.status === 'offline' ? (
                        <Button
                          type="default"
                          size="tiny"
                          icon={<Play size={14} />}
                          onClick={() => handleOnline(cluster)}
                          loading={onlineMutation.isPending}
                        >
                          Online
                        </Button>
                      ) : (
                        <Button
                          type="default"
                          size="tiny"
                          icon={<Square size={14} />}
                          onClick={() => handleOffline(cluster)}
                          loading={offlineMutation.isPending}
                        >
                          Offline
                        </Button>
                      )}
                      <Button
                        type="danger"
                        size="tiny"
                        icon={<Trash2 size={14} />}
                        onClick={() => setDeleteCluster(cluster)}
                        disabled={cluster.current_databases > 0}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {/* Pagination Controls */}
        {filteredClusters.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-default">
            <div className="flex items-center gap-2 text-sm text-foreground-light">
              <span>Rows per page:</span>
              <select
                value={pageSize}
                onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                className="bg-surface-100 border border-default rounded px-2 py-1 text-sm"
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-foreground-light">
                {startIndex + 1}-{Math.min(endIndex, filteredClusters.length)} of {filteredClusters.length}
                {searchQuery && ` (filtered from ${clusters.length})`}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="default"
                  size="tiny"
                  icon={<ChevronLeft size={16} />}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                />
                <Button
                  type="default"
                  size="tiny"
                  icon={<ChevronRight size={16} />}
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                />
              </div>
            </div>
          </div>
        )}
      </Card>

      <ConfirmationModal
        visible={deleteCluster !== null}
        title="Delete Cluster"
        confirmLabel="Delete"
        confirmLabelLoading="Deleting..."
        onCancel={() => setDeleteCluster(null)}
        onConfirm={handleDelete}
        loading={deleteMutation.isPending}
        alert={{
          title: 'This action cannot be undone',
          description: `Are you sure you want to delete cluster "${deleteCluster?.name}"? This will remove it from management.`,
        }}
      >
        <div className="text-sm text-foreground-light">
          <p>Cluster: {deleteCluster?.identifier}</p>
          <p>Current databases: {deleteCluster?.current_databases}</p>
          {deleteCluster && deleteCluster.current_databases > 0 && (
            <p className="text-red-600 mt-2">
              This cluster has active databases and cannot be deleted.
            </p>
          )}
        </div>
      </ConfirmationModal>
    </>
  )
}
