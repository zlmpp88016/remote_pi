/**
 * Session row labels.
 *
 * Regression guard for the bug where every row in one workspace showed the same
 * word. The host's `name` comes from the SDK's `SessionManager.list()` and holds
 * the user-defined display name, which is populated with the WORKSPACE FOLDER
 * NAME — so all 11 sessions of `D:\模型测试\4.1f` arrived as `"name":"4.1f"` and
 * rendered identically. These cases are the measured real shapes.
 *
 * Run: node scripts/verify-session-labels.mjs
 */
import assert from "node:assert/strict";
import { previewText, sessionLabel, sortSessions } from "../src/lib/remote-pi/sessions.ts";

const CWD = "D:\\模型测试\\4.1f";

/** A row exactly as the host sends it for this workspace. */
const row = (over = {}) => ({
  id: "01a14a9e-5dca-7079-9fc8-da221ed24ea4",
  name: "4.1f",
  mtime: 1_760_000_000_000,
  preview: "创建一个HTML，内容是SVG的方式画一个鹈鹕骑车的动画",
  live: false,
  cwd: CWD,
  ...over,
});

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks += 1;
  console.log(`  ok   ${msg}`);
};

// The exact bug: the folder name must never become the title.
{
  const label = sessionLabel(row());
  ok(label !== "4.1f", `folder name is not used as the title (got "${label}")`);
  ok(label.startsWith("创建一个HTML"), "the first message is the title");
}

// Eleven rows in one folder must be mutually distinguishable when their first
// messages differ.
{
  const previews = [
    "创建一个HTML，内容是SVG的方式画一个鹈鹕骑车的动画",
    "在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种",
    "写一个 Rust 版的最小 HTTP 服务器",
  ];
  const labels = previews.map((p, i) => sessionLabel(row({ id: `id-${i}`, preview: p })));
  ok(new Set(labels).size === labels.length, "distinct first messages give distinct labels");
}

// A user-typed display name that is NOT just the folder name still wins: it was
// deliberate, and it is the one thing the SDK means by `name`.
{
  const label = sessionLabel(row({ name: "Pelican animation" }));
  ok(label === "Pelican animation", "a real display name is respected");
}

// Degenerate host: no name at all falls through to the first message, not the id.
{
  const label = sessionLabel(row({ name: undefined }));
  ok(label.startsWith("创建一个HTML"), "missing name falls through to the first message");
}

// Truly empty session: the id prefix is the last resort, and it is stable.
{
  const label = sessionLabel(row({ name: undefined, preview: "" }));
  ok(label === "01a14a9e", `empty session falls back to the id prefix (got "${label}")`);
}

// A huge pasted blob must not become an unbounded label.
{
  const blob = "x".repeat(5000);
  const label = sessionLabel(row({ name: undefined, preview: blob }));
  ok(label.length <= 64, `a pasted blob is truncated (len=${label.length})`);
  ok(label.endsWith("…"), "the truncation is marked with an ellipsis");
}

// Whitespace-only preview is not a title.
{
  const label = sessionLabel(row({ name: undefined, preview: "   \n\t " }));
  ok(label === "01a14a9e", "whitespace-only preview is not treated as text");
}

// `previewText` collapses newlines so the row stays one line.
{
  const p = previewText(row({ preview: "line one\n\n  line two\t" }));
  ok(p === "line one line two", `preview collapses whitespace (got "${p}")`);
}

// POSIX cwd must be understood too, since the host may not be Windows.
{
  const label = sessionLabel(row({ cwd: "/home/me/proj", name: "proj" }));
  ok(label.startsWith("创建一个HTML"), "a POSIX folder name is also rejected as a title");
}

// Ordering still newest-first (unchanged behaviour, pinned so a future label
// change cannot silently reorder rows).
{
  const sorted = sortSessions([row({ id: "a", mtime: 1 }), row({ id: "b", mtime: 3 }), row({ id: "c", mtime: 2 })]);
  ok(sorted.map((s) => s.id).join(",") === "b,c,a", "rows stay newest-first");
}

console.log(`\nverify-session-labels: OK (${checks} checks)`);
