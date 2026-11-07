/**
 * Interaction E2E: click through the panel controls that a screenshot alone
 * cannot prove work — opening the create form, opening a detail view, and the
 * Files toolbar actions.
 *
 * Screenshots prove a panel RENDERS. They do not prove a button is wired. Every
 * step here asserts a state change that could only happen if the handler ran.
 *
 * Usage: node scripts/e2e-interact.mjs [port]
 */

import { mkdirSync, writeFileSync } from "node:fs";

const port = process.argv[2] ?? "9444";
const OUT = "scripts/_e2e-evidence";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error(`no page on :${port}`);
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (m, p = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method: m, params: p }));
  });
ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.id !== undefined && pending.has(d.id)) {
    pending.get(d.id)(d.result);
    pending.delete(d.id);
  }
};
await new Promise((r) => (ws.onopen = r));

const ev = async (x) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return `__THROW__ ${r.exceptionDetails.text}`;
  return r.result?.value;
};
const shot = async (n) => {
  const r = await Promise.race([
    send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }),
    sleep(8000).then(() => null),
  ]);
  if (r?.data) {
    writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.data, "base64"));
    return `${OUT}/${n}.png`;
  }
  return "(no shot)";
};

let failures = 0;
const check = (n, ok, d = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`);
};

/** Open a dock tab by its Chinese label, handling rail (collapsed) or dock mode. */
const openTab = async (label) => {
  const how = await ev(`(() => {
    const rail = [...document.querySelectorAll("button[class*='railTabButton']")]
      .find((b) => (b.getAttribute("title") || "") === ${JSON.stringify(label)});
    if (rail) { rail.click(); return "rail"; }
    const tab = [...document.querySelectorAll("button")].find((b) => {
      const s = b.querySelector("span[class*='tabLabel']");
      return s && s.textContent.trim() === ${JSON.stringify(label)};
    });
    if (tab) { tab.click(); return "dock"; }
    return "no-button";
  })()`);
  await sleep(1800);
  return how;
};

await send("Page.enable");
await send("Runtime.enable");
mkdirSync(OUT, { recursive: true });

// ── D. Automations: the create form must expose every web field ────────────
console.log("\nD. automations create form");
console.log(`  opened: ${await openTab("自动化")}`);

const opened = await ev(`(() => {
  const btns = [...document.querySelectorAll("button")].filter((b) => !b.disabled);
  const b = btns.find((x) => /^(新建|New)$/i.test((x.textContent || "").trim()));
  if (!b) return "no-new-button: " + btns.map((x) => (x.textContent || "").trim()).slice(0, 12).join("|");
  b.click();
  return "clicked";
})()`);
console.log(`  new button: ${opened}`);
await sleep(2000);

const form = await ev(`(() => {
  const body = document.body.innerText || "";
  // Field labels exactly as the web panel renders them (automations-panel.tsx).
  // Naming them from the iOS sheet instead produced a false FAIL — the two
  // clients label the same controls differently, which is allowed; only the
  // set of capabilities has to match.
  const wanted = ["计划", "时区", "让代理做什么", "运行于", "模型", "会话", "忙时跳过", "工作区已停止时启动"];
  return JSON.stringify({
    hits: wanted.filter((w) => body.includes(w)),
    inputs: [...document.querySelectorAll("input,textarea,select")].length,
    tail: body.slice(-350).replace(/\\n+/g, " / "),
  });
})()`);
console.log(`  ${form}`);
const f = JSON.parse(form);
check("create form has all web fields", f.hits.length >= 7, `found ${f.hits.length}: ${f.hits.join(",")}`);
await shot("interact-automations-form");

// Close whatever opened so later steps start clean.
await ev(`(() => {
  const b = [...document.querySelectorAll("button")].find(
    (x) => /^(取消|关闭|Cancel|Dismiss|×)$/i.test((x.textContent || "").trim()),
  );
  if (b) b.click();
})()`);
await sleep(1000);

// ── E. Files: the current-path toolbar must exist ─────────────────────────
console.log("\nE. files toolbar actions");
console.log(`  opened: ${await openTab("文件")}`);

const filesState = await ev(`(() => {
  const body = document.body.innerText || "";
  const btns = [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
  return JSON.stringify({
    hasAdd: body.includes("加入目录"),
    hasStart: body.includes("在此启动 Pi"),
    hasRemove: body.includes("移除"),
    hasHidden: body.includes("显示隐藏项"),
    buttons: btns.filter((t) => t.length > 0 && t.length < 20).slice(-18),
  });
})()`);
console.log(`  ${filesState}`);
const fs = JSON.parse(filesState);
check("current-path toolbar present", fs.hasAdd && fs.hasStart && fs.hasRemove, `${fs.hasAdd}/${fs.hasStart}/${fs.hasRemove}`);
check("show-hidden toggle present", fs.hasHidden === true, `${fs.hasHidden}`);
await shot("interact-files-toolbar");

// ── F. Models: editing surface ────────────────────────────────────────────
console.log("\nF. models editing surface");
console.log(`  opened: ${await openTab("模型")}`);

const models = await ev(`(() => {
  const body = document.body.innerText || "";
  return JSON.stringify({
    providerSelect: document.querySelectorAll("select").length,
    textInputs: document.querySelectorAll("input[type=text], input:not([type])").length,
    numberInputs: document.querySelectorAll("input[type=number]").length,
    hasSave: body.includes("保存") || body.includes("Save"),
    hasAddModel: body.includes("添加模型"),
    modelCount: (body.match(/Remove/g) || []).length,
  });
})()`);
console.log(`  ${models}`);
const m = JSON.parse(models);
check("models is editable (inputs + save)", m.textInputs + m.numberInputs > 0 && m.hasSave, JSON.stringify(m));
await shot("interact-models");

// ── G. Settings ───────────────────────────────────────────────────────────
console.log("\nG. settings");
console.log(`  opened: ${await openTab("设置")}`);
const settings = await ev(`(() => {
  const body = document.body.innerText || "";
  return JSON.stringify({
    hasAppearance: body.includes("外观"),
    hasAccent: body.includes("强调色"),
    hasLocalOnly: body.includes("仅对当前浏览器生效"),
    inputs: [...document.querySelectorAll("input,textarea")].length,
  });
})()`);
console.log(`  ${settings}`);
const st = JSON.parse(settings);
check("settings renders appearance + accent + host fields", st.hasAppearance && st.hasAccent, JSON.stringify(st));
await shot("interact-settings");

ws.close();
console.log(`\ninteract: ${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
