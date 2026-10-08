"use client";

/**
 * Minimal Remote Pi web client (plan 69 W4) — pair → browse → start → chat.
 *
 * Placement: this route lives under the existing `/remote-pi` section and is
 * gated by `NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT=1` (see src/lib/flags.ts). With
 * the flag off it 404s like any unknown route — the marketing surface of the
 * site is untouched until W4/W5 verification goes green.
 *
 * Every wire message comes from PROTOCOL.md via src/lib/remote-pi/*; this file
 * is UI only. Out of scope for W4 (follow-ups, not this task): image upload,
 * session list/switch, model/thinking controls, tool approvals, multi-host.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { notFound } from "next/navigation";

import { isRemotePiWebClientEnabled } from "@/lib/flags";
import { RemotePiWebClient } from "@/lib/remote-pi/client";
import {
  ActionRejectedError,
  parsePairUri,
  type FsEntry,
  type FsListOk,
  type HostHelloOk,
  type PairTarget,
  type ServerMessage,
  type WorkspaceEntry,
  type WorkspaceStartOk,
} from "@/lib/remote-pi/protocol";

const STORAGE_KEY = "remote-pi-web-session-v1";

interface StoredSession {
  relayUrl: string;
  hostEpk: string;
  name: string;
  roomId: string;
  token: string;
}

type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string; done: boolean };

export default function RemotePiConnectPage() {
  if (!isRemotePiWebClientEnabled()) notFound();
  return <ConnectClient />;
}

function ConnectClient() {
  const [phase, setPhase] = useState<"pair" | "host">("pair");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<RemotePiWebClient | null>(null);
  const [hello, setHello] = useState<HostHelloOk | null>(null);
  const [backend, setBackend] = useState<string>("");
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [activeRoom, setActiveRoom] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState("");

  const [fsPath, setFsPath] = useState("~");
  const [fs, setFs] = useState<FsListOk | null>(null);
  const [fsError, setFsError] = useState<string | null>(null);

  const sessionRef = useRef<StoredSession | null>(null);

  const requireClient = useCallback((): RemotePiWebClient => {
    if (!clientRef.current) throw new Error("cliente não inicializado");
    return clientRef.current;
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    const list = await requireClient().listWorkspaces(session.hostEpk, session.roomId);
    setWorkspaces(list.workspaces);
  }, [requireClient]);

  const openChat = useCallback(
    (roomId: string) => {
      setActiveRoom(roomId);
      setChat([]);
    },
    [],
  );

  // Reconnect on load when a previous pairing is stored (persistent code —
  // plan 69: the token survives until --rotate, so no re-pair is needed).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let stored: StoredSession | null = null;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) stored = JSON.parse(raw) as StoredSession;
      } catch {
        stored = null;
      }
      if (!stored || cancelled) return;
      try {
        const client = new RemotePiWebClient({ relayUrl: stored.relayUrl });
        await client.connect();
        if (cancelled) return;
        clientRef.current = client;
        sessionRef.current = stored;
        setBackend(client.backend);
        const helloOk = await client.helloHost(stored.hostEpk, stored.roomId);
        if (cancelled) return;
        setHello(helloOk);
        setPhase("host");
        await refreshWorkspaces();
      } catch {
        // Stale session (relay moved, host rotated) — fall back to pairing.
        localStorage.removeItem(STORAGE_KEY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshWorkspaces]);

  // Chat stream: echo + agent_chunk/agent_done + workspace_state pushes.
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    return client.onServerMessage((msg: ServerMessage) => {
      if (msg.type === "user_message") {
        setChat((prev) => [
          ...prev,
          { kind: "user", id: String(msg.id ?? Math.random()), text: String(msg.text ?? "") },
        ]);
      } else if (msg.type === "agent_chunk") {
        const id = String(msg.in_reply_to ?? "");
        const delta = String(msg.delta ?? "");
        setChat((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "agent" && last.id === id) {
            return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
          }
          return [...prev, { kind: "agent", id, text: delta }];
        });
      } else if (msg.type === "agent_done") {
        const id = String(msg.in_reply_to ?? "");
        setChat((prev) =>
          prev.map((item) => (item.kind === "agent" && item.id === id ? { ...item, text: item.text } : item)),
        );
      }
    });
  }, [phase]);

  async function handlePair(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    let target: PairTarget;
    try {
      target = parsePairUri(code);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    const relayUrl = (address.trim() || target.relayUrl || "").replace(/\/+$/, "");
    if (!relayUrl) {
      setError("informe o endereço do relay (ou use um código com &r=…)");
      return;
    }
    setBusy("conectando…");
    try {
      const client = new RemotePiWebClient({
        relayUrl,
        deviceName: "Remote Pi Web",
      });
      await client.connect();
      clientRef.current = client;
      setBackend(client.backend);
      await client.pair(target);
      const helloOk = await client.helloHost(target.hostEpk, target.roomId);
      sessionRef.current = {
        relayUrl,
        hostEpk: target.hostEpk,
        name: target.name,
        roomId: target.roomId,
        token: target.token,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionRef.current));
      setHello(helloOk);
      setPhase("host");
      await refreshWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleFsList(path: string) {
    const session = sessionRef.current;
    if (!session) return;
    setFsError(null);
    setBusy("listando…");
    try {
      const list = await requireClient().fsList(session.hostEpk, path);
      setFs(list);
      setFsPath(list.path);
    } catch (err) {
      setFs(null);
      setFsError(
        err instanceof ActionRejectedError ? err.code : err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleStart(cwd: string) {
    const session = sessionRef.current;
    if (!session) return;
    setError(null);
    setBusy("iniciando Pi…");
    try {
      const started: WorkspaceStartOk = await requireClient().startWorkspace(session.hostEpk, cwd, session.roomId);
      await refreshWorkspaces();
      openChat(started.room_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function handleSend(event: React.FormEvent) {
    event.preventDefault();
    const session = sessionRef.current;
    const text = draft.trim();
    if (!session || !activeRoom || !text) return;
    requireClient().sendChat(session.hostEpk, activeRoom, text);
    setDraft("");
  }

  function handleReset() {
    localStorage.removeItem(STORAGE_KEY);
    clientRef.current?.close();
    clientRef.current = null;
    sessionRef.current = null;
    setPhase("pair");
    setHello(null);
    setWorkspaces([]);
    setActiveRoom(null);
    setChat([]);
    setFs(null);
    setError(null);
  }

  if (phase === "pair") {
    return (
      <main style={shell}>
        <h1 style={h1}>Conectar a um host</h1>
        <p style={muted}>
          Cole o endereço do relay e o código de pareamento emitido por{" "}
          <code style={mono}>remote-pi pair</code> no host.
        </p>
        <form onSubmit={handlePair} style={{ display: "grid", gap: 12, marginTop: 24 }}>
          <label style={label}>
            Endereço do relay
            <input
              style={input}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="wss://relay.exemplo.com"
              autoComplete="off"
            />
          </label>
          <label style={label}>
            Código de pareamento
            <textarea
              style={{ ...input, minHeight: 72, fontFamily: "var(--font-mono), monospace" }}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="remotepi://pair?t=…&epk=…&n=…"
            />
          </label>
          <button style={button} type="submit" disabled={busy !== null}>
            {busy ?? "Parear"}
          </button>
          {error && <p style={{ ...errorText }}>{error}</p>}
        </form>
      </main>
    );
  }

  return (
    <main style={shell}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ ...h1, fontSize: 22 }}>
          {hello?.daemon.hostname ?? sessionRef.current?.name ?? "host"}
        </h1>
        <span style={{ color: "var(--faint)", fontSize: 13 }}>
          daemon {hello?.daemon.version ?? "?"} · Ed25519: {backend}
          {hello ? ` · ${hello.capabilities.join(", ")}` : ""}
        </span>
        <button style={{ ...button, marginLeft: "auto", padding: "6px 12px" }} onClick={handleReset}>
          Desparear
        </button>
      </header>

      <section style={card}>
        <h2 style={h2}>Workspaces</h2>
        {workspaces.length === 0 && (
          <p style={muted}>Nenhum workspace ainda — navegue o filesystem e inicie um Pi.</p>
        )}
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {workspaces.map((ws) => (
            <li key={ws.room_id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <code style={{ ...mono, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{ws.cwd}</code>
              <span style={{ color: ws.live ? "var(--ok)" : "var(--faint)", fontSize: 12 }}>
                {ws.live ? "live" : "parado"}
              </span>
              <button
                style={{ ...button, padding: "4px 10px" }}
                onClick={() => openChat(ws.room_id)}
                disabled={activeRoom === ws.room_id}
              >
                {activeRoom === ws.room_id ? "aberto" : "chat"}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section style={card}>
        <h2 style={h2}>Filesystem do host</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ ...input, flex: 1 }}
            value={fsPath}
            onChange={(e) => setFsPath(e.target.value)}
            placeholder="~/projetos"
          />
          <button style={{ ...button, padding: "6px 14px" }} onClick={() => handleFsList(fsPath)} disabled={busy !== null}>
            Listar
          </button>
        </div>
        {fsError && <p style={errorText}>{fsError}</p>}
        {fs && (
          <div style={{ marginTop: 12 }}>
            <div style={{ color: "var(--faint)", fontSize: 12, marginBottom: 8 }}>
              {fs.path}
              {fs.parent && (
                <button
                  style={{ ...linkButton, marginLeft: 12 }}
                  onClick={() => handleFsList(fs.parent as string)}
                >
                  ↑ um nível
                </button>
              )}
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
              {fs.entries.map((entry: FsEntry) => (
                <li key={entry.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {entry.kind === "dir" ? (
                    <button style={linkButton} onClick={() => handleFsList(`${fs.path}/${entry.name}`)}>
                      {entry.name}/
                    </button>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>{entry.name}</span>
                  )}
                  {entry.is_repo && <span style={{ color: "var(--faint)", fontSize: 11 }}>repo</span>}
                  {entry.kind === "dir" && (
                    <button
                      style={{ ...button, padding: "2px 8px", fontSize: 12 }}
                      onClick={() => handleStart(`${fs.path}/${entry.name}`)}
                      disabled={busy !== null}
                    >
                      iniciar Pi
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {activeRoom && (
        <section style={card}>
          <h2 style={h2}>Chat</h2>
          <div style={{ display: "grid", gap: 8, maxHeight: 280, overflowY: "auto" }}>
            {chat.map((item, index) => (
              <div
                key={`${item.id}-${index}`}
                style={{
                  justifySelf: item.kind === "user" ? "end" : "start",
                  maxWidth: "80%",
                  padding: "8px 12px",
                  borderRadius: 12,
                  background: item.kind === "user" ? "var(--green-dim)" : "var(--card-2)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {item.text}
              </div>
            ))}
          </div>
          <form onSubmit={handleSend} style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <input
              style={{ ...input, flex: 1 }}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Mensagem para o Pi…"
            />
            <button style={button} type="submit">
              Enviar
            </button>
          </form>
        </section>
      )}

      {busy && <p style={{ ...muted, position: "fixed", bottom: 16, right: 16 }}>{busy}</p>}
      {error && <p style={errorText}>{error}</p>}
    </main>
  );
}

const shell: React.CSSProperties = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "48px 20px 96px",
  display: "grid",
  gap: 20,
};

const h1: React.CSSProperties = { fontSize: 28, margin: 0 };
const h2: React.CSSProperties = { fontSize: 14, margin: "0 0 10px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 };
const card: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-md)",
  padding: 20,
};
const label: React.CSSProperties = { display: "grid", gap: 6, fontSize: 13, color: "var(--muted)" };
const input: React.CSSProperties = {
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: 10,
  padding: "10px 12px",
  color: "var(--ink)",
  fontSize: 14,
};
const button: React.CSSProperties = {
  background: "var(--green)",
  color: "var(--green-ink)",
  border: "none",
  borderRadius: 10,
  padding: "10px 18px",
  fontWeight: 600,
  cursor: "pointer",
};
const linkButton: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--accent)",
  cursor: "pointer",
  padding: 0,
  fontSize: 14,
  textAlign: "left",
};
const mono: React.CSSProperties = { fontFamily: "var(--font-mono), monospace", fontSize: 13 };
const muted: React.CSSProperties = { color: "var(--muted)", fontSize: 14, margin: 0 };
const errorText: React.CSSProperties = { color: "#ff8a8a", fontSize: 14, margin: 0 };
