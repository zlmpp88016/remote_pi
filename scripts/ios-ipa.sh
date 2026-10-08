#!/usr/bin/env bash
set -euo pipefail

# Dispara o workflow "Build iOS IPA" no GitHub, espera terminar e baixa o
# .ipa resultante para dist/ na raiz do repositorio, com timestamp ate o
# segundo no nome (RemotePi-unsigned-AAAAMMDD-HHMMSS.ipa). Ao final, envia o
# .ipa para o grupo "三班" no QQ via NapCat (a menos que --no-qq seja passado).
#
# Uso:
#   scripts/ios-ipa.sh                    # dispara, espera, baixa, envia pro QQ
#   scripts/ios-ipa.sh --download-only    # so baixa o ultimo run bem-sucedido
#   scripts/ios-ipa.sh --no-wait          # dispara e sai (nao baixa)
#   scripts/ios-ipa.sh --no-qq            # nao envia pro QQ
#   scripts/ios-ipa.sh --branch <ref>     # branch/tag alvo (default: branch atual)
#   scripts/ios-ipa.sh --run <id>         # baixa um run especifico
#
# Exemplos:
#   scripts/ios-ipa.sh
#   scripts/ios-ipa.sh --download-only --run 37147157376
#   scripts/ios-ipa.sh --no-qq
#
# Por que existe: o artefato do CI e um .ipa SEM assinatura (o runner nao tem
# certificado). A assinatura fica por conta de quem instala — Sideloadly,
# AltStore ou Xcode. Ver .github/workflows/build-ios.yml.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
WORKFLOW="Build iOS IPA"
ARTIFACT="RemotePi-unsigned-ipa"

BRANCH=""
RUN_ID=""
DO_WAIT=1
DO_DOWNLOAD=1
DO_QQ=1

usage() {
  sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --download-only) DO_WAIT=0; shift ;;
    --no-wait)       DO_DOWNLOAD=0; shift ;;
    --no-qq)         DO_QQ=0; shift ;;
    --branch)        BRANCH="${2:?--branch exige um valor}"; shift 2 ;;
    --run)           RUN_ID="${2:?--run exige um id}"; DO_WAIT=0; shift 2 ;;
    --help|-h)       usage 0 ;;
    *) echo "opcao desconhecida: $1" >&2; usage 2 ;;
  esac
done

# `gh` pode nao estar no PATH no Git Bash (ex: instalado fora do gerenciador
# de pacotes). Procura nos locais conhecidos antes de desistir.
GH_BIN=""
if command -v gh >/dev/null 2>&1; then
  GH_BIN="gh"
else
  for candidate in "$HOME/.local/bin/gh" /usr/local/bin/gh \
                   "/c/Program Files/GitHub CLI/gh.exe" \
                   /d/flutter-work/ghcli/bin/gh.exe; do
    if [ -x "$candidate" ]; then GH_BIN="$candidate"; break; fi
  done
fi
gh() { "$GH_BIN" "$@"; }

if [ -z "$GH_BIN" ]; then
  echo "erro: gh CLI nao encontrado. Instale: https://cli.github.com" >&2
  exit 1
fi

# A auth vive no config dir. Se o default nao tem credencial, procura um
# config alternativo conhecido (uma instalacao portatil, por exemplo).
if [ -z "${GH_CONFIG_DIR:-}" ]; then
  for cfg in "$HOME/.config/gh" /d/flutter-work/ghconfig; do
    if [ -f "$cfg/hosts.yml" ]; then
      export GH_CONFIG_DIR="$cfg"
      break
    fi
  done
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "erro: gh nao esta autenticado. Rode: gh auth login" >&2
  [ -n "${GH_CONFIG_DIR:-}" ] && echo "      (config em $GH_CONFIG_DIR)" >&2
  exit 1
fi

# Confirma que estamos num repo com remoto GitHub antes de qualquer coisa.
git -C "$ROOT" remote get-url origin >/dev/null 2>&1 || {
  echo "erro: $ROOT nao tem remoto 'origin'" >&2; exit 1
}

if [ -z "$BRANCH" ]; then
  BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
fi

if [ -z "$RUN_ID" ]; then
  echo ">> disparando '$WORKFLOW' em '$BRANCH'..."
  gh workflow run "$WORKFLOW" --ref "$BRANCH" -R "$(git -C "$ROOT" remote get-url origin)"

  # O run recem-criado nao aparece instantaneamente na API.
  RUN_ID=""
  for _ in $(seq 1 20); do
    sleep 3
    RUN_ID="$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 \
      --json databaseId,status --jq '.[0].databaseId' 2>/dev/null || true)"
    [ -n "$RUN_ID" ] && break
  done
  [ -n "$RUN_ID" ] || { echo "erro: run nao apareceu na API" >&2; exit 1; }
  echo "   run: $RUN_ID"
  echo "   https://github.com/$(gh repo view --json nameWithOwner --jq .nameWithOwner)/actions/runs/$RUN_ID"
fi

if [ "$DO_WAIT" = "1" ]; then
  echo ">> aguardando o run terminar (o build leva ~6 min)..."
  if ! gh run watch "$RUN_ID" --interval 20 --exit-status >/dev/null 2>&1; then
    echo "erro: run $RUN_ID falhou ou nao concluiu com sucesso" >&2
    gh run view "$RUN_ID" --json conclusion,url --jq '"conclusion: \(.conclusion)\n\(.url)"' >&2 || true
    exit 1
  fi
  echo "   run concluido com sucesso"
fi

[ "$DO_DOWNLOAD" = "1" ] || exit 0

mkdir -p "$DIST"
echo ">> baixando artefato '$ARTIFACT' para $DIST/"
# Limpa .ipa antigos para nao acumular builds indistinguiveis.
rm -f "$DIST"/*.ipa
gh run download "$RUN_ID" -n "$ARTIFACT" -D "$DIST"

# Renomeia com timestamp ate o segundo. Sem isso, todo build sai como
# `RemotePi-unsigned.ipa`: no disco um sobrescreve o outro, e no grupo do QQ
# vira uma pilha de homonimos (mesmo nome, tamanhos diferentes) impossivel de
# distinguir depois. O `gh` so escreve o nome do artefato, entao o stamp e
# aplicado aqui, no arquivo ja baixado.
STAMP="$(date +%Y%m%d-%H%M%S)"
for f in "$DIST"/*.ipa; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  mv "$f" "$DIST/${base%.ipa}-$STAMP.ipa"
done

echo
echo ">> ok"
find "$DIST" -maxdepth 1 -name '*.ipa' -print0 | while IFS= read -r -d '' f; do
  printf '   %s  (%s)\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)"
done
echo
echo "   O .ipa NAO esta assinado. Assine na instalacao (Sideloadly/AltStore/Xcode)."

# Envia pro grupo "三班" no QQ. Falha aqui NAO invalida o build: o .ipa ja esta
# em dist/ e o usuario pode envia-lo a mao. Por isso o erro vira aviso, nao
# `exit 1` — perder o arquivo por causa do QQ seria pior que nao notificar.
if [ "$DO_QQ" = "1" ]; then
  echo
  echo ">> enviando pro grupo \"三班\" (QQ, via NapCat)..."
  ipa="$(find "$DIST" -maxdepth 1 -name '*.ipa' | head -1)"
  if node "$ROOT/scripts/napcat-upload.mjs" "$ipa"; then
    echo "   arquivo enviado pro QQ."
  else
    echo "   AVISO: nao consegui enviar pro QQ (NapCat fora do ar? veja acima)." >&2
    echo "          o .ipa continua em $ipa — envie manualmente se precisar." >&2
  fi
fi
