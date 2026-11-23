/** Test-only scalar observability. BOTH the isolated-build flag and a runtime
 * opt-in set before navigation are required. No auth, tokens, text or raw IDs. */
declare const __REMOTE_PI_HISTORY_TEST_BUILD__: boolean;

type Stage = "request" | "received" | "decoded" | "applied" | "full-page";
type Path = "directory" | "list" | "read";
interface ProbeRecord { atMs: number; sequence: number; path: Path; stage: Stage; requestIdHash: string; count: number; replay: boolean }
const records: ProbeRecord[] = [];
const sources = new Map<string, () => Record<string, number>>();
const counters: Record<string, number> = {};
const LIMIT = 4096;
let dropped = 0;
let nextRecord = 0;
let sequence = 0;
const fullPages: Record<Path, number> = { directory: 0, list: 0, read: 0 };

export function historyProbeEnabled(): boolean {
  return typeof __REMOTE_PI_HISTORY_TEST_BUILD__ !== "undefined" && __REMOTE_PI_HISTORY_TEST_BUILD__ === true &&
    (globalThis as { __REMOTE_PI_HISTORY_TEST_PROBE__?: boolean }).__REMOTE_PI_HISTORY_TEST_PROBE__ === true;
}

/** Noncryptographic, stable correlation only. The CDP helper uses this exact
 * algorithm; neither side exports/retains an unhashed protocol request ID. */
export function historyProbeHash(id: string): string {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < id.length; i++) {
    a = Math.imul(a ^ id.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ id.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

export function historyProbeMark(path: Path, stage: Stage, id: string | undefined, count = 0, replay = false): void {
  if (!historyProbeEnabled() || id === undefined) return;
  const record = { path, stage, requestIdHash: historyProbeHash(id), count, replay, atMs: performance.now(), sequence: ++sequence };
  if (records.length < LIMIT) records.push(record);
  else { records[nextRecord] = record; nextRecord = (nextRecord + 1) % LIMIT; dropped++; }
  if (stage === "full-page") fullPages[path]++;
  const markName = `p87-${path}-${stage}`;
  performance.mark(markName, { detail: { requestIdHash: record.requestIdHash, count, replay } });
  performance.clearMarks(markName);
  expose();
}

export function historyProbeCount(name: "rowProjection" | "rowAttach" | "rowDetach" | "heightBatch" | "markdownMount" | "markdownParse", value = 1): void {
  if (!historyProbeEnabled()) return;
  counters[name] = (counters[name] ?? 0) + value;
}

export function registerHistoryProbeSource(name: "query" | "list" | "viewer" | "markdown", source: () => Record<string, number>): () => void {
  if (!historyProbeEnabled()) return () => {};
  sources.set(name, source);
  expose();
  return () => { if (sources.get(name) === source) sources.delete(name); };
}

function expose(): void {
  const root = globalThis as { __p87History?: unknown };
  if (root.__p87History !== undefined) return;
  root.__p87History = Object.freeze({
    snapshot: () => ({ atMs: performance.now(), records: (records.length < LIMIT ? records : [...records.slice(nextRecord), ...records.slice(0, nextRecord)]).map(r => ({ ...r })), dropped, sequence,
      fullPages: { ...fullPages }, counters: { ...counters }, stats: Object.fromEntries([...sources].map(([name, read]) => [name, read()])) }),
    clear: () => {
      records.length = 0; dropped = 0; nextRecord = 0; sequence = 0;
      for (const key of Object.keys(fullPages) as Path[]) fullPages[key] = 0;
      for (const key of Object.keys(counters)) delete counters[key];
    },
  });
}
