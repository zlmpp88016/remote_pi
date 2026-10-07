import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DecodeError, decodeServer, encodeClient } from "./codec.js";

const fixtureDir = fileURLToPath(
  new URL("../../../.orchestration/contracts/fixtures", import.meta.url),
);

const SERVER_TYPE_FILES = new Set([
  "pair_ok.jsonl",
  "pair_error.jsonl",
  "user_input.jsonl",
  "agent_stream.jsonl",
  "agent_message.jsonl",
  "tool_request.jsonl",
  "tool_result.jsonl",
  "error.jsonl",
  "cancelled.jsonl",
  "pong.jsonl",
  "bye.jsonl",
  "session_history.jsonl",
  // Plan 01 — runtime status + session tree/branching replies.
  "runtime_status.jsonl",
  "tree_snapshot.jsonl",
  "tree_navigate.jsonl",
  "session_fork.jsonl",
  "session_clone.jsonl",
]);

describe("fixtures", () => {
  const files = readdirSync(fixtureDir).filter((f) => f.endsWith(".jsonl"));

  test("36 fixture files present", () => {
    expect(files).toHaveLength(36);
  });

  for (const file of files) {
    test(file, () => {
      const lines = readFileSync(`${fixtureDir}/${file}`, "utf8")
        .split("\n")
        .filter(Boolean);

      for (const line of lines) {
        if (SERVER_TYPE_FILES.has(file)) {
          const msg = decodeServer(line);
          expect(msg).toHaveProperty("type");
        } else {
          // client-only fixture — must throw unsupported_type, not invalid_message
          let caught: unknown;
          try {
            decodeServer(line);
          } catch (e) {
            caught = e;
          }
          expect(caught).toBeInstanceOf(DecodeError);
          expect((caught as DecodeError).code).toBe("unsupported_type");
        }
      }
    });
  }
});

describe("rejects junk", () => {
  test("invalid JSON → DecodeError invalid_message", () => {
    let err: unknown;
    try {
      decodeServer("not json {{{");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).code).toBe("invalid_message");
  });

  test("missing type field → DecodeError invalid_message", () => {
    let err: unknown;
    try {
      decodeServer('{"foo":1}');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).code).toBe("invalid_message");
    expect((err as DecodeError).message).toMatch(/missing 'type'/);
  });

  test("unknown type → DecodeError unsupported_type", () => {
    let err: unknown;
    try {
      decodeServer('{"type":"made_up"}');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).code).toBe("unsupported_type");
    expect((err as DecodeError).message).toMatch(/unknown type/);
  });
});

describe("encodeClient roundtrip", () => {
  test("ping", () => {
    const msg = { type: "ping" as const, id: "018f9c2a" };
    const encoded = encodeClient(msg);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(JSON.parse(encoded.trim())).toEqual(msg);
  });

  test("user_message", () => {
    const msg = { type: "user_message" as const, id: "018f9c2a", text: "hello" };
    expect(JSON.parse(encodeClient(msg).trim())).toEqual(msg);
  });

  test("user_message with steer streaming behavior", () => {
    const msg = {
      type: "user_message" as const,
      id: "018f9c2a",
      text: "refine this",
      streaming_behavior: "steer" as const,
    };
    expect(JSON.parse(encodeClient(msg).trim())).toEqual(msg);
  });

  // Plan/68 — host filesystem navigation + explicit workspace catalog.
  test("fs_list / workspace_add / workspace_remove", () => {
    const msgs = [
      { type: "fs_list" as const, id: "018f9c2a", path: "~/ws", show_hidden: true },
      { type: "workspace_add" as const, id: "018f9c2b", path: "/abs/ws" },
      { type: "workspace_remove" as const, id: "018f9c2c", path: "/abs/ws" },
    ];
    for (const msg of msgs) {
      expect(JSON.parse(encodeClient(msg).trim())).toEqual(msg);
    }
  });
});

describe("plan/68 — server types decode", () => {
  test("fs_list_ok decodes", () => {
    const line = JSON.stringify({
      type: "fs_list_ok",
      in_reply_to: "018f9c2a",
      path: "/abs/ws",
      parent: "/abs",
      entries: [{ name: "remote_pi", kind: "dir", is_repo: true }],
    });
    const msg = decodeServer(line);
    expect(msg.type).toBe("fs_list_ok");
    if (msg.type !== "fs_list_ok") throw new Error("wrong type");
    expect(msg.entries[0]?.is_repo).toBe(true);
  });

  test("action_ok / action_error decode with the plan/68 actions", () => {
    for (const action of ["fs_list", "workspace_add", "workspace_remove"] as const) {
      const ok = decodeServer(JSON.stringify({ type: "action_ok", in_reply_to: "x", action }));
      expect(ok.type).toBe("action_ok");
      const err = decodeServer(JSON.stringify({ type: "action_error", in_reply_to: "x", action, error: "not_found" }));
      expect(err.type).toBe("action_error");
    }
  });
});

describe("plan/68 — Pi surface types", () => {
  test("pi_surface / skill_invoke / skill_set_enabled / package_* encode", () => {
    const msgs = [
      { type: "pi_surface" as const, id: "018f9c30" },
      { type: "skill_invoke" as const, id: "018f9c31", name: "pdf-tools", args: "extract report.pdf" },
      { type: "skill_set_enabled" as const, id: "018f9c32", name: "pdf-tools", enabled: false },
      {
        type: "package_install" as const,
        id: "018f9c33",
        source: "npm:@example/pi-tools@1.0.0",
        scope: "user" as const,
        confirm_third_party: true,
      },
      { type: "package_remove" as const, id: "018f9c34", source: "npm:@example/pi-tools@1.0.0" },
      { type: "package_update" as const, id: "018f9c35" },
    ];
    for (const msg of msgs) {
      expect(JSON.parse(encodeClient(msg).trim())).toEqual(msg);
    }
  });

  test("pi_surface_ok decodes with runtime, skills and packages", () => {
    const line = JSON.stringify({
      type: "pi_surface_ok",
      in_reply_to: "018f9c30",
      runtime: { running: true, model: "anthropic/claude-opus-4-7", thinking: "medium" },
      skills: [
        {
          name: "pdf-tools",
          description: "Extract text from PDFs",
          source: "user",
          path: "/home/me/.pi/agent/skills/pdf-tools/SKILL.md",
          enabled: true,
          disable_model_invocation: false,
        },
      ],
      packages: [{ source: "npm:@example/pi-tools@1.0.0", scope: "user", resources: ["skills"] }],
    });
    const msg = decodeServer(line);
    expect(msg.type).toBe("pi_surface_ok");
    if (msg.type !== "pi_surface_ok") throw new Error("wrong type");
    expect(msg.runtime.running).toBe(true);
    expect(msg.skills[0]?.source).toBe("user");
    expect(msg.packages[0]?.resources).toEqual(["skills"]);
  });

  test("pi_surface_ok tolerates null runtime fields (never fabricated)", () => {
    const msg = decodeServer(
      JSON.stringify({
        type: "pi_surface_ok",
        in_reply_to: "x",
        runtime: { running: false, model: null, thinking: null },
        skills: [],
        packages: [],
      }),
    );
    expect(msg.type).toBe("pi_surface_ok");
    if (msg.type !== "pi_surface_ok") throw new Error("wrong type");
    expect(msg.runtime.model).toBeNull();
    expect(msg.runtime.thinking).toBeNull();
  });

  test("skill_invoke_ok / skill_set_enabled_ok / package_op_ok decode", () => {
    const invoke = decodeServer(
      JSON.stringify({ type: "skill_invoke_ok", in_reply_to: "x", name: "pdf-tools" }),
    );
    expect(invoke.type).toBe("skill_invoke_ok");

    const toggled = decodeServer(
      JSON.stringify({ type: "skill_set_enabled_ok", in_reply_to: "x", name: "pdf-tools", enabled: false }),
    );
    expect(toggled.type).toBe("skill_set_enabled_ok");

    const op = decodeServer(
      JSON.stringify({
        type: "package_op_ok",
        in_reply_to: "x",
        op: "install",
        source: "npm:@example/pi-tools@1.0.0",
        scope: "user",
      }),
    );
    expect(op.type).toBe("package_op_ok");
    if (op.type !== "package_op_ok") throw new Error("wrong type");
    expect(op.op).toBe("install");
  });

  test("package_op_ok decode with scope: null (update reconciles all)", () => {
    const op = decodeServer(
      JSON.stringify({ type: "package_op_ok", in_reply_to: "x", op: "update", source: "", scope: null }),
    );
    expect(op.type).toBe("package_op_ok");
    if (op.type !== "package_op_ok") throw new Error("wrong type");
    expect(op.scope).toBeNull();
  });
});
