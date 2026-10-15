#!/usr/bin/env node
/**
 * rename-monorepo.mjs — reestrutura o monorepo por ondas, sem quebrar nada.
 *
 *   server/  →  server/
 *   app/        →  clients/mobile/     (+ pacote Dart app      → mobile)
 *   cockpit/    →  clients/desktop/    (+ pacote Dart cockpit  → desktop,
 *                                        e os 7 pacotes cockpit_* → desktop_*)
 *   site/       →  clients/web/
 *
 * Por que um script: são milhares de referências (745 imports `package:app/`,
 * 2344 `package:cockpit/`) e a operação precisa ser atômica por onda
 * (git mv + reescritas na mesma passada). Histórico é excluído de propósito —
 * ele dizia o que era verdade quando foi escrito e não pode ser falsificado.
 *
 * Uso:
 *   node scripts/rename-monorepo.mjs --phase <fase>            # DRY-RUN (default)
 *   node scripts/rename-monorepo.mjs --phase <fase> --apply    # escreve
 *   node scripts/rename-monorepo.mjs --all --dry-run
 *
 * Fases: server | clients | dart-packages | refs
 * Pré-condições verificadas: o diretório a mover não pode ser cwd de processo
 * vivo (Windows trava o rename) — sonda `renameSync` ida-e-volta.
 *
 * ── Dois falsos-positivos perigosos que este script evita ─────────────────
 * 1. `./remote-pi/connect/...` dentro de `site/src/app/page.tsx` é uma rota
 *    LOCAL do site, não o diretório do repo. Regra: todo match com prefixo
 *    relativo (`./`, `../`) é RESOLVIDO contra o diretório do arquivo; só
 *    reescreve se cair exatamente no diretório-alvo do repo.
 * 2. `'app/auth/session.ts'` em testes é DADO de fixture, não referência.
 *    Regra: literal de string em arquivo de teste = fixture (não reescreve);
 *    comentário em arquivo de teste = referência real (reescreve).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const APPLY = process.argv.includes("--apply");
const DRY = !APPLY;
const PHASE = valueOf("--phase");
const ALL = process.argv.includes("--all");

function valueOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

/** Histórico e artefatos gerados: NÃO se reescrevem. */
const EXCLUDE_PREFIXES = ["plan/", ".workflow/", ".orchestration/", "review/", "docs/plan/", ".git/"];
const EXCLUDE_SEGMENTS = ["/build/", "/.next/", "/.dart_tool/", "/dist/", "/node_modules/"];
const EXCLUDE_SUFFIX = ["CHANGELOG.md"];

/**
 * Pacotes Dart internos, do MAIS LONGO para o mais curto — ordem obrigatória,
 * senão `package:cockpit_server/` viraria `package:desktop_server/` errado se
 * `cockpit` fosse substituído antes.
 */
const DART_PACKAGES = [
  ["app", "mobile"],
  ["cockpit_keepawake", "desktop_keepawake"],
  ["cockpit_protocol", "desktop_protocol"],
  ["cockpit_engine", "desktop_engine"],
  ["cockpit_remote", "desktop_remote"],
  ["cockpit_server", "desktop_server"],
  ["cockpit_core", "desktop_core"],
  ["cockpit_pty", "desktop_pty"],
  ["cockpit", "desktop"],
];

/** Diretórios que mudam de lugar (fase `clients`). */
const CLIENT_MOVES = [
  ["app", "clients/mobile"],
  ["cockpit", "clients/desktop"],
  ["site", "clients/web"],
];

/**
 * Refs relativas cuja PROFUNDIDADE muda quando o diretório que as contém é
 * movido para dentro de `clients/`. Resolvidas e corrigidas explicitamente.
 * (Uma ref relativa ao repo depende do nº de hops até a raiz; mover `site/`
 * para `clients/web/` adiciona um nível.)
 */
const DEPTH_FIXES = [
  // arquivo (pós-move) : [antes, depois]
  //
  // Exatamente UMA entrada por alvo: uma segunda entrada genérica para
  // `../../server/` voltaria a casar dentro de `../../../server/` (que a contém
  // como substring) e corromperia o caminho. `sync-install-sh.mjs` vive em
  // `site/scripts/`, então `../../` chega à raiz; em `clients/web/scripts/`
  // passa a ser preciso `../../../`.
  //
  // IDEMPOTÊNCIA: a checagem usa a forma EXATA (com barra final). Sem isso, uma
  // segunda execução prepende mais um `../` a cada rodada — foi o que produziu
  // `../../../../../../server/` (6 níveis) numa re-execução.
  {
    file: "clients/web/scripts/sync-install-sh.mjs",
    from: '"../../server/install.sh"',
    to: '"../../../server/install.sh"',
  },
];

// ── infra ────────────────────────────────────────────────────────────────

function excluded(rel) {
  const n = rel.replaceAll("\\", "/");
  if (EXCLUDE_PREFIXES.some((p) => n === p || n.startsWith(p))) return true;
  if (EXCLUDE_SEGMENTS.some((s) => n.includes(s))) return true;
  if (EXCLUDE_SUFFIX.some((s) => n.endsWith(s))) return true;
  return false;
}

const relOf = (f) => relative(ROOT, join(ROOT, f)).replaceAll("\\", "/");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts });
}

const SELF = "scripts/rename-monorepo.mjs";

function liveFiles(pattern, { fixed = false, regex = false } = {}) {
  try {
    const flag = fixed ? ["-F"] : ["-E"];
    return git(["grep", "-l", ...flag, pattern])
      .split("\n").map((s) => s.trim()).filter(Boolean).map(relOf)
      .filter((r) => !excluded(r) && r !== SELF);
  } catch {
    return []; // git grep sai 1 quando não há match
  }
  void regex;
}

/** Âncora: início de linha ou um delimitador de token (nunca `/`, para não
 *  casar `lib/app/` nem `node_modules/remote-pi/`). */
const ANCHOR = `(?:^|[\\s"'\`(=,\\[|])`;

function pathRefRe(dirName) {
  return new RegExp(`${ANCHOR}((?:\\.\\.?/)*)${escapeRe(dirName)}/`, "g");
}

/**
 * Referência apoiada numa VARIÁVEL de raiz:
 *
 *   "$GITHUB_WORKSPACE/cockpit/out/..."
 *   "$root/server/dist/index.js"
 *
 * A âncora normal não pega (o que precede é `/`), então sem esta forma dois
 * caminhos reais ficavam para trás — falso-negativo encontrado por varredura.
 */
function varRootedRe(dirName) {
  return new RegExp(
    `(\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?/)((?:\\.\\.?/)*)${escapeRe(dirName)}/`,
    "g",
  );
}

/**
 * Correções EXPLÍCITAS para referências que dependem do cwd do shell (logo, não
 * são relativas ao arquivo) ou que vivem num contexto que o texto não revela.
 * Cada entrada: [arquivo, antes, depois]. A varredura de completude no fim
 * falha se sobrar qualquer referência não justificada.
 */
const EXPLICIT_FIXES = [
  // `cd release` antes destas linhas: o cwd é o diretório de artefatos, então
  // `../cockpit/` aponta para a raiz do job (working-directory: clients/desktop).
  [".github/workflows/cockpit-release.yml", "../cockpit/CHANGELOG.md", "../clients/desktop/CHANGELOG.md"],
  [".github/workflows/cockpit-release.yml", "../cockpit/packaging/", "../clients/desktop/packaging/"],
  // Referências relativas entre IRMÃOS: `cockpit/` e `app/` ficavam lado a lado
  // na raiz; agora são `clients/desktop/` e `clients/mobile/`, então o `../`
  // sozinho deixa de alcançar o vizinho (viraria `clients/app/`). Achadas pelo
  // portão de completude, não por leitura manual.
  ["clients/desktop/2.0-roadmap.kanban", "../app/android", "../mobile/android"],
  ["clients/desktop/android/settings.gradle.kts", "../app/android", "../mobile/android"],
  // Este resolvia para o PRÓPRIO diretório (`docs/../cockpit/docs` = `cockpit/docs`).
  // Com o novo layout o caminho relativo passa a apontar para lugar nenhum;
  // o schema está ao lado deste arquivo.
  ["clients/desktop/docs/tasks-json.md", "../cockpit/docs/tasks.schema.json", "./tasks.schema.json"],
];

/**
 * Referência BARE (sem barra final), só onde o contexto é inequivocamente um
 * caminho. Existem formas reais no repo que não têm barra:
 *
 *   defaults: { run: { working-directory: app } }        (YAML)
 *   cd cockpit && flutter build                          (shell)
 *
 * Substituir `\bapp\b` globalmente seria errado (`app` é palavra comum, e
 * `lib/app/` é caminho interno). Por isso os prefixos-introdutores abaixo são
 * uma lista explícita, não um padrão genérico.
 */
const BARE_REF_PREFIXES = ["working-directory:", "cd ", "--directory ", "-C "];

function bareRefRe(dirName) {
  const prefix = BARE_REF_PREFIXES.map(escapeRe).join("|");
  return new RegExp(
    `((?:${prefix})\\s*["']?)((?:\\.\\.?/)*)${escapeRe(dirName)}(?![\\w./-])`,
    "g",
  );
}

/**
 * Alvo de link markdown: `](./app)`, `](../cockpit)`, `[label](app/)`.
 *
 * A âncora normal NÃO pega porque o caractere anterior é `/` (do `./`) ou `(`.
 * Pego por inspeção: os LABELS foram reescritos mas os TARGETS ficaram
 * apontando para o diretório antigo — link quebrado silencioso.
 */
function mdLinkTargetRe(dirName) {
  // Em string normal, `\\.` vira `\.` (ponto literal). Usar template literal
  // aqui multiplica as barras e transforma o ponto em "qualquer char" — bug
  // real que fez o alvo do link não ser reescrito.
  return new RegExp(`(\\]\\((?:\\.{0,2}/)?)${escapeRe(dirName)}(?=[/)#\\s]|$)`, "g");
}

// ── classificadores ──────────────────────────────────────────────────────

function isTestFile(rel) {
  const n = rel.replace("\\", "/");
  return (
    /(^|\/)(test|tests)\//.test(n) ||
    /_test\.[a-z]+$/.test(n) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(n)
  );
}

/** Match dentro de um literal de string, em arquivo de teste = dado de fixture. */
/** Estado de comentário de bloco ao fim desta linha, a partir do estado atual. */
function nextBlockCommentState(line, inBlock) {
  let open = inBlock;
  let i = 0;
  while (i < line.length) {
    if (open) {
      const end = line.indexOf("*/", i);
      if (end === -1) return true;
      open = false;
      i = end + 2;
      continue;
    }
    const start = line.indexOf("/*", i);
    const slash = line.indexOf("//", i);
    if (slash !== -1 && (start === -1 || slash < start)) return false; // resto é comentário de linha
    if (start === -1) return false;
    open = true;
    i = start + 2;
  }
  return open;
}

/**
 * Posição está dentro de um literal de string?
 *
 * Escaneia a linha rastreando aspas (com escape) até `pos`. É preciso escanear
 * de verdade: contar aspas não funciona quando uma delas vem da linha anterior.
 */
function inStringAt(line, pos) {
  let open = null;
  let escaped = false;
  for (let i = 0; i < pos && i < line.length; i += 1) {
    const c = line[i];
    if (escaped) {
      escaped = false;
    } else if (c === "\\") {
      escaped = true;
    } else if (open) {
      if (c === open) open = null;
    } else if (c === '"' || c === "'" || c === "`") {
      open = c;
    }
  }
  return open !== null;
}

/** Posição está depois de um `//` que não está dentro de string? */
function inLineComment(line, pos) {
  let open = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (open) {
      if (c === open) open = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      open = c;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") return pos >= i;
  }
  return false;
}

/**
 * O match é DADO de fixture (não uma referência ao diretório do repo)?
 *
 * A distinção é comentário vs código, não “tem aspas”:
 *   _linkAt('app/lib/config/dependencies.dart')   → código, string → fixture
 *   // `server/src/protocol/types.ts`          → comentário → referência real
 *
 * A versão anterior contava aspas na linha e errava nos dois sentidos: uma
 * aspa desbalanceada vinda da linha de cima fazia um comentário passar por
 * fixture (referência real era perdida).
 */
function isFixtureLiteral(rel, line, offset, anchorLen, inBlockComment) {
  if (!isTestFile(rel)) return false;
  if (inBlockComment || inLineComment(line, offset)) return false; // prosa = referência real
  return inStringAt(line, offset + anchorLen);
}

/** Prefixo relativo só conta se resolver no diretório-alvo do repo. */
function resolvesToRepoDir(absFile, prefix, dirName) {
  if (!prefix) return true; // sem prefixo = caminho relativo à raiz, por convenção
  return resolve(dirname(absFile), prefix + dirName) === resolve(ROOT, dirName);
}

// ── reescrita ancorada ───────────────────────────────────────────────────

function rewriteAnchored(rel, dirName, replacement) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return { changed: 0, skipped: 0 };
  const text = readFileSync(abs, "utf8");
  const re = pathRefRe(dirName);
  const bare = bareRefRe(dirName);
  const vr = varRootedRe(dirName);
  const md = mdLinkTargetRe(dirName);
  let changed = 0;
  let skipped = 0;
  let inBlockComment = false;

  const after = text
    .split("\n")
    .map((line) => {
      const wasInBlock = inBlockComment;
      // Rastrear `/* ... */` entre linhas: em Dart/TS um `///` é linha, mas um
      // bloco aberto na linha anterior também é prosa.
      inBlockComment = nextBlockCommentState(line, inBlockComment);
      // (a) forma com barra: `app/...`, `clients/mobile/...`
      if (re.test(line)) {
        re.lastIndex = 0;
        line = line.replace(re, (full, prefix, offset) => {
          // full = âncora + prefixo + `dir/`  →  comprimento da âncora:
          const anchorLen = full.length - prefix.length - dirName.length - 1;
          if (!resolvesToRepoDir(abs, prefix, dirName)) {
            skipped += 1;
            return full; // ex.: ./remote-pi/connect/... (rota local do site)
          }
          if (isFixtureLiteral(rel, line, offset, anchorLen, wasInBlock)) {
            skipped += 1;
            return full; // ex.: 'app/auth/session.ts' (dado de teste)
          }
          changed += 1;
          return `${full.slice(0, full.length - `${dirName}/`.length)}${replacement}/`;
        });
      }
      // (b) forma bare (`working-directory: app`, `cd cockpit`)
      if (bare.test(line)) {
        bare.lastIndex = 0;
        line = line.replace(bare, (full, head) => {
          if (isFixtureLiteral(rel, line, full.length - 1, 1, wasInBlock)) {
            skipped += 1;
            return full;
          }
          changed += 1;
          return `${head}${replacement}`;
        });
      }
      // (c) apoiada em variável de raiz (`$GITHUB_WORKSPACE/app/...`)
      if (vr.test(line)) {
        vr.lastIndex = 0;
        line = line.replace(vr, (full, head) => {
          changed += 1;
          return `${head}${replacement}/`;
        });
      }
      // (d) alvo de link markdown: `](./app)` → `](./clients/mobile)`
      if (md.test(line)) {
        md.lastIndex = 0;
        line = line.replace(md, (_full, head) => {
          changed += 1;
          return `${head}${replacement}`;
        });
      }
      return line;
    })
    .join("\n");

  if (changed && !DRY) writeFileSync(abs, after);
  return { changed, skipped };
}

function applyDirRename(dirName, replacement, label) {
  // A lista de candidatos NÃO pode depender de `dirName + "/"`: formas reais não
  // têm barra (`](./cockpit)`, `working-directory: cockpit`) e escapariam da
  // varredura — bug real que deixou os alvos de link markdown apontando para o
  // diretório antigo enquanto os LABELS já tinham sido atualizados.
  const files = liveFiles(escapeRe(dirName), { regex: true });
  let changed = 0;
  let skipped = 0;
  for (const rel of files) {
    const r = rewriteAnchored(rel, dirName, replacement);
    if (r.changed) {
      changed += 1;
      console.log(`  ~ ${rel}  (${r.changed})`);
    }
    skipped += r.skipped;
  }
  console.log(`  · ${label ?? `${dirName}/ → ${replacement}/`}: ${changed} arquivo(s)${skipped ? `, ${skipped} ocorrência(s) preservada(s)` : ""}`);
}

/** Troca um token simples em todo o repo (ex.: `package:app/`). */
function replaceToken(from, to) {
  const files = liveFiles(from, { fixed: true });
  let total = 0;
  for (const rel of files) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const before = readFileSync(abs, "utf8");
    const n = before.split(from).length - 1;
    if (!n) continue;
    if (!DRY) writeFileSync(abs, before.replaceAll(from, to));
    total += n;
  }
  return total;
}

// ── sonda de travamento ──────────────────────────────────────────────────

function gitMove(from, to) {
  // DRY-RUN nunca move: `git mv` sem esta guarda renomeia de verdade (só trocar
  // o `stdio` não impede a execução) — bug real, pego por inspeção.
  if (DRY) {
    console.log(`  > (dry-run) git mv ${from} ${to}`);
    return;
  }
  // Origem ausente: a onda já foi aplicada.
  if (!existsSync(join(ROOT, from))) {
    console.log(`  > ${from} já movido — pulando`);
    return;
  }
  // Diretório VAZIO e sem arquivos rastreados: nada a mover (o conteúdo já foi
  // para o destino; o diretório pode até estar travado por um lock residual do
  // Windows, e o git não rastreia diretório vazio).
  let tracked = 0;
  try {
    tracked = git(["ls-files", "--", from]).split("\n").filter(Boolean).length;
  } catch {
    tracked = 0;
  }
  if (tracked === 0 && readdirSync(join(ROOT, from)).length === 0) {
    console.log(`  > ${from}/ vazio e sem rastreados — nada a mover`);
    return;
  }
  // `git mv app clients/mobile` falha se `clients/` não existir ainda (o git não
  // cria o diretório-pai). Criar antes é o que torna a fase `clients` atômica.
  const parent = dirname(to);
  if (parent && parent !== ".") mkdirSync(join(ROOT, parent), { recursive: true });
  git(["mv", from, to], { stdio: "inherit" });
  console.log(`  > git mv ${from} ${to}`);
}

function lockProbe(dirName) {
  if (DRY) return;
  const abs = join(ROOT, dirName);
  const probe = `${abs}__lockprobe__`;
  try {
    renameSync(abs, probe);
    renameSync(probe, abs);
    console.log(`  · ${dirName}/ livre (sonda OK)`);
  } catch (err) {
    // Diretório JÁ VAZIO e não rastreado pelo git: nada a mover. O Windows pode
    // manter um lock residual no diretório (indexador, terminal) mesmo sem
    // conteúdo; abortar aqui travaria a onda por um diretório que o git
    // nem enxerga. O conteúdo já foi movido, então seguimos.
    const empty = existsSync(abs) && readdirSync(abs).length === 0;
    let tracked = 1;
    try {
      tracked = git(["ls-files", "--", dirName]).split("\n").filter(Boolean).length;
    } catch {
      tracked = 1;
    }
    if (empty && tracked === 0) {
      console.log(`  · ${dirName}/ travado mas VAZIO e sem arquivos rastreados — seguindo`);
      return;
    }
    console.error(`[rename] ${dirName}/ está TRAVADO — um processo vivo o usa como cwd.`);
    console.error(`[rename] pare o processo (ex.: next dev / flutter_tester / supervisor) e repita.`);
    console.error(`[rename] causa: ${String(err).split("\n")[0]}`);
    process.exit(2);
  }
}

// ── fases ────────────────────────────────────────────────────────────────

function phaseServer() {
  const OLD = "remote-pi";
  const NEW = "server";
  if (existsSync(join(ROOT, OLD))) {
    lockProbe(OLD);
    applyDirRename(OLD, NEW, `${OLD}/ → ${NEW}/`);
    gitMove(OLD, NEW);
  } else {
    // Diretório já movido: NÃO retornar cedo. A reescrita de referências precisa
    // rodar mesmo assim para pegar formas que a passada anterior deixou
    // escapar (ex.: alvo de link markdown `](./remote-pi)` em README) — sem
    // isso o link fica quebrado, apontando para um diretório inexistente.
    console.log(`  · ${OLD}/ já movido — reescrevendo referências restantes`);
    applyDirRename(OLD, NEW, `${OLD}/ → ${NEW}/`);
  }
  if (!DRY) {
    const inside = git(["grep", "-l", "-F", `${OLD}/`, "--", NEW])
      .split("\n").map((s) => s.trim()).filter(Boolean);
    let n = 0;
    for (const f of inside) {
      const rel = relOf(f);
      const abs = join(ROOT, rel);
      const before = readFileSync(abs, "utf8");
      if (!before.includes(`${OLD}/`)) continue;
      // NÃO usar `replaceAll` cego aqui: ele também casa o caminho do PACOTE
      // INSTALADO (`~/.pi/agent/npm/node_modules/remote-pi/dist/…`). Essa
      // identidade é CONGELADA — o npm install -g continua instalando como
      // `remote-pi` — e o replaceAll a reescreveu para `node_modules/server/`,
      // apontando o instalador para um caminho que nunca existirá. Bug real,
      // descoberto na verificação final (o `install.sh` divergia do baseline).
      // Aqui só reescrevemos referências ANCORADAS ao diretório do repo.
      const anchored = new RegExp(`${ANCHOR}${escapeRe(OLD)}/(?!/)`, "g");
      const after = before.replace(anchored, (m) => `${m.slice(0, -`${OLD}/`.length)}${NEW}/`);
      if (after !== before) {
        writeFileSync(abs, after);
        n += 1;
        console.log(`  ~ ${rel}`);
      }
    }
    console.log(`  · dentro de ${NEW}/: ${n} arquivo(s)`);
  }
}

/**
 * Itens que vivem na RAIZ do repo. Uma ref relativa que ESCAPAVA do diretório
 * do cliente (`../plan/`) alcançava a raiz a partir de `app/`; agora que o
 * cliente está um nível mais fundo (`clients/mobile/`), `../` chega em
 * `clients/` e a referência quebra silenciosamente (só aparece em runtime — foi
 * o que fez 9 testes de `protocol_test.dart` falharem com
 * `PathNotFoundException: ../.orchestration/contracts/fixtures`).
 */
const ROOT_ITEMS = [
  ".orchestration",
  "plan",
  "review",
  "branding",
  "scripts",
  "docs",
  "rp-s3",
  "relay",
  "server",
  "CHANGELOG.md",
  "PROTOCOL.md",
  "docker-compose.relay.yml",
];

/** Profundidade de cada cliente dentro do repo (para as refs relativas). */
const CLIENT_DEPTH = { "clients/mobile": 1, "clients/desktop": 1, "clients/web": 1 };

/**
 * Corrige refs relativas que subiam para a raiz: em `app/CLAUDE.md` valia
 * `../plan/x.md`; em `clients/mobile/CLAUDE.md` passa a valer
 * `../../plan/x.md`. Só toca refs cujo alvo existe na raiz (prova de que o
 * `../` apontava para lá antes do move).
 */
function fixRootRelativeRefs() {
  const files = liveFiles(
    "\\.\\./(\\.orchestration|plan|review|branding|scripts|docs|rp-s3|relay|server|CHANGELOG|PROTOCOL|docker-compose)",
    { regex: true },
  // Só os CLIENTES mudaram de profundidade. `relay/` e `server/` continuam na
  // raiz e suas refs `../` seguem corretas — incluir tudo reescreveria arquivos
  // que não se moveram (pego no dry-run).
  ).filter((r) => Object.keys(CLIENT_DEPTH).some((c) => r.startsWith(`${c}/`)));
  let changed = 0;
  for (const rel of files) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    let text = readFileSync(abs, "utf8");
    const before = text;
    for (const item of ROOT_ITEMS) {
      // Só quando o item EXISTE na raiz: prova que o `../` apontava para lá.
      if (!existsSync(join(ROOT, item))) continue;
      // `(^|[^./\w])` impede tocar `../../plan` (o char antes é `.`) e mantém
      // a idempotência: rodar duas vezes não aprofunda de novo.
      const re = new RegExp(`(^|[^./\\w])\\.\\./(${escapeRe(item)})`, "gm");
      text = text.replace(re, (_full, head, name) => `${head}../../${name}`);
    }
    if (text !== before) {
      if (!DRY) writeFileSync(abs, text);
      changed += 1;
      console.log(`  ~ ${rel} (profundidade de ref relativa)`);
    }
  }
  console.log(`  · refs de raiz ajustadas em ${changed} arquivo(s)`);
}

function phaseClients() {
  for (const [from, to] of CLIENT_MOVES) {
    if (!existsSync(join(ROOT, from))) {
      console.log(`  · ${from}/ já não existe — pulando`);
      continue;
    }
    lockProbe(from);
    gitMove(from, to);
  }  // Refs ao repo apontando para os diretórios novos.
  applyDirRename("app", "clients/mobile");
  applyDirRename("cockpit", "clients/desktop");
  applyDirRename("site", "clients/web");
  // Correções de profundidade em refs relativas de arquivos que mudaram de nível.
  fixRootRelativeRefs();
  for (const { file, from, to } of DEPTH_FIXES) {
    const abs = join(ROOT, file);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
    // `includes("to")` primeiro: se o alvo correto JÁ está lá, não mexe (senão
    // cada execução aprofunda mais um nível).
    if (text.includes(to) || !text.includes(from)) continue;
    if (!DRY) writeFileSync(abs, text.replaceAll(from, to));
    console.log(`  ~ ${file}: profundidade de ref relativa corrigida`);
  }
}

function phaseDartPackages() {
  const edits = [
    ["clients/mobile/pubspec.yaml", /^name:\s*app$/m, "name: mobile"],
    ["clients/desktop/pubspec.yaml", /^name:\s*cockpit$/m, "name: desktop"],
  ];
  for (const [rel, re, to] of edits) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const before = readFileSync(abs, "utf8");
    if (!re.test(before)) continue;
    if (!DRY) writeFileSync(abs, before.replace(re, to));
    console.log(`  ~ ${rel}: ${to}`);
  }

  // Ordem obrigatória: pacotes LONGOS antes de `cockpit`.
  for (const [from, to] of DART_PACKAGES) {
    const n = replaceToken(`package:${from}/`, `package:${to}/`);
    if (n) console.log(`  · package:${from}/ → package:${to}/  (${n})`);
  }

  // Diretórios dos pacotes internos + `path:` nos pubspec.
  for (const [from, to] of DART_PACKAGES) {
    if (from === "app" || from === "cockpit") continue;
    for (const base of ["clients/desktop/packages", "clients/desktop/plugins"]) {
      const dir = join(ROOT, base, from);
      const dest = join(ROOT, base, to);
      if (existsSync(dir)) {
        if (!DRY) renameSync(dir, dest);
        console.log(`  > ${base}/${from} → ${base}/${to}`);
      }
      // O `name:` do PRÓPRIO pacote também muda: sem isso o pubspec declara
      // `cockpit_core` enquanto os imports já dizem `package:desktop_core/` —
      // pub rejeita/ignora e a resolução quebra.
      const pub = join(ROOT, base, to, "pubspec.yaml");
      if (existsSync(pub)) {
        const before = readFileSync(pub, "utf8");
        const next = before.replace(new RegExp(`^name:\\s*${escapeRe(from)}\\s*$`, "m"), `name: ${to}`);
        if (next !== before) {
          if (!DRY) writeFileSync(pub, next);
          console.log(`  ~ ${base}/${to}/pubspec.yaml: name`);
        }
      }
    }
  }
  // `path:` das dependências internas, nas DUAS formas reais:
  //   raiz:      `path: packages/cockpit_core`
  //   interno:   `path: ../cockpit_core`
  // Só a forma de raiz era tratada — os pacotes internos escapavam e ficariam
  // apontando para um diretório que acabou de ser renomeado.
  //
  // Sem regex aqui de propósito: uma fuga dupla (`\\s` virando `\\s` literal)
  // fez o filtro nunca casar e os `path:` ficarem todos para trás. Listamos os
  // pubspec por NOME de arquivo e filtramos com `includes`.
  // Dependência nomeada no pubspec: a CHAVE sob `dependencies:` é o nome pelo
  // qual o pacote é resolvido (`cockpit_pty:` → `desktop_pty:`), independente do
  // `path:`. Ficou para trás e o Flutter falhou com
  // "name field doesn't match expected name 'cockpit_pty'" — a mensagem aponta o
  // pubspec do pacote, mas a causa estava AQUI, no consumidor.
  const pubspecFiles = git(["grep", "-lF", "cockpit_", "--", "*pubspec.yaml", "*pubspec.lock"])
    .split("\n").map((s) => s.trim()).filter(Boolean).filter((r) => !excluded(r));
  for (const rel of pubspecFiles) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    let text = readFileSync(abs, "utf8");
    const before = text;
    for (const [from, to] of DART_PACKAGES) {
      if (from === "app" || from === "cockpit") continue;
      text = text.replaceAll(`packages/${from}`, `packages/${to}`);
      text = text.replaceAll(`plugins/${from}`, `plugins/${to}`);
      text = text.replaceAll(`../${from}`, `../${to}`);
      text = text.replaceAll(`"${from}"`, `"${to}"`);
      // Chave de dependência / chave de topo do lock: `  cockpit_pty:`
      text = text.replace(new RegExp(`^(\\s{2})${escapeRe(from)}:$`, "gm"), `$1${to}:`);
    }
    if (text !== before) {
      if (!DRY) writeFileSync(abs, text);
      console.log(`  ~ ${rel} (path deps)`);
    }
  }
}

/** Refs de `app/`/`site/` remanescentes (CI, scripts, docs) após as fases de dir. */
function phaseRefs() {
  applyDirRename("remote-pi", "server");
  applyDirRename("app", "clients/mobile");
  applyDirRename("cockpit", "clients/desktop");
  applyDirRename("site", "clients/web");
  // Referências que o texto não resolve sozinho (cwd de shell, contexto de job).
  for (const [rel, from, to] of EXPLICIT_FIXES) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
    if (!text.includes(from)) continue;
    if (!DRY) writeFileSync(abs, text.replaceAll(from, to));
    console.log(`  ~ ${rel}: ${from} → ${to}`);
  }
  // Portão de completude: nenhuma referência antiga pode sobrar sem
  // justificativa. É o que impede um falso-negativo passar em silêncio.
  assertNoResidualRefs();
}

/**
 * Sobras LEGÍTIMAS (não são referências ao diretório do repo):
 *  - fixtures de teste que usam 'app/...' como DADO de resolução de caminho;
 *  - o App Router do Next, onde `app/` é uma pasta do framework;
 *  - caminhos internos tipo `lib/app/` e `package:desktop/app/`;
 *  - nomes de produto (`~/.cockpit/bin`, URLs do rp-s3).
 * Qualquer outra sobra é bug e derruba a execução.
 */
const RESIDUAL_ALLOWLIST = [
  /(^|\/)test(s)?\//,
  /_test\.[a-z]+$/,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /^clients\/web\/src\/app\//, // App Router do Next
];

function assertNoResidualRefs() {
  const dirs = ["app", "cockpit", "site", "remote-pi"];
  const suspects = [];
  for (const dir of dirs) {
    const re = pathRefRe(dir);
    const vr = varRootedRe(dir);
    const bare = bareRefRe(dir);
    for (const rel of liveFiles(`${dir}/`)) {
      if (RESIDUAL_ALLOWLIST.some((a) => a.test(rel))) continue;
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) continue;
      for (const [i, line] of readFileSync(abs, "utf8").split("\n").entries()) {
        re.lastIndex = 0;
        vr.lastIndex = 0;
        bare.lastIndex = 0;
        if (re.test(line) || vr.test(line) || bare.test(line)) {
          suspects.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      }
    }
  }
  if (suspects.length) {
    console.error(`\n[rename] ${suspects.length} referência(s) residual(is) NÃO resolvida(s):`);
    for (const s of suspects) console.error(`  ${s}`);
    if (APPLY) process.exit(1);
  }
}

// ── invariantes ──────────────────────────────────────────────────────────

const PUBLISHED = {
  "work.jacobmoura.remotepi": 15,
  "work.jacobmoura.cockpit": 45,
  "npm:remote-pi": 30,
  'registerCommand("remote-pi"': 1,
  "app-v": 10,
  "cockpit-v": 41,
};

function verify() {
  console.log("\n── invariantes ────────────────────────────────");
  let bad = 0;

  // O próprio script é excluído: ele CONTÉM as strings de corrupção e os nomes
  // das identidades como literais (são o que ele procura e afirma), então
  // contá-lo infla toda contagem em 1 e produz falso-positivo.
  for (const c of ["clients/clients/", "desktop/lib/clients/", "package:clients/", "server/server/"]) {
    const hits = liveFiles(c, { fixed: true });
    console.log(`  ${hits.length ? "FAIL" : "OK  "} corrupção "${c}"${hits.length ? ` → ${hits.join(", ")}` : ""}`);
    if (hits.length) bad += 1;
  }

  for (const [id, expected] of Object.entries(PUBLISHED)) {
    let n = 0;
    try {
      // O pathspec precisa ser UM argumento (`:!path`); passar `":!"` e o
      // caminho separados faz o git tratar o primeiro como literal e a
      // exclusão não acontece (contagem inflada em 1, falso-FAIL).
      n = git(["grep", "-F", id, "--", `:!${SELF}`]).split("\n").filter(Boolean).length;
    } catch {
      n = 0;
    }
    const ok = n === expected;
    console.log(`  ${ok ? "OK  " : "FAIL"} [${id}] = ${n} (baseline ${expected})`);
    if (!ok) bad += 1;
  }

  const hist = git(["status", "--porcelain", "--", "plan/", ".workflow/", "review/"])
    .split("\n").filter((l) => l.trim() && !l.includes("00-decisions.md")).length;
  console.log(`  ${hist ? "FAIL" : "OK  "} histórico intocado (${hist} arquivo(s) inesperado(s))`);
  if (hist) bad += 1;

  if (bad) {
    console.error(`\n[rename] ${bad} invariante(s) VIOLADA(S)`);
    if (APPLY) process.exit(1);
  }
  return bad;
}

// ── main ─────────────────────────────────────────────────────────────────

function main() {
  const phases = ALL ? ["server", "clients", "dart-packages", "refs"] : PHASE ? [PHASE] : null;
  if (!phases) {
    console.error("[rename] informe --phase <fase> ou --all");
    console.error("[rename] fases: server, clients, dart-packages, refs");
    process.exit(1);
  }
  console.log(`[rename] root=${ROOT}`);
  console.log(`[rename] mode=${DRY ? "DRY-RUN (nada é escrito)" : "APPLY"}`);
  console.log(`[rename] fases=${phases.join(" → ")}\n`);

  for (const p of phases) {
    console.log(`── fase: ${p} ─────────────────────────────`);
    if (p === "server") phaseServer();
    else if (p === "clients") phaseClients();
    else if (p === "dart-packages") phaseDartPackages();
    else if (p === "refs") phaseRefs();
    else {
      console.error(`[rename] fase desconhecida: ${p}`);
      process.exit(1);
    }
    console.log();
  }

  verify();
  console.log(DRY ? "\n[rename] dry-run completo — nada foi escrito" : "\n[rename] DONE");
}

main();
