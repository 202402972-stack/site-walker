// In-process single worker, concurrency 1 — plan §6/§8.1.
// Queue depth 3 else BUSY. 10 jobs/hour per session.
import { config } from "../config.js";

type Runner = () => Promise<void>;

const running = { current: false };
const queue: { id: string; run: Runner }[] = [];
const perSession = new Map<string, number[]>();

export function queueDepth(): number {
  return queue.length;
}

export function isBusy(): boolean {
  return running.current || queue.length >= 3;
}

export function hourlyAllowed(session: string): boolean {
  const now = Date.now();
  const arr = (perSession.get(session) ?? []).filter((t) => now - t < 3600 * 1000);
  perSession.set(session, arr);
  return arr.length < 10;
}

export function recordEnqueue(session: string): void {
  const arr = perSession.get(session) ?? [];
  arr.push(Date.now());
  perSession.set(session, arr);
}

export async function enqueue(id: string, run: Runner): Promise<void> {
  queue.push({ id, run });
  if (running.current) return;
  await drain();
}

async function drain(): Promise<void> {
  if (running.current) return;
  const next = queue.shift();
  if (!next) return;
  running.current = true;
  const timeoutMs = config.MAX_JOB_SECONDS * 1000;
  try {
    await Promise.race([
      next.run(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("MAX_JOB_SECONDS exceeded")), timeoutMs)),
    ]);
  } catch (e) {
    console.error(`[queue] job ${next.id} failed:`, e instanceof Error ? e.message : e);
  } finally {
    running.current = false;
    if (queue.length > 0) await drain();
  }
}
