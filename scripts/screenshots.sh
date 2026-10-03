#!/usr/bin/env bash
set -euo pipefail

# Renderiza as telas reais do app em PNG, no Windows.
#
# Por que existe: o app e mobile-only (o identity store e um MethodChannel e o
# plugin so declara android/ios), entao `flutter run -d windows` nao sobe — e
# nao ha simulador de iOS fora do macOS. Mas `lib/ui/` e Flutter puro: o mesmo
# widget tree que roda no iPhone. O harness em
# test/screenshots/screenshots_test.dart monta cada pagina com fakes e escreve
# um golden PNG, entao da para inspecionar o visual sem device nenhum.
#
# Uso:
#   scripts/screenshots.sh                 # todas as telas
#   scripts/screenshots.sh sessions home   # so essas (match de prefixo)
#   scripts/screenshots.sh --open          # abre a pasta no Explorer ao final
#
# Saida: app/build/screenshots/*.png

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/app"
# O golden path e resolvido relativo ao arquivo de teste, nao ao cwd.
SHOTS="$APP/build/screenshots"
STAGE="$APP/test/screenshots/build/screenshots"

OPEN=0
FILTERS=()
for arg in "$@"; do
  case "$arg" in
    --open) OPEN=1 ;;
    -h|--help)
      sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) echo "opcao desconhecida: $arg" >&2; exit 2 ;;
    *) FILTERS+=("$arg") ;;
  esac
done

command -v flutter >/dev/null 2>&1 || {
  echo "erro: flutter nao esta no PATH (esperado em D:/flutter/bin)" >&2; exit 1
}

rm -rf "$STAGE" "$SHOTS"
mkdir -p "$SHOTS"

echo ">> renderizando telas..."
# `--update-goldens` escreve os PNGs em vez de compara-los. O harness so
# produz testes quando SCREENSHOTS=true (senao o arquivo e um no-op, para o
# `flutter test` normal nao gerar PNG nenhum).
cd "$APP"
flutter test test/screenshots/screenshots_test.dart \
  --dart-define=SCREENSHOTS=true \
  --update-goldens

# Golden escreve relativo ao teste; move para o caminho estavel em build/.
if [ -d "$STAGE" ]; then
  mv "$STAGE"/*.png "$SHOTS"/ 2>/dev/null || true
  rm -rf "$APP/test/screenshots/build"
fi

if [ ${#FILTERS[@]} -gt 0 ]; then
  for f in "${FILTERS[@]}"; do
    # Remove as capturas que nao casam com nenhum filtro.
    for png in "$SHOTS"/*.png; do
      base="$(basename "$png")"
      match=0
      for keep in "${FILTERS[@]}"; do
        case "$base" in *"$keep"*) match=1 ;; esac
      done
      [ "$match" = 0 ] && rm -f "$png"
    done
  done
fi

count=$(find "$SHOTS" -name '*.png' | wc -l | tr -d ' ')
echo
echo ">> $count PNG(s) em $SHOTS"
ls -1 "$SHOTS" 2>/dev/null | sed 's/^/   /'

if [ "$OPEN" = 1 ]; then
  # Git Bash precisa de caminho Windows para o explorer.
  explorer.exe "$(cygpath -w "$SHOTS")" 2>/dev/null || true
fi
