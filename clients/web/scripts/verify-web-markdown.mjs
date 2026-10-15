/**
 * Markdown rendering policy verification (plan: agent replies render as
 * Markdown).
 *
 * The rendering itself is a React component and is verified in the browser
 * (a real reply carrying `<script>`/`onerror`/`javascript:` markup was rendered
 * and asserted inert). What Node CAN and SHOULD pin down is the security rule
 * that makes that safe, plus the raw-HTML stance of the two libraries.
 *
 * Two layers:
 *   1. `isSafeHref` — the link protocol allowlist (real module).
 *   2. react-markdown's DEFAULT behavior with our options — no `rehype-raw`,
 *      so raw HTML is escaped to text and `javascript:`/`data:` targets are
 *      stripped. Asserted on the produced HTML string, so a future option
 *      change that enables raw HTML fails here.
 *
 * Run: node scripts/verify-web-markdown.mjs
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { isSafeHref } from "../src/lib/remote-pi/markdown-links.ts";

let checks = 0;
let failures = 0;
function check(label, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. the link policy ──────────────────────────────────────────────────────

function linkPolicy() {
  console.log("\n== 1. política de links (isSafeHref) ==");
  check("https é permitido", isSafeHref("https://example.com/a?b=1"));
  check("http é permitido", isSafeHref("http://example.com"));
  check("mailto é permitido", isSafeHref("mailto:dev@example.com"));
  check("javascript: é recusado", !isSafeHref("javascript:alert(1)"));
  check(
    "javascript: com maiúsculas/espaço é recusado",
    !isSafeHref("JaVaScRiPt:alert(1)") && !isSafeHref(" javascript:alert(1)"),
  );
  check("data: é recusado", !isSafeHref("data:text/html,<script>alert(1)</script>"));
  check("vbscript: é recusado", !isSafeHref("vbscript:msgbox(1)"));
  check("file: é recusado", !isSafeHref("file:///etc/passwd"));
  check("caminho relativo é recusado", !isSafeHref("/remote-pi/docs"));
  check("âncora é recusada", !isSafeHref("#section"));
  check("relativo sem barra é recusado", !isSafeHref("docs/page"));
  check("string vazia é recusada", !isSafeHref(""));
  check("apenas espaços é recusado", !isSafeHref("   "));
  check("undefined é recusado", !isSafeHref(undefined));
}

// ── 2. react-markdown defaults with our options ─────────────────────────────

/** Render like the component does: GFM, and NO rehype-raw. */
function render(md) {
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, md),
  );
}

function rawHtmlStance() {
  console.log("\n== 2. HTML bruto NÃO é interpretado (sem rehype-raw) ==");
  const script = render("Hi <script>alert(1)</script> there");
  check("script bruto vira texto escapado", script.includes("&lt;script&gt;") && !script.includes("<script>"), script);
  const img = render('<img src=x onerror="alert(1)">');
  check("img/onerror vira texto escapado", img.includes("&lt;img") && !img.includes("<img"), img);
  const div = render('<div class="evil">boxed</div>');
  check("div bruto não vira elemento", !div.includes("<div") || div.includes("&lt;div"), div);
  const iframe = render('<iframe src="https://evil.example"></iframe>');
  check("iframe bruto não vira elemento", iframe.includes("&lt;iframe"), iframe);

  console.log("\n== 2b. links perigosos são neutralizados na saída ==");
  const js = render("[click](javascript:alert(1))");
  check("javascript: não aparece como href executável", !/href="javascript:/i.test(js), js);
  check("o TEXTO do link perigoso sobrevive", js.includes("click"), js);
  const data = render("[x](data:text/html,<b>hi</b>)");
  check("data: não aparece como href", !/href="data:/i.test(data), data);
  const okLink = render("[ok](https://example.com)");
  check("link https mantém o href", okLink.includes('href="https://example.com"'), okLink);
}

function richRendering() {
  console.log("\n== 3. markdown rico renderiza ==");
  check("cabeçalho", /<h[12]>/.test(render("# Título")));
  check("negrito", render("**bold**").includes("<strong>"));
  check("itálico", render("*it*").includes("<em>"));
  check("código inline", render("use `npm run build`").includes("<code>"));
  check("bloco de código", render("```js\nconst a = 1;\n```").includes("<pre>"));
  check(
    "o código preserva < e > como TEXTO",
    render("```\na < b && c > d\n```").includes("a &lt; b &amp;&amp; c &gt; d"),
    render("```\na < b && c > d\n```"),
  );
  check("lista não ordenada", render("- um\n- dois").includes("<ul>"));
  check("lista ordenada", render("1. um\n2. dois").includes("<ol>"));
  check("tabela GFM", render("| a | b |\n|---|---|\n| 1 | 2 |").includes("<table>"));
  check("blockquote", render("> cite").includes("<blockquote>"));
  check("linha horizontal", render("---").includes("<hr"));
}

// ── run ─────────────────────────────────────────────────────────────────────

linkPolicy();
rawHtmlStance();
richRendering();

console.log(`\n${checks - failures}/${checks} checks PASS`);
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("verify-web-markdown: OK");
