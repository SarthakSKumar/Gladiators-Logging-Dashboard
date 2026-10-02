export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Same-origin JSON API. State-changing calls carry the CSRF header the server requires. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", "x-requested-with": "fetch" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
    })
  } catch {
    throw new ApiError("Can't reach the server. Check your connection.", 0)
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status)
  return data as T
}

export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body })
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" })
