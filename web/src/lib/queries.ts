import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, del, post } from "./api"
import type { AccountGroup, Diagnostics, Kpis, Me, MessagesPage, OpEvent, Session, Status } from "./types"

export const keys = {
  me: ["me"] as const,
  status: ["status"] as const,
  kpis: ["kpis"] as const,
  sessions: (groupId: number) => ["sessions", groupId] as const,
  messages: (sessionId: number) => ["messages", sessionId] as const,
  accountGroups: ["account-groups"] as const,
  events: ["events"] as const,
  diagnostics: ["diagnostics"] as const,
}

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api<Me>("/api/auth/me"), retry: false, staleTime: 60_000 })
// status is pushed over SSE; the query is the initial load + a slow safety refresh
export const useStatus = () => useQuery({ queryKey: keys.status, queryFn: () => api<Status>("/api/status"), refetchInterval: 30_000 })
export const useKpis = () => useQuery({ queryKey: keys.kpis, queryFn: () => api<Kpis>("/api/kpis"), refetchInterval: 60_000 })
export const useSessions = (groupId: number | null) =>
  useQuery({ queryKey: keys.sessions(groupId ?? 0), queryFn: () => api<Session[]>(`/api/sessions?group=${groupId}`), enabled: groupId != null })
export const useMessages = (sessionId: number | null) =>
  useQuery({
    queryKey: keys.messages(sessionId ?? 0),
    queryFn: () => api<MessagesPage>(`/api/messages?session=${sessionId}&limit=500`),
    enabled: sessionId != null,
    placeholderData: keepPreviousData,
  })
export const useAccountGroups = () =>
  useQuery({ queryKey: keys.accountGroups, queryFn: () => api<{ groups: AccountGroup[]; fetchedAt: number | null }>("/api/wa/groups") })
export const useEvents = () => useQuery({ queryKey: keys.events, queryFn: () => api<OpEvent[]>("/api/events?limit=300") })
export const useDiagnostics = (enabled = true) =>
  useQuery({ queryKey: keys.diagnostics, queryFn: () => api<Diagnostics>("/api/diagnostics"), enabled, refetchInterval: 10_000 })

/** Mutations refresh status (the SSE push follows anyway) and surface errors as toasts (QueryClient config). */
const useInvalidate = () => {
  const qc = useQueryClient()
  return (...ks: readonly (readonly unknown[])[]) => Promise.all(ks.map((k) => qc.invalidateQueries({ queryKey: k })))
}

export const useStartLogging = () => {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: (v: { groupId: number; label: string; raceNumber: number | null }) => post<Session>("/api/sessions", v),
    onSuccess: (s) => inv(keys.status, keys.kpis, keys.sessions(s.group_id)),
  })
}
export const useStopLogging = () => {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: (sessionId: number) => post<Session>(`/api/sessions/${sessionId}/stop`),
    onSuccess: (s) => inv(keys.status, keys.kpis, keys.sessions(s.group_id)),
  })
}
export const useRefreshAccountGroups = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => post<{ groups: AccountGroup[]; fetchedAt: number }>("/api/wa/groups/refresh"),
    onSuccess: (d) => qc.setQueryData(keys.accountGroups, d),
  })
}
export const useAddGroup = () => {
  const inv = useInvalidate()
  return useMutation({ mutationFn: (jid: string) => post("/api/groups", { jid }), onSuccess: () => inv(keys.accountGroups, keys.status, keys.kpis) })
}
export const useRemoveGroup = () => {
  const inv = useInvalidate()
  return useMutation({ mutationFn: (id: number) => del(`/api/groups/${id}`), onSuccess: () => inv(keys.accountGroups, keys.status, keys.kpis) })
}
export const useLink = () => {
  const inv = useInvalidate()
  return useMutation({ mutationFn: () => post("/api/wa/link"), onSuccess: () => inv(keys.status) })
}
export const useRestartConnection = () => {
  const inv = useInvalidate()
  return useMutation({ mutationFn: () => post("/api/wa/restart"), onSuccess: () => inv(keys.status) })
}
export const useUnlink = () => {
  const inv = useInvalidate()
  return useMutation({ mutationFn: () => post("/api/wa/unlink", { confirm: "UNLINK" }), onSuccess: () => inv(keys.status, keys.kpis) })
}
export const useSignOut = () =>
  useMutation({
    mutationFn: () => post("/api/auth/logout"),
    onSettled: () => window.location.replace("/login"),
  })
