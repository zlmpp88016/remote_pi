// Descoberta do Flutter, cross-platform.
//
// Mesma lista de candidatos que `scripts/screenshots.sh` já usa: o `flutter`
// costuma não estar no PATH no Windows (só existe em D:/flutter/bin). Ficamos
// com a lógica num só lugar, para o verify e os screenshots não divergirem.

import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { capture } from "./run.mjs";

const WINDOWS = process.platform === "win32";

/** Nomes executáveis possíveis, por plataforma. */
function candidates(binDir) {
  return WINDOWS
    ? [join(binDir, "flutter.bat"), join(binDir, "flutter")]
    : [join(binDir, "flutter")];
}

/**
 * Devolve `{ command, env }` para chamar o Flutter, ou `null` quando não achou.
 * `command` pode ser um caminho absoluto (não depende de PATH).
 */
export async function findFlutter() {
  // 1. Já está no PATH?
  const inPath = await capture(WINDOWS ? "where" : "which", ["flutter"]);
  if (inPath.code === 0 && inPath.stdout.trim()) {
    return { command: WINDOWS ? "flutter.bat" : "flutter", env: {} };
  }

  // 2. Locais conhecidos.
  const roots = [
    "D:/flutter/bin",
    "C:/flutter/bin",
    "D:/src/flutter/bin",
    "C:/src/flutter/bin",
    join(homedir(), "flutter", "bin"),
  ];
  // `FLUTTER_ROOT` (usado pelo tooling do Flutter) também vale.
  if (process.env.FLUTTER_ROOT) roots.unshift(join(process.env.FLUTTER_ROOT, "bin"));

  for (const binDir of roots) {
    for (const exe of candidates(binDir)) {
      if (existsSync(exe)) {
        return {
          command: exe,
          env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
        };
      }
    }
  }
  return null;
}

/** Mensagem de erro única para quando o Flutter não é encontrado. */
export const FLUTTER_NOT_FOUND_HELP = [
  "Nao achei o flutter.",
  "Procurei no PATH e em: D:/flutter/bin, C:/flutter/bin, D:/src/flutter/bin, ~/flutter/bin.",
  "Defina FLUTTER_ROOT ou acrescente o bin do SDK ao PATH, ex.:",
  '  export PATH="/d/flutter/bin:$PATH"',
].join("\n");
