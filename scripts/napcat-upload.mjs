#!/usr/bin/env node
// Envia um arquivo para o grupo "三班" via NapCat (HTTP server, OneBot v11).
//
// Uso:
//   node scripts/napcat-upload.mjs <arquivo> [--name <nome-no-grupo>]
//   node scripts/napcat-upload.mjs dist/RemotePi-unsigned.ipa --dry-run
//
// Por que existe: depois de cada build do IPA, o arquivo precisa chegar no
// grupo sem passo manual. O `scripts/ios-ipa.sh` chama este script assim que o
// download termina (ver "Enviar pro QQ" no fim dele).
//
// O IPA vai para a pasta `NAPCAT_FOLDER` (default "remote-pi.app.ios"). A pasta
// e criada se nao existir — a busca e por nome exato. O grupo de pastas do QQ
// e de UM nivel so: a API (OneBot -> NapCat core -> kernel do QQ) so aceita
// (group_id, nome), sem parametro de pai. Por isso o caminho virou um nome
// pontuado em vez de pastas aninhadas.
//
// Por que em Node e nao em bash+curl: o `upload_group_file` exige um URI
// `file:///...`. Passar um caminho Windows por bash/curl quebra no escape das
// contrabarras (`D:\a\b` vira `D:workspacegit...`, e o NapCat responde
// "识别URL失败"). Aqui o URI e montado em JS, sem shell no meio. O `node -e`
// inline tambem come as contrabarras, entao nem assim: este arquivo existe
// justamente para manter os caminhos fora do shell.
//
// Config (env sobrescreve):
//   NAPCAT_ENDPOINT   default http://127.0.0.1:3001
//   NAPCAT_TOKEN      default 8250u-napcat-token   (token LOCAL do NapCat)
//   NAPCAT_GROUP_ID   default 317661279            (grupo "三班")
//   NAPCAT_FOLDER     default remote-pi.app.ios    (pasta no grupo; vazio = raiz)
//
// Requisitos: o NapCat precisa estar rodando e logado, com o servidor HTTP
// habilitado. Teste rapido:
//   curl -s -X POST $NAPCAT_ENDPOINT/get_group_list -H "Authorization: $NAPCAT_TOKEN"

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT = "http://127.0.0.1:3001";
const DEFAULT_TOKEN = "8250u-napcat-token";
const DEFAULT_GROUP_ID = 317661279; // "三班"
const DEFAULT_FOLDER = "remote-pi.app.ios";

const ENDPOINT = (process.env.NAPCAT_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
const TOKEN = process.env.NAPCAT_TOKEN ?? DEFAULT_TOKEN;
const GROUP_ID = Number(process.env.NAPCAT_GROUP_ID ?? DEFAULT_GROUP_ID);
const FOLDER = process.env.NAPCAT_FOLDER ?? DEFAULT_FOLDER;

/** Chama uma action do OneBot v11. Devolve o JSON ja parseado. */
async function call(action, body, { timeoutMs = 120_000 } = {}) {
  const res = await fetch(`${ENDPOINT}/${action}`, {
    method: "POST",
    headers: { Authorization: TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${action}: resposta nao e JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return json;
}

/** Falha alto quando o retcode != 0, mostrando a mensagem do NapCat. */
function assertOk(action, json) {
  if (json.status !== "ok" || json.retcode !== 0) {
    throw new Error(`${action} falhou: ${json.message || json.wording || JSON.stringify(json)}`);
  }
  return json.data;
}

/**
 * Confere que o grupo alvo existe e devolve o nome — evita enviar para um id
 * errado por causa de um env mal configurado.
 */
async function resolveGroup() {
  const data = assertOk("get_group_list", await call("get_group_list", {}));
  const list = Array.isArray(data) ? data : [];
  const hit = list.find((g) => Number(g.group_id) === GROUP_ID);
  if (!hit) {
    const known = list.map((g) => `${g.group_name}(${g.group_id})`).join(", ") || "nenhum";
    throw new Error(
      `grupo ${GROUP_ID} nao esta na lista do NapCat. Grupos disponiveis: ${known}`,
    );
  }
  return hit;
}

/**
 * Devolve o folder_id da pasta alvo, criando-a se faltar.
 *
 * A busca e necessaria porque `create_group_file_folder` e silencioso em dois
 * casos ruins: repetir um nome existente e usar um separador proibido (`\`, `/`,
 * `>`) devolvem `status: ok` com folder_id vazio — nao ha erro para checar. Por
 * isso nunca criamos as cegas: procuramos primeiro na raiz.
 */
async function resolveFolder() {
  if (!FOLDER) return undefined;

  const root = assertOk("get_group_root_files", await call("get_group_root_files", { group_id: GROUP_ID }));
  const existing = (root?.folders ?? []).find((f) => f.folder_name === FOLDER);
  if (existing) return existing.folder_id;

  const made = assertOk(
    "create_group_file_folder",
    await call("create_group_file_folder", { group_id: GROUP_ID, name: FOLDER }),
  );
  const folderId = made?.groupItem?.folderInfo?.folderId;
  if (!folderId) {
    throw new Error(
      `nao consegui criar a pasta "${FOLDER}". O QQ rejeita ` +
        "`\\`, `/` e `>` no nome (responde ok, mas nao cria).",
    );
  }
  console.log(`>> pasta criada: ${FOLDER}`);
  return folderId;
}

async function upload(filePath, { name, dryRun }) {
  const abs = resolve(filePath);
  if (!existsSync(abs)) throw new Error(`arquivo nao existe: ${abs}`);

  const fileName = name ?? basename(abs);
  const size = readFileSync(abs).length;

  const group = await resolveGroup();
  console.log(`>> grupo alvo: ${group.group_name} (${group.group_id})`);
  const folderId = await resolveFolder();
  console.log(`>> destino: ${FOLDER || "(raiz do grupo)"}`);
  console.log(`>> arquivo: ${fileName} (${(size / 1024 / 1024).toFixed(1)} MB)`);

  if (dryRun) {
    console.log(">> --dry-run: nada enviado.");
    return null;
  }

  // O NapCat aceita `file:///` para caminho local. `pathToFileURL` cuida do
  // drive (D:/ -> file:///D:/) e das barras no Windows.
  const uri = pathToFileURL(abs).href;
  const data = assertOk(
    "upload_group_file",
    await call("upload_group_file", {
      group_id: group.group_id,
      file: uri,
      name: fileName,
      folder_id: folderId,
    }),
  );
  console.log(`>> enviado. file_id: ${data?.file_id ?? "(sem file_id)"}`);
  return data;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const header = [];
  for (const line of src.split("\n").slice(1)) {
    if (!line.startsWith("//")) break;
    header.push(line.replace(/^\/\/ ?/, ""));
  }
  console.log(header.join("\n"));
  process.exit(argv.length === 0 ? 2 : 0);
}

let fileArg = null;
let nameArg = null;
let dryRun = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry-run") dryRun = true;
  else if (a === "--name") nameArg = argv[++i];
  else if (a.startsWith("--name=")) nameArg = a.slice(7);
  else if (!a.startsWith("-")) fileArg = a;
}

if (!fileArg) {
  console.error("erro: informe o arquivo a enviar");
  process.exit(2);
}

try {
  await upload(fileArg, { name: nameArg, dryRun });
} catch (err) {
  console.error(`erro: ${err.message}`);
  console.error(
    "      o NapCat esta rodando e logado, com o servidor HTTP ligado? " +
      `Confira: curl -s -X POST ${ENDPOINT}/get_group_list -H "Authorization: ${TOKEN}"`,
  );
  process.exit(1);
}
