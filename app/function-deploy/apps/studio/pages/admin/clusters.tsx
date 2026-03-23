/**
 * Database Clusters Admin Page
 * 
 * Independent admin page for managing database clusters
 * Does not depend on organization context
 * Validates: Requirements 12.1, 12.2
 */

import { ClusterManagement } from 'components/interfaces/Organization/ClusterManagement/ClusterManagement'
import DefaultLayout from 'components/layouts/DefaultLayout'
import type { NextPageWithLayout } from 'types'

const AdminClustersPage: NextPageWithLayout = () => {
  return <ClusterManagement />
}

AdminClustersPage.getLayout = (page) => (
  <DefaultLayout headerTitle="Database Clusters">{page}</DefaultLayout>
)

export default AdminClustersPage
