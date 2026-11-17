# [ORCH:87-mobile-collector-fix] Android collector launch fix

**Status**: done
**Arquivos tocados**: explicitly authorized `C:/Users/zlmpp/AppData/Local/Temp/p87-collect-mobile.mjs`; `clients/mobile/test/tool/p87_collector_launch_test.mjs`; `clients/mobile/tool/history_perf/p87_collector_launch.patch`; this result.

## Diagnosis and fix

Read mobile CLAUDE, orchestration instructions and `87-app-ready.md`. The user explicitly authorizes the external collector edit and commit, overriding the local default no-commit rule. No device operation, performance run, Flutter build or Flutter test was performed.

Comma separation is necessary but insufficient. Flutter 3.44.4 / framework `ad70ec4617166f1c38e5d2bfd388af71fda14f06`, engine `a10d8ac38de835021c8d2f920dbf50a920ccc030` (installed SDK metadata):

- `D:/flutter/engine/src/flutter/shell/common/switches.cc:155`: `ParseCommaDelimited` splits on comma; lines 471–480 split and validate each flag before adding it to VM settings. Lines 51–66 list non-release allowed flags, including `--sample-buffer-duration` and `--profile_period`, excluding **both** `--timeline_recorder` and `--profile_buffer_size`. Thus a comma-only edit still terminates the process.
- `D:/flutter/engine/src/flutter/shell/platform/android/io/flutter/embedding/engine/FlutterShellArgs.java:103`: `endless-trace-buffer=true` intent extra becomes the supported engine switch; lines 168–172 explicitly document fatal filtering of `dart-flags`.
- `D:/flutter/engine/src/flutter/runtime/dart_vm.cc:76` and `:381`: engine-owned endless trace setting injects `--timeline_recorder=endless` through the internal supported route.
- `D:/flutter/bin/cache/dart-sdk/bin/dart.exe --verbose --help` documents `sample_buffer_duration` as at least N seconds of samples at a given rate (default ~4 seconds). Request 180 seconds with startup `--profile_period=1000`, covering the collector's longest 120-second browse window with margin. The existing runtime flag inspection and CPU/timeline coverage checks remain authoritative; this buffer request does not itself prove completeness.

Launch now includes `--ez endless-trace-buffer true --es dart-flags --sample-buffer-duration=180,--profile_period=1000`. No literal shell quotes or embedded spaces surround the comma-delimited value. Existing `enable-dart-profiling=true` remains. Recorder export still requires Ring/Endless/Startup at runtime. The independent stream loss ledger, raw timeline, CPU samples/functions, sample coverage, unprofiled separation, authenticated URI nonpersistence, package/APK hash, PID, root library, build and suite guards are unchanged.

The temp collector cannot be stored directly in this repo; the committed `.patch` preserves the exact repair for review/reapplication. The focused test accepts `P87_COLLECTOR` to check another collector path (default is the authorized temp path).

## Verification

From `clients/mobile`:

```text
node --test test/tool/p87_collector_launch_test.mjs test/tool/p87_capture_coverage_test.mjs
13 passed, 0 failed (12 existing coverage checks + 1 new integration check)
node --check C:/Users/zlmpp/AppData/Local/Temp/p87-collect-mobile.mjs
passed
```

The new check runs the actual collector with mocked child-process and WebSocket I/O and a synthetic APK; it asserts comma parsing/allowed launch flags, isolated activity, PID log filtering, complete gate/RPC/export flow, CPU export SHA256, export acknowledgement, forward cleanup and no persisted/logged authenticated URI. It uses no real APK, ADB executable, device, network or auth store. Its own uniquely created temp directory is verified before cleanup. Existing coverage tests retain failure cases for buffer loss, missing samples/functions/frames/markers, stream disconnect and unprofiled separation. Actual Android runtime remains root-owned and unverified by this task.

## Root handoff

Updated collector SHA256:

`74bd7b88f1fed13266e4054958eb2e570e0ed5cb7f07c9d9b722adc6b0d1f05f`

This supersedes the collector hash and Ring/262144 launch statement in `87-app-ready.md`; APKs, build tag, helper hash and root command arguments are unchanged. Root can rerun its existing collector command with a fresh output directory. No runtime completeness or performance PASS is claimed.
