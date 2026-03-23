import { Database } from 'lucide-react'
import Link from 'next/link'
import { ButtonTooltip } from 'components/ui/ButtonTooltip'
import { cn } from 'ui'

export const ClusterButton = () => {
  return (
    <Link href="/admin/clusters">
      <ButtonTooltip
        type="outline"
        size="tiny"
        id="cluster-management-trigger"
        className={cn(
          'rounded-full w-[32px] h-[32px] flex items-center justify-center p-0 group'
        )}
        tooltip={{
          content: {
            text: 'Database Clusters',
          },
        }}
      >
        <Database
          size={16}
          strokeWidth={1.5}
          className="text-foreground-light group-hover:text-foreground"
        />
      </ButtonTooltip>
    </Link>
  )
}
