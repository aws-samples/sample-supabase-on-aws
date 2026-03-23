/**
 * Database Clusters Page
 * 
 * Organization-level page for managing database clusters
 * Validates: Requirements 12.1, 12.2
 */

import { ClusterManagement } from 'components/interfaces/Organization/ClusterManagement/ClusterManagement'
import DefaultLayout from 'components/layouts/DefaultLayout'
import OrganizationLayout from 'components/layouts/OrganizationLayout'
import OrganizationSettingsLayout from 'components/layouts/ProjectLayout/OrganizationSettingsLayout'
import { usePermissionsQuery } from 'data/permissions/permissions-query'
import { useSelectedOrganizationQuery } from 'hooks/misc/useSelectedOrganization'
import type { NextPageWithLayout } from 'types'
import { LogoLoader } from 'ui'

const OrgClustersPage: NextPageWithLayout = () => {
  const { isPending: isLoadingPermissions } = usePermissionsQuery()
  const { data: selectedOrganization } = useSelectedOrganizationQuery()

  return (
    <>
      {selectedOrganization === undefined && isLoadingPermissions ? (
        <LogoLoader />
      ) : (
        <ClusterManagement />
      )}
    </>
  )
}

OrgClustersPage.getLayout = (page) => (
  <DefaultLayout>
    <OrganizationLayout>
      <OrganizationSettingsLayout>{page}</OrganizationSettingsLayout>
    </OrganizationLayout>
  </DefaultLayout>
)

export default OrgClustersPage
