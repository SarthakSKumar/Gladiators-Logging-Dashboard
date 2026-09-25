import { Smartphone } from "lucide-react"
import { Outlet } from "react-router"
import { AppSidebar } from "@/components/app-sidebar"
import { CaptureBadge } from "@/components/status"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { useStatus } from "@/lib/queries"

function TopBar() {
  const status = useStatus().data
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <div className="ml-auto flex min-w-0 items-center gap-3">
        {status ? (
          <>
            {status.me && (
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <Smartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate font-medium">{status.me.name || "WhatsApp"}</span>
                <span className="hidden text-muted-foreground tabular-nums sm:inline">{status.me.number}</span>
              </div>
            )}
            <CaptureBadge capture={status.capture} />
          </>
        ) : (
          <Skeleton className="h-6 w-48" />
        )}
      </div>
    </header>
  )
}

export function AppShell() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <TopBar />
        <div className="flex-1 overflow-x-hidden">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

/** Page title block: clear but not oversized; description muted. */
export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  )
}
