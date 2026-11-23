/**
 * Plan 86 P2 — REAL `worker_threads` transport for BOTH roles.
 *
 * Source mode cannot hand a `.ts` file to `new Worker()` (Node does not apply
 * the vitest/tsx transform inside a worker), so this test compiles the worker
 * entry and its transitive pure modules ONCE into an isolated scratch directory
 * with the already-installed `tsc` — no `dist/` write, no new dependency, no
 * production artifact touched. The service is then pointed at that compiled
 * entry, which is the same code path `dist/` uses.
 *
 * It proves:
 *   - the writer and the read-only reader are TWO real threads (max two);
 *   - list/read are served with zero Pi and the main thread stays free;
 *   - a writer crash is typed and a fresh writer recovers on the next request;
 *   - a reader thread refuses writer messages (role ownership is enforced).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HistoryService } from "./history_service.js";
import {
  createThreadsHistoryPort,
  type HistoryWorkerPortFactory,
} from "./history_worker_client.js";
import type { HistoryWorkerRole } from "./history_worker.js";
import { parseHistoryReply } from "../protocol/history.js";
import {
  makeHistoryFixture,
  userMessage,
  writeTranscript,
  type HistoryFixture,
} from "../../test/history_fixtures.js";
import { sessionDirFor } from "./session_paths.js";

const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
const tscEntry = join(serverRoot, "node_modules", "typescript", "bin", "tsc");

let buildDir = "";
let fixture: HistoryFixture;
let crashScript = "";
const workspaceMap = new Map<string, string>();

beforeAll(() => {
  expect(existsSync(tscEntry), "typescript is already installed (no installs in this task)").toBe(true);
  buildDir = mkdtempSync(join(tmpdir(), "rp86-worker-build-"));
  const result = spawnSync(
    process.execPath,
    [
      tscEntry,
      "--ignoreConfig",
      "--outDir",
      buildDir,
      "--rootDir",
      join(serverRoot, "src"),
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "es2022",
      "--skipLibCheck",
      "--declaration",
      "false",
      "--sourceMap",
      "false",
      "--types",
      "node",
      join(serverRoot, "src", "session", "history_worker_main.ts"),
    ],
    { encoding: "utf8", timeout: 180_000 },
  );
  if (result.status !== 0) {
    throw new Error(`isolated worker build failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  }
  crashScript = join(buildDir, "crash_worker.js");
  writeFileSync(crashScript, "process.exit(7);\n");
  fixture = makeHistoryFixture("rp86-thread-");
  workspaceMap.set("aaaa1111", fixture.cwd);
}, 200_000);

afterAll(() => {
  fixture?.cleanup();
  if (buildDir !== "") {
    try {
      rmSync(buildDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* best-effort */
    }
  }
});

function workerScript(): string {
  return join(buildDir, "session", "history_worker_main.js");
}

function threadedService(
  options: { portFactory?: HistoryWorkerPortFactory; workerScriptPath?: string } = {},
): HistoryService {
  return new HistoryService({
    resolveWorkspace: (daemonId) => {
      const cwd = workspaceMap.get(daemonId);
      return cwd === undefined ? null : { daemon_id: daemonId, cwd, name: "ws" };
    },
    agentRoot: fixture.root,
    remoteHome: `${fixture.root}/remote-home`,
    reconcileIntervalMs: 0,
    ...(options.workerScriptPath !== undefined ? { workerScript: options.workerScriptPath } : {}),
    ...(options.portFactory !== undefined ? { workerPortFactory: options.portFactory } : {}),
    workerTimeoutMs: 20_000,
  });
}

// Production cold work now returns a transient building page promptly. Await
// readiness only where a test needs a prebuilt fixture; preserve typed failures.
async function settledList(service: HistoryService, request: Parameters<HistoryService["list"]>[0], retryRetiringWriter = false) {
  const deadline = Date.now() + 20_000;
  for (let attempt = 0; ; attempt++) {
    const result = await service.list({ ...request, id: request.id + "-" + attempt });
    const building = result.reply.type === "history_list_ok" && result.reply.index_state === "building"
      || result.reply.type === "history_error" && result.reply.code === "building";
    const retiring = retryRetiringWriter && result.reply.type === "history_error" && result.reply.code === "internal";
    if (!building && !retiring) return result;
    if (Date.now() >= deadline) throw new Error("threaded history list stayed building");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe("plan 86 P2 — worker_threads transport (isolated build)", () => {
  test("compiled writer + reader serve list/read on real threads and dispose", async () => {
    writeTranscript(fixture.bucket, {
      id: "s1",
      cwd: fixture.cwd,
      messages: [userMessage("u1", "hello from a thread")],
    });
    const script = workerScript();
    expect(existsSync(script)).toBe(true);

    const service = threadedService({ workerScriptPath: script });
    expect(service.workerMode()).toBe("threads");
    try {
      const listed = await service.list({ type: "history_list", id: "L1", daemon_id: "aaaa1111" });
      expect(listed.reply.type).toBe("history_list_ok");
      expect(listed.metrics.worker_mode).toBe("threads");
      expect(parseHistoryReply(listed.reply).ok).toBe(true);

      expect((await settledList(service, { type: "history_list", id: "ready", daemon_id: "aaaa1111" })).reply).toMatchObject({ index_state: "ready" });
      const read = await service.read({ type: "history_read", id: "R1", daemon_id: "aaaa1111", session_id: "s1" });
      expect(read.reply.type).toBe("history_read_ok");
      if (read.reply.type === "history_read_ok") {
        expect(read.reply.items.map((item) => item.event_id)).toEqual(["u1"]);
      }
    } finally {
      await service.dispose();
    }
  });

  test("a writer crash is typed and a fresh writer recovers on the next request", async () => {
    // Start from an EMPTY index so the first request actually needs the writer.
    rmSync(`${fixture.root}/remote-home`, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    writeTranscript(fixture.bucket, {
      id: "s1",
      cwd: fixture.cwd,
      messages: [userMessage("u1", "recover me")],
    });
    const script = workerScript();
    let writerPorts = 0;
    const portFactory: HistoryWorkerPortFactory = (role: HistoryWorkerRole) => {
      if (role === "writer") {
        writerPorts += 1;
        if (writerPorts === 1) return createThreadsHistoryPort(crashScript, "writer");
      }
      return createThreadsHistoryPort(script, role);
    };
    const service = threadedService({ portFactory });
    try {
      const crashed = await settledList(service, { type: "history_list", id: "L1", daemon_id: "aaaa1111" });
      expect(crashed.reply).toMatchObject({ type: "history_error", code: "internal" });

      const recovered = await settledList(service, { type: "history_list", id: "L2", daemon_id: "aaaa1111" }, true);
      expect(recovered.reply.type).toBe("history_list_ok");
      if (recovered.reply.type === "history_list_ok") {
        expect(recovered.reply.sessions.map((row) => row.id)).toEqual(["s1"]);
      }
      expect(writerPorts).toBeGreaterThanOrEqual(2);
    } finally {
      await service.dispose();
    }
  });

  test("a retired reader does not reject an undispatched read for another session", async () => {
    for (const id of ["retire-a", "open-b"]) {
      writeTranscript(fixture.bucket, {
        id,
        cwd: fixture.cwd,
        messages: [userMessage(id + "-event", id)],
      });
    }
    let readerPorts = 0;
    let old: ReturnType<typeof createThreadsHistoryPort> | undefined;
    let held = false;
    const script = workerScript();
    const service = threadedService({ portFactory(role) {
      const port = createThreadsHistoryPort(script, role);
      if (role !== "reader" || ++readerPorts !== 1) return port;
      old = port;
      // Hold only A at the transport boundary. Worker startup, B's actual
      // disk lookup, exit/terminate events and service reply are not mocked.
      return {
        ...port,
        postMessage(value) {
          if ((value as { session_id?: string }).session_id === "retire-a") {
            held = true;
            return;
          }
          port.postMessage(value);
        },
      };
    } });
    try {
      const list = await settledList(service, { type: "history_list", id: "warm", daemon_id: "aaaa1111" });
      expect(list.reply).toMatchObject({ type: "history_list_ok", index_state: "ready" });
      const a = service.read({ type: "history_read", id: "request-a", daemon_id: "aaaa1111", session_id: "retire-a" });
      expect(held).toBe(true);
      const b = service.read({ type: "history_read", id: "request-b", daemon_id: "aaaa1111", session_id: "open-b" });
      expect(readerPorts).toBe(1);
      await old!.terminate();
      expect((await a).reply).toMatchObject({ type: "history_error", in_reply_to: "request-a" });
      expect((await b).reply).toMatchObject({ type: "history_read_ok", in_reply_to: "request-b",
        session_id: "open-b", items: [{ event_id: "open-b-event" }] });
      expect(readerPorts).toBe(2);
    } finally {
      await service.dispose();
    }
  });

  test("a foreground read stays independent of a bulk cold build", async () => {
    // Workspace A is already indexed; workspace B is a fresh 20 MiB cold build.
    writeTranscript(fixture.bucket, {
      id: "s1",
      cwd: fixture.cwd,
      messages: [userMessage("u1", "already indexed")],
    });
    const cwd2 = join(fixture.root, "ws2");
    const bucket2 = sessionDirFor(cwd2, fixture.root);
    mkdirSync(bucket2, { recursive: true });
    workspaceMap.set("bbbb2222", cwd2);
    const messages = [];
    for (let index = 0; index < 400; index += 1) {
      messages.push(userMessage(`u${index}`, "x".repeat(50 * 1024)));
    }
    writeTranscript(bucket2, { id: "b1", cwd: cwd2, messages });

    const script = workerScript();
    const service = threadedService({ workerScriptPath: script });
    try {
      const listedA = await settledList(service, { type: "history_list", id: "LA", daemon_id: "aaaa1111" });
      expect(listedA.reply).toMatchObject({ type: "history_list_ok", index_state: "ready" });

      const buildingB = service.list({ type: "history_list", id: "LB", daemon_id: "bbbb2222" });
      const started = Date.now();
      const readA = await service.read({
        type: "history_read",
        id: "RA",
        daemon_id: "aaaa1111",
        session_id: "s1",
      });
      const readMs = Date.now() - started;
      expect(readA.reply.type).toBe("history_read_ok");
      if (readA.reply.type === "history_read_ok") {
        expect(readA.reply.items.map((item) => item.event_id)).toEqual(["u1"]);
      }
      // The read must not wait for the bulk build (which takes much longer).
      expect(readMs).toBeLessThan(1000);

      expect((await buildingB).reply).toMatchObject({ type: "history_list_ok", index_state: "building", sessions: [] });
      const coldB = await settledList(service, { type: "history_list", id: "LB-ready", daemon_id: "bbbb2222" });
      expect(coldB.reply.type).toBe("history_list_ok");
      if (coldB.reply.type === "history_list_ok") {
        expect(coldB.reply.sessions.map((row) => row.id)).toEqual(["b1"]);
      }
    } finally {
      await service.dispose();
    }
  }, 60_000);

  test("a reader thread refuses a writer message (role ownership)", async () => {
    const port = createThreadsHistoryPort(workerScript(), "reader");
    try {
      const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker did not reply")), 10_000);
        port.on("message", (value) => {
          clearTimeout(timer);
          resolve(value as Record<string, unknown>);
        });
        port.postMessage({
          id: 1,
          kind: "advance",
          remote_home: `${fixture.root}/remote-home`,
          bucket: fixture.bucket,
          max_files: 4,
          max_bytes: 1024,
        });
      });
      expect(reply["ok"]).toBe(false);
      expect(reply["error"]).toMatchObject({ code: "internal" });
    } finally {
      await port.terminate();
    }
  });

  test("nine 5000-entry Markdown sessions finish default build steps and expose real pages", async () => {
    const largeCwd = join(fixture.root, "large-build-recovery");
    const bucket = sessionDirFor(largeCwd, fixture.root);
    mkdirSync(bucket, { recursive: true });
    workspaceMap.set("cccc3333", largeCwd);
    for (let session = 0; session < 9; session += 1) {
      const messages = Array.from({ length: 5000 }, (_, index) => {
        const prefix = `# Synthetic ${session}/${index}\n\n- item\n\n`;
        const text = prefix + "x".repeat(2560 - Buffer.byteLength(prefix));
        return { id: `entry-${index}`, message: index % 2
          ? { role: "assistant", content: [{ type: "text", text }] }
          : { role: "user", content: text } };
      });
      writeTranscript(bucket, { id: `large-${session}`, cwd: largeCwd, messages });
    }
    // Production defaults, including the unchanged 30s worker deadline and
    // 32MiB multi-file step. This is a functional check, not a benchmark.
    const service = new HistoryService({
      resolveWorkspace: id => id === "cccc3333" ? { daemon_id: id, cwd: largeCwd } : null,
      agentRoot: fixture.root, remoteHome: join(fixture.root, "large-home"),
      workerScript: workerScript(), reconcileIntervalMs: 0,
    });
    try {
      let result = await service.list({ type: "history_list", id: "large-first", daemon_id: "cccc3333" });
      expect(result.reply).toMatchObject({ type: "history_list_ok", index_state: "building", sessions: [] });
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (result.reply.type === "history_list_ok" && result.reply.index_state === "ready") break;
        await new Promise(resolve => setTimeout(resolve, 100));
        result = await service.list({ type: "history_list", id: `large-${attempt}`, daemon_id: "cccc3333" });
        expect(result.reply.type).toBe("history_list_ok");
      }
      expect(result.reply).toMatchObject({ type: "history_list_ok", index_state: "ready" });
      if (result.reply.type !== "history_list_ok") throw new Error("missing list");
      expect(result.reply.sessions).toHaveLength(9);
      for (const session of result.reply.sessions) {
        const head = await service.read({ type: "history_read", id: "large-head", daemon_id: "cccc3333", session_id: session.id, limit: 30 });
        expect(head.reply.type).toBe("history_read_ok");
        if (head.reply.type !== "history_read_ok") throw new Error("missing head");
        expect(head.reply.items).toHaveLength(30);
        expect(head.reply.has_older).toBe(true);
        const older = await service.read({ type: "history_read", id: "large-older", daemon_id: "cccc3333", session_id: session.id,
          limit: 30, before: head.reply.older_cursor!, snapshot: head.reply.snapshot });
        expect(older.reply.type).toBe("history_read_ok");
        if (older.reply.type !== "history_read_ok") throw new Error("missing older");
        expect(older.reply.items).toHaveLength(30);
        const headIds = new Set(head.reply.items.map(item => item.event_id));
        expect(older.reply.items.every(item => !headIds.has(item.event_id))).toBe(true);
      }
    } finally { await service.dispose(); }
  }, 60_000);
});

