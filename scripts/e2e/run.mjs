// Runner de um comando externo, com saída transmitida ao vivo.
//
// Por que não `execSync`: os alvos do `verify` (vitest, flutter test) levam
// minutos e imprimem progresso. Transmitir ao vivo mostra onde travou; guardar
// em buffer e imprimir no fim esconde um hang atrás de uma tela parada.

import { spawn } from "node:child_process";

/**
 * No Windows, `spawn` recusa um `.bat`/`.cmd` direto (EINVAL) desde o Node 18
 * por segurança — precisa de `shell: true` para o cmd.exe interpretá-lo. Os
 * valores de `args` aqui são simples (subcomandos do flutter), então não há
 * risco de injeção; o `shell` só é ligado quando o alvo é um shim.
 */
function needsShell(command, shell) {
  if (shell) return true;
  return process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
}

/**
 * Roda `command args...` no `cwd`, herdando stdio (o usuário vê a saída real).
 * Resolve com `{ code, signal }` — nunca lança por exit code não-zero, para o
 * chamador decidir o que fazer.
 */
export function run(command, args, { cwd, env, shell = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: needsShell(command, shell),
      env: { ...process.env, ...env },
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", (err) => {
      resolve({ code: null, signal: null, error: err });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

/** Igual a `run`, mas captura a saída (para checagens de versão/descoberta). */
export function capture(command, args, { cwd, env, shell = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: needsShell(command, shell),
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => { stdout += c.toString(); });
    child.stderr?.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (err) => resolve({ code: null, stdout, stderr, error: err }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
