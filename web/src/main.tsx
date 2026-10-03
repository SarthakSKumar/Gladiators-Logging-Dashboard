import "./index.css"
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "react-router"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ApiError } from "@/lib/api"
import { notifyError } from "@/lib/notify"
import { router } from "@/router"

const isAuthError = (e: unknown) => e instanceof ApiError && e.status === 401

// Failed API calls surface as (deduplicated) toasts. 401 is handled by the route guards instead.
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (isAuthError(error) || query.meta?.silent) return
      if (query.state.data !== undefined) notifyError("Couldn’t refresh data", error.message) // background refresh failed
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _v, _c, mutation) => {
      if (isAuthError(error)) return window.location.replace("/login")
      if (!mutation.meta?.silent) notifyError(error.message)
    },
  }),
  defaultOptions: {
    queries: { retry: (n, e) => !isAuthError(e) && n < 2, refetchOnWindowFocus: true, staleTime: 5_000 },
  },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={250}>
        <RouterProvider router={router} />
        <Toaster position="bottom-right" closeButton />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)
