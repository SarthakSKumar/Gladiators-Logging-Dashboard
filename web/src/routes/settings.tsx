import { Outlet, useLocation, useNavigate } from "react-router"
import { PageHeader } from "@/components/app-shell"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

const TABS = [
  { value: "groups", label: "Groups" },
  { value: "whatsapp", label: "WhatsApp link" },
  { value: "logs", label: "Logs" },
]

export function SettingsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const current = TABS.find((t) => pathname.startsWith(`/settings/${t.value}`))?.value ?? "groups"
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 md:px-8 md:py-8">
      <PageHeader title="Settings" description="Groups to log, the WhatsApp link, and capture logs." />
      <Tabs value={current} onValueChange={(v) => navigate(`/settings/${v}`)}>
        <TabsList variant="line" className="w-full justify-start border-b pb-1">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="flex-none px-3">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Outlet />
    </div>
  )
}
