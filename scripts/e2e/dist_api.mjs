// Carregador dos módulos COMPILADOS do pi-extension (`dist/`).
//
// Por que `dist/` e não `src/` via tsx: o e2e precisa do artefato que realmente
// roda na máquina do usuário (a extensão instalada é `dist/`), e o loader do
// tsx entra em deadlock em alguns grafos de importação no Windows. Carregar
// `dist/` também fixa a exigência de que o e2e só passa depois de um build
// limpo — o mesmo que o supervisor faz.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PI_EXT } from "./paths.mjs";

const DIST = join(PI_EXT, "dist");

/** true quando `dist/` existe (isto é, o pi-extension foi compilado). */
export function distBuilt() {
  return existsSync(join(DIST, "index.js"));
}

/** Importa um módulo de `dist/` por caminho relativo, ex. `daemon/id.js`. */
export async function importDist(relativePath) {
  return import(pathToFileURL(join(DIST, relativePath)).href);
}

/**
 * Importa um módulo do SDK do Pi a partir do `node_modules` do pi-extension.
 * O SDK é ESM puro, então `createRequire` não serve — daí o `file://` explícito.
 */
export async function importSdk(relativePath) {
  return import(pathToFileURL(join(PI_EXT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", relativePath)).href);
}

/** Atalho: importa vários de uma vez, na ordem pedida. */
export async function importDistAll(...relativePaths) {
  return Promise.all(relativePaths.map(importDist));
}
