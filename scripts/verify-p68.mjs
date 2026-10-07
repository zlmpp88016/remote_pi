#!/usr/bin/env node
// verify-p68 — a cadeia de aceite do plan/68.
//
// Uso:
//   node scripts/verify-p68.mjs unit     # typecheck + suítes dos dois projetos
//   node scripts/verify-p68.mjs e2e      # cadeia ponta a ponta (relay stub local)
//   node scripts/verify-p68.mjs visual   # PNGs das telas (inclui as novas)
//   node scripts/verify-p68.mjs          # unit + e2e + visual, em ordem
//
// Por que um runner e não um Makefile: os três modos precisam do MESMO conjunto
// de descobertas (flutter fora do PATH no Windows, `pnpm` global quebrado →
// `npx -y pnpm@10`) e de mensagens de erro claras quando falta um pré-requisito.
// Concentrar isso aqui evita que cada comando de aceite invente a sua.
//
// Saída: cada modo imprime PASS/FAIL por alvo; o exit code é 1 se qualquer alvo
// falhar. Nenhum modo usa cargo/docker (não existem nesta máquina).

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { APP, PI_EXT, missingPrerequisites } from "./e2e/paths.mjs";
import { run } from "./e2e/run.mjs";
import { findFlutter, FLUTTER_NOT_FOUND_HELP } from "./e2e/flutter.mjs";

const MODES = ["unit", "e2e", "visual"];

/** `pnpm` global está quebrado nesta máquina; o pin via npx é o caminho. */
const PNPM = ["npx", "-y", "pnpm@10"];

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function banner(title) {
  console.log(`\n${"─".repeat(64)}\n${title}\n${"─".repeat(64)}`);
}

/** Roda um comando herdando stdio; devolve true se saiu 0. */
async function step(name, command, args, options = {}) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const { code, error } = await run(command, args, options);
  const ok = code === 0 && !error;
  record(name, ok, error ? String(error.message) : `exit=${code}`);
  return ok;
}

async function requireFlutter() {
  const flutter = await findFlutter();
  if (!flutter) {
    console.error(`\n${FLUTTER_NOT_FOUND_HELP}`);
    process.exit(2);
  }
  return flutter;
}

/** Checa o mínimo para qualquer modo rodar. */
function checkPrerequisites() {
  const missing = missingPrerequisites();
  if (missing.length > 0) {
    console.error("Pré-requisitos ausentes:");
    for (const m of missing) console.error(`  - ${m}`);
    console.error("Rode `npx -y pnpm@10 install` em pi-extension/ primeiro.");
    process.exit(2);
  }
}

// ── unit ─────────────────────────────────────────────────────────────────────

async function unit() {
  banner("unit — pi-extension (typecheck + vitest)");
  await step("pi-extension: tsc --noEmit", PNPM[0], [...PNPM.slice(1), "exec", "tsc", "--noEmit"], { cwd: PI_EXT });
  await step("pi-extension: vitest run", PNPM[0], [...PNPM.slice(1), "exec", "vitest", "run"], { cwd: PI_EXT });

  banner("unit — app (analyze + flutter test)");
  const flutter = await requireFlutter();
  await step("app: flutter analyze", flutter.command, ["analyze"], { cwd: APP, env: flutter.env });
  await step("app: flutter test", flutter.command, ["test"], { cwd: APP, env: flutter.env });
}

// ── e2e ──────────────────────────────────────────────────────────────────────

async function e2e() {
  banner("e2e — cadeia completa (relay stub local, offline)");
  // O harness carrega `dist/` (o artefato que roda na máquina do usuário), então
  // o e2e exige um build limpo antes — igual ao supervisor.
  const built = await step(
    "e2e: build do pi-extension (dist/)",
    PNPM[0],
    [...PNPM.slice(1), "exec", "tsc"],
    { cwd: PI_EXT },
  );
  if (!built) {
    record("e2e: cadeia completa", false, "build falhou — sem dist/ não há e2e");
    return;
  }

  const { runE2E } = await import("./e2e/plan68.mjs");
  const e2eResults = await runE2E({
    log: (name, ok, detail = "") =>
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`),
  });
  const failed = e2eResults.filter((r) => !r.ok);
  record(
    "e2e: cadeia completa",
    failed.length === 0,
    `${e2eResults.length - failed.length}/${e2eResults.length} passos`,
  );
}

// ── visual ───────────────────────────────────────────────────────────────────

/** As telas novas que o plan/68 exige em PNG. */
const NEW_SHOTS = ["workspace-browser-iphone", "pi-surface-iphone"];

async function visual() {
  banner("visual — PNGs das telas (inclui as novas do plan/68)");
  const flutter = await requireFlutter();

  const shotsDir = join(APP, "build", "screenshots");
  const stage = join(APP, "test", "screenshots", "build", "screenshots");

  // Por que isto não chama `scripts/screenshots.sh`: o comando de aceite roda
  // sob o shell do sistema (cmd.exe no Windows), e ali `bash` pode resolver para
  // um bash diferente do Git Bash — que come as contrabarras de um caminho
  // `D:\...` e transforma o script em `D:workspacegit_repo...` (exit 127). A
  // aceitação não pode depender de qual bash o PATH aponta, então a lógica do
  // script está replicada aqui em Node. O `.sh` continua existindo para uso
  // manual; as duas versões fazem o mesmo.
  rmSync(stage, { recursive: true, force: true });
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });

  const ok = await step(
    "visual: renderizar telas",
    flutter.command,
    [
      "test",
      "test/screenshots/screenshots_test.dart",
      "--dart-define=SCREENSHOTS=true",
      "--update-goldens",
    ],
    { cwd: APP, env: flutter.env },
  );
  if (!ok) {
    record("visual: telas novas existem", false, "a renderização falhou");
    return;
  }

  // O golden escreve relativo ao arquivo de teste; move para o caminho estável.
  if (existsSync(stage)) {
    for (const name of readdirSync(stage)) {
      if (name.endsWith(".png")) {
        renameSync(join(stage, name), join(shotsDir, name));
      }
    }
    rmSync(join(APP, "test", "screenshots", "build"), { recursive: true, force: true });
  }

  const missing = NEW_SHOTS.filter((id) => !existsSync(join(shotsDir, `${id}.png`)));
  const count = existsSync(shotsDir)
    ? readdirSync(shotsDir).filter((n) => n.endsWith(".png")).length
    : 0;
  record(
    "visual: telas novas existem",
    missing.length === 0,
    missing.length ? `faltando: ${missing.join(", ")}` : `${count} PNG(s) em app/build/screenshots`,
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log("uso: node scripts/verify-p68.mjs [unit|e2e|visual]...");
  console.log("sem argumento roda os três, nesta ordem.");
  process.exit(0);
}

const unknown = requested.filter((m) => !MODES.includes(m));
if (unknown.length > 0) {
  console.error(`modo desconhecido: ${unknown.join(", ")} (use: ${MODES.join(" | ")})`);
  process.exit(2);
}

const modes = requested.length > 0 ? requested : MODES;
checkPrerequisites();

for (const mode of modes) {
  if (mode === "unit") await unit();
  else if (mode === "e2e") await e2e();
  else if (mode === "visual") await visual();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(64)}`);
console.log(`verify-p68 ${modes.join("+")}: ${results.length - failed.length}/${results.length} passaram`);
if (failed.length > 0) {
  console.log("\nFalhas:");
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length ? 1 : 0);
