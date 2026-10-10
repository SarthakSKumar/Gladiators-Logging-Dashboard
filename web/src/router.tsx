import { Loader2, RotateCw } from "lucide-react"
import { Navigate, Outlet, createBrowserRouter } from "react-router"
import { AppShell } from "@/components/app-shell"
import { Button } from "@/components/ui/button"
import { ApiError } from "@/lib/api"
import { LiveProvider } from "@/lib/live"
import { useMe, useStatus } from "@/lib/queries"
import { DashboardPage } from "@/routes/dashboard"
import { LinkPage } from "@/routes/link"
import { LoginPage } from "@/routes/login"
import { SettingsLayout } from "@/routes/settings"
import { GroupsSettings } from "@/routes/settings-groups"
import { LogsSettings } from "@/routes/settings-logs"
import { WhatsAppSettings } from "@/routes/settings-whatsapp"

function FullScreen({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-svh items-center justify-center bg-sidebar p-6 text-center">{children}</div>
}
const Loading = () => (
  <FullScreen>
    <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading" />
  </FullScreen>
)
function LoadError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <FullScreen>
      <div className="grid justify-items-center gap-3">
        <p className="font-medium">Can’t reach the server</p>
        <p className="max-w-sm text-sm text-muted-foreground">{error.message}</p>
        <Button variant="outline" size="sm" onClick={retry}>
          <RotateCw /> Try again
        </Button>
      </div>
    </FullScreen>
  )
}

/** Signed in? Otherwise → /login. Opens the live event stream for everything below. */
function RequireAuth() {
  const me = useMe()
  if (me.isPending) return <Loading />
  if (me.isError) return me.error instanceof ApiError && me.error.status === 401 ? <Navigate to="/login" replace /> : <LoadError error={me.error} retry={() => me.refetch()} />
  return (
    <LiveProvider>
      <Outlet />
    </LiveProvider>
  )
}

/** After sign-in, an unlinked WhatsApp always means the Link page, whatever URL was opened. */
function RequireLinked() {
  const status = useStatus()
  if (status.isPending) return <Loading />
  if (status.isError) return <LoadError error={status.error} retry={() => status.refetch()} />
  if (!status.data.linked) return <Navigate to="/link" replace />
  return <Outlet />
}

function PublicOnly() {
  const me = useMe()
  // only the very first check shows a loader: a later background re-check must not unmount the login form
  if (!me.isFetched) return <Loading />
  if (me.isSuccess) return <Navigate to="/" replace />
  return <Outlet />
}

export const router = createBrowserRouter([
  { element: <PublicOnly />, children: [{ path: "/login", element: <LoginPage /> }] },
  {
    element: <RequireAuth />,
    children: [
      { path: "/link", element: <LinkPage /> },
      {
        element: <RequireLinked />,
        children: [
          {
            element: <AppShell />,
            children: [
              { path: "/", element: <DashboardPage /> },
              {
                path: "/settings",
                element: <SettingsLayout />,
                children: [
                  { index: true, element: <Navigate to="/settings/groups" replace /> },
                  { path: "groups", element: <GroupsSettings /> },
                  { path: "whatsapp", element: <WhatsAppSettings /> },
                  { path: "logs", element: <LogsSettings /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
])
