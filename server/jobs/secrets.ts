// In-memory password vault — plan §8/§9.3 (login feature).
//
// Passwords live here ONLY: never in Job objects, never in job.json on disk,
// never in log events, never in ZIPs. The map entry is deleted the moment the
// login step takes it (takePassword), and again defensively when the job ends.
// A server restart wipes the whole map, so orphaned jobs can never resurrect
// credentials — runJob continues without auth and logs login.skipped.
const vault = new Map<string, string>();

export function stashPassword(id: string, password: string): void {
  vault.set(id, password);
}

/** Returns the password and deletes it — single use. */
export function takePassword(id: string): string | undefined {
  const pw = vault.get(id);
  vault.delete(id);
  return pw;
}

export function dropPassword(id: string): void {
  vault.delete(id);
}
