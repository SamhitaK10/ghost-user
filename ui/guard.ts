/** Request guard for the local UI: blocks DNS-rebinding (Host check) and cross-site POSTs (Origin check). */
export function isAllowedRequest(headers: { host?: string; origin?: string }, method: string, port: number): boolean {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!headers.host || !hosts.has(headers.host.toLowerCase())) return false;
  if (method !== "GET" && method !== "HEAD") {
    if (!headers.origin) return false; // browsers always send Origin on cross-site POST; require it for state changes
    try {
      if (!hosts.has(new URL(headers.origin).host.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  return true;
}
