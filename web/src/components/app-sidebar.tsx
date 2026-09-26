import { LayoutDashboard, LogOut, MoreHorizontal, Settings } from "lucide-react"
import { NavLink, useLocation } from "react-router"
import { Mark } from "@/components/brand"
import { Dot } from "@/components/status"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLive } from "@/lib/live"
import { useMe, useSignOut } from "@/lib/queries"

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("")

function NavItem({ to, icon: Icon, label }: { to: string; icon: typeof Settings; label: string }) {
  const { pathname } = useLocation()
  const active = to === "/" ? pathname === "/" : pathname.startsWith(to)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={label}>
        <NavLink to={to}>
          <Icon />
          <span>{label}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function UserMenu() {
  const me = useMe().data
  const { online } = useLive()
  const signOut = useSignOut()
  const name = me?.name || me?.email || ""
  return (
    <SidebarMenuItem>
      <div className="group/user flex items-center gap-2 rounded-md p-1.5 group-data-[collapsible=icon]:p-0 hover:bg-sidebar-accent/60 focus-within:bg-sidebar-accent/60 transition-colors">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="relative flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label="Account menu"
          >
            {initials(name) || "?"}
            <span className="absolute -right-0.5 -bottom-0.5 hidden rounded-full bg-sidebar p-0.5 group-data-[collapsible=icon]:block">
              <Dot tone={online ? "live" : "error"} />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="w-56">
            <DropdownMenuLabel className="grid font-normal">
              <span className="truncate font-medium">{me?.name}</span>
              <span className="truncate text-xs text-muted-foreground">{me?.email}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => signOut.mutate()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
          <span className="truncate text-sm font-medium">{me?.name || "—"}</span>
          <span className="truncate text-xs text-muted-foreground">{me?.email}</span>
        </div>
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="More"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity group-hover/user:opacity-100 hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end">
              <DropdownMenuItem onSelect={() => signOut.mutate()}>
                <LogOut /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} aria-label={online ? "Server live" : "Server unreachable"} className="flex size-5 items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                <Dot tone={online ? "live" : "error"} ping={online} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">{online ? "Server live" : "Server unreachable"}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </SidebarMenuItem>
  )
}

export function AppSidebar() {
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="hover:bg-transparent active:bg-transparent">
              <NavLink to="/" aria-label="Gladiators — Dashboard">
                <Mark className="size-8 group-data-[collapsible=icon]:size-8" />
                <div className="grid leading-tight">
                  <span className="text-[15px] font-semibold tracking-tight">Gladiators</span>
                  <span className="text-xs text-muted-foreground">Bet logger</span>
                </div>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <NavItem to="/" icon={LayoutDashboard} label="Dashboard" />
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <NavItem to="/settings" icon={Settings} label="Settings" />
          <UserMenu />
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
