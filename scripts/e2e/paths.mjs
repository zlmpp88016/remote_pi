// Caminhos e isolamento compartilhados pelo harness e2e do plan/68.
//
// Por que existe: os scripts vivem em `scripts/` na raiz do monorepo, mas os
// módulos que eles precisam resolvem de dentro de `pi-extension/` (é lá que
// está o `node_modules` com `ws`). Ancorar os caminhos aqui deixa o harness na
// raiz sem duplicar dependências nem depender do cwd de quem chamou.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PI_EXT = join(ROOT, "pi-extension");
export const APP = join(ROOT, "app");

/**
 * `require` ancorado no pi-extension. O `ws` que o relay stub usa mora no
 * `node_modules` do pi-extension; resolver daqui evita um `node_modules`
 * duplicado só para o harness.
 */
export const requireFromPiExtension = createRequire(join(PI_EXT, "package.json"));

/**
 * Home descartável para o e2e: o pi-extension lê `~/.pi/remote/*` (identidade,
 * peers, catálogos). Apontar HOME (POSIX) e USERPROFILE (Windows) para um
 * tmpdir isola o teste da máquina do usuário; `REMOTE_PI_HOME` cobre os stores
 * que já leem esse override.
 */
export function isolateHome({ mkdtempSync, mkdirSync, tmpdir }) {
  const home = mkdtempSync(join(tmpdir(), "pi-e2e-home-"));
  mkdirSync(join(home, ".pi", "remote"), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.REMOTE_PI_HOME = home;
  return home;
}

/** Pré-requisitos do harness — o verify usa isso para falhar cedo e claro. */
export function missingPrerequisites() {
  const missing = [];
  if (!existsSync(join(PI_EXT, "src", "index.ts"))) missing.push("pi-extension/src/index.ts");
  if (!existsSync(join(PI_EXT, "node_modules", "ws"))) missing.push("pi-extension/node_modules/ws");
  return missing;
}
