#!/usr/bin/env bash
# ADB UI helpers for driving the Remote Pi Android app during acceptance runs.
#
# Two things make naive `adb shell input` unreliable here and justify this file:
#
#  1. The soft keyboard resizes the pairing sheet, so absolute coordinates that
#     were correct before the field got focus land on a different widget
#     afterwards. Text ended up in the relay-address field instead of the
#     pairing-code field more than once. Disabling the IME removes the resize.
#  2. `uiautomator dump` occasionally returns a stale or empty tree right after
#     an animation, so callers need a retry rather than a single read.
#
# Every command takes the device as $ANDROID_SERIAL or the first attached one.
set -uo pipefail

ADB=${ADB:-adb}
SERIAL=${ANDROID_SERIAL:-$("$ADB" devices | awk '/\tdevice$/{print $1; exit}')}
TMP=/sdcard/ui_dump.xml

adb_() { "$ADB" -s "$SERIAL" "$@"; }

# dump_ui: print the UI tree, retrying until it contains a <node.
dump_ui() {
  local i
  for i in 1 2 3 4 5 6 7 8; do
    adb_ shell "uiautomator dump $TMP >/dev/null 2>&1"
    local xml
    xml=$(adb_ shell "cat $TMP" 2>/dev/null)
    if printf '%s' "$xml" | grep -q '<node'; then
      printf '%s' "$xml"
      return 0
    fi
    sleep 1
  done
  return 1
}

# center_of BOUNDS_ATTR: "bounds=\"[l,t][r,b]\"" -> "cx cy"
center_of() {
  printf '%s' "$1" | sed -E 's/.*\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\].*/\1 \2 \3 \4/' |
    awk '{printf "%d %d\n", ($1+$3)/2, ($2+$4)/2}'
}

# edit_bounds N: bounds attribute of the Nth EditText (1-based).
edit_bounds() {
  dump_ui | tr '>' '\n' | grep 'class="android.widget.EditText"' |
    grep -oE 'bounds="[^"]*"' | sed -n "${1}p"
}

# tap_bounds BOUNDS: tap the centre of a bounds attribute.
tap_bounds() {
  local xy
  xy=$(center_of "$1")
  [ -n "$xy" ] || return 1
  adb_ shell input tap $xy
}

# find_bounds TEXT: bounds of the node whose text or content-desc equals TEXT.
find_bounds() {
  dump_ui | tr '>' '\n' |
    grep -E "(text|content-desc)=\"$1\"" |
    grep -oE 'bounds="[^"]*"' | head -1
}

# clear_field N: focus the Nth EditText and delete everything in it.
# KEYCODE_MOVE_END is sent first so the deletes run from a known cursor position;
# without it a mid-string cursor only clears part of the value.
clear_field() {
  local bounds xy len i
  bounds=$(edit_bounds "$1")
  [ -n "$bounds" ] || { echo "clear_field: EditText $1 not found" >&2; return 1; }
  tap_bounds "$bounds" || return 1
  sleep 1
  adb_ shell input keyevent KEYCODE_MOVE_END
  # Delete generously rather than measuring: the dump escapes `&` as `&amp;`, so a
  # length computed from it under-counts and leaves a tail behind. Extra
  # KEYCODE_DELs on an empty field are harmless.
  for ((i = 0; i < 200; i++)); do
    adb_ shell input keyevent KEYCODE_DEL
  done
}

# type_into N TEXT: focus the Nth EditText and type TEXT.
type_into() {
  local bounds
  bounds=$(edit_bounds "$1")
  [ -n "$bounds" ] || { echo "type_into: EditText $1 not found" >&2; return 1; }
  tap_bounds "$bounds" || return 1
  sleep 1
  adb_ shell input keyevent KEYCODE_MOVE_END
  adb_ shell input text "$2"
}

# edit_text N: current text value of the Nth EditText.
edit_text() {
  dump_ui | tr '>' '\n' | grep 'class="android.widget.EditText"' |
    sed -n "${1}p" | grep -oE 'text="[^"]*"' | sed -E 's/^text="(.*)"$/\1/'
}

# no_soft_keyboard: keep the keyboard from resizing the sheet.
# The sheet's fields move when the IME appears, which is what made taps land on
# the wrong widget. Disabling the IME instead of hiding it keeps the layout
# static for the whole interaction.
no_soft_keyboard() {
  adb_ shell ime disable com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME >/dev/null 2>&1
  adb_ shell settings put secure show_ime_with_hard_keyboard 0 >/dev/null 2>&1
}

case "${1:-}" in
  dump) dump_ui ;;
  edit-bounds) edit_bounds "${2:?n}" ;;
  edit-text) edit_text "${2:?n}" ;;
  find-bounds) find_bounds "${2:?text}" ;;
  tap) tap_bounds "${2:?bounds}" ;;
  tap-text) tap_bounds "$(find_bounds "${2:?text}")" ;;
  clear) clear_field "${2:?n}" ;;
  type) type_into "${2:?n}" "${3:?text}" ;;
  no-ime) no_soft_keyboard ;;
  shot)
    adb_ exec-out screencap -p > "${2:?path}"
    ;;
  *)
    echo "usage: $0 {dump|edit-bounds N|edit-text N|find-bounds TEXT|tap BOUNDS|tap-text TEXT|clear N|type N TEXT|no-ime|shot PATH}" >&2
    exit 2
    ;;
esac
