// Root-owned device collector. Node >=22, no dependencies or global Dart service.
// Authenticated VM URIs exist only in process memory. Never print raw errors.
// --native-stacks opts into profile_vm in diagnostic mode only; not raster/host CPU.
import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync, readFileSync, openSync, closeSync, linkSync, unlinkSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {assessCapture, CPU_SAMPLE_PERIOD_US, hasCaptureBounds} from './p87_capture_coverage.mjs';

const opts = Object.fromEntries(process.argv.slice(2).map((v,i,a) => v.startsWith('--') ?
  [v.slice(2), a[i+1]?.startsWith('--') ? true : (a[i+1] ?? true)] : []).filter(v => v.length));
const pkg = opts.package ?? 'com.example.remotepi.p86';
const extension = 'ext.remote_pi.p87.capture';
const mode = opts.mode ?? 'diagnostic';
let socket, forward, rpc, out, adb, serial;
let finalManifest;
const pending = new Map();
const streamed = [];
let streamGap = false, requestId = 0;
const evidence = new Map(), saved = new Set();
function preserve(name, value) {
  evidence.set(name,value);
  save(name,value);saved.add(name);
  return value;
}
function check(ok, label) { if (!ok) throw new Error(label); }
function device(args, timeout = 15000, timeoutLabel = 'adb_operation_timeout') {
  const p = spawnSync(adb, ['-s', serial, ...args], {encoding:'utf8',timeout,windowsHide:true,maxBuffer:16*1024*1024});
  if(args[0] === 'shell' && args[1] === 'pidof' && p.status === 1) return '';
  check(p.error?.code !== 'ETIMEDOUT', timeoutLabel);
  check(p.status === 0, 'adb_operation_failed');
  return p.stdout.trim();
}
async function waitFor(work, predicate, deadlineMs, label) {
  const deadline = Date.now() + deadlineMs;
  while(Date.now() < deadline) {
    const value = await work();
    if(predicate(value)) return value;
    await delay(100);
  }
  throw new Error(label);
}
function save(name, value) { writeFileSync(join(out,name), JSON.stringify(value,null,2)+'\n', {flag:'wx'}); }
function hash(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function preserveManifest(value) {
  const target = join(out,'manifest.json');
  const temporary = join(out,`.manifest-${process.pid}.tmp`);
  let owned = false;
  try {
    const fd = openSync(temporary,'wx');
    owned = true;
    try { writeFileSync(fd,JSON.stringify(value,null,2)+'\n'); }
    finally { closeSync(fd); }
    // Publish only a complete file and never replace an existing manifest.
    linkSync(temporary,target);
  } catch {
    throw new Error('collector_output_persist_failed');
  } finally {
    if(owned) { try { unlinkSync(temporary); } catch {} }
  }
  saved.add('manifest.json');
}
function saveIncomplete(reason, issues) {
  try {
    save('collector-incomplete.json',{status:'incomplete',reason,issues,authenticatedVmUriPersisted:false});
  } catch { throw new Error('collector_output_persist_failed'); }
}
async function connect(uri) {
  socket = new WebSocket(uri);
  await new Promise((yes,no) => {
    const t = setTimeout(() => no(new Error('vm_connect_timeout')),10000);
    socket.addEventListener('open', () => {clearTimeout(t);yes();},{once:true});
    socket.addEventListener('error', () => {clearTimeout(t);no(new Error('vm_connect_failed'));},{once:true});
  });
  socket.addEventListener('message', ({data}) => {
    try {
      const message = JSON.parse(data);
      if(message.method === 'streamNotify' && message.params?.streamId === 'Timeline') {
        const event = message.params.event;
        if(event?.kind !== 'TimelineEvents') return;
        const values = event.timelineEvents;
        if(!Array.isArray(values)) streamGap = true;
        else streamed.push(...values);
        return;
      }
      const current = pending.get(message.id);
      if(!current) return;
      pending.delete(message.id);clearTimeout(current.timer);
      if(message.error) current.reject(new Error(`vm_rpc_${current.method}_${message.error.code}`));
      else current.resolve(message.result);
    } catch { streamGap = true; }
  });
  const closed = () => {
    streamGap = true;
    for(const p of pending.values()) {clearTimeout(p.timer);p.reject(new Error('vm_disconnected'));}
    pending.clear();
  };
  socket.addEventListener('error',closed);
  socket.addEventListener('close',closed);
  rpc = (method, params={}) => new Promise((resolve,reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {pending.delete(id);reject(new Error('vm_rpc_timeout'));},20000);
    pending.set(id,{resolve,reject,timer,method});
    socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));
  });
}
try {
  check(opts.adb && opts.serial && opts.out && opts.apk && opts.build && opts.suite, 'required_arguments');
  check(['p5','browse'].includes(opts.suite), 'invalid_suite');
  check(['com.example.remotepi.p86','com.example.remotepi.p90'].includes(pkg), 'invalid_isolated_package');
  check(['diagnostic','unprofiled'].includes(mode), 'invalid_mode');
  const nativeStacks = opts['native-stacks'] === true;
  check(opts['native-stacks'] === undefined || nativeStacks, 'invalid_native_stack_option');
  check(!nativeStacks || mode === 'diagnostic', 'native_stacks_requires_diagnostic');
  const userText = String(opts.user ?? '0');
  check(/^(0|[1-9]\d*)$/.test(userText) && Number.isSafeInteger(Number(userText)) && Number(userText) <= 2147483647,
    'invalid_android_user');
  const androidUser = Number(userText);
  adb = opts.adb; serial = opts.serial;
  const outputDir = resolve(opts.out);
  try { mkdirSync(outputDir, {recursive:false}); }
  catch (error) { throw new Error(error.code === 'EEXIST' ? 'output_dir_exists' : 'output_dir_create_failed'); }
  out = outputDir;
  const apkHash = hash(opts.apk);
  const signature = device(['shell','cmd','package','resolve-activity','--brief','--user',String(androidUser),pkg]);
  check(signature.endsWith(`${pkg}/com.example.remotepi.MainActivity`), 'isolated_package_activity');
  const installedPath = device(['shell','pm','path','--user',String(androidUser),pkg]).replace(/^package:/,'');
  check(/^\/data\/app\/[A-Za-z0-9_+./=~-]+\/base\.apk$/.test(installedPath), 'own_base_apk_path');
  // Hash the exact installed base on-device: do not pull a large APK through
  // exec-out, where an otherwise healthy slow link can truncate the copy.
  // Only the compared digest survives; never persist/print device output.
  // Cold on-device reads can be slow. This is preflight only; it does not
  // extend the capture window or any VM/frame deadline.
  const installed = device(['shell','sha256sum',installedPath], 45000, 'installed_apk_hash_timeout');
  const digest = /^([a-fA-F0-9]{64})[ \t]+\*?(\/[^\r\n]+)$/.exec(installed);
  check(digest && digest[2] === installedPath, 'installed_apk_hash_malformed');
  check(digest[1].toLowerCase() === apkHash, 'installed_apk_hash_mismatch');
  // Fresh own-package process, retaining all data. No log-buffer clear, no
  // uninstall, no global VM service and no production package operations.
  device(['shell','am','force-stop','--user',String(androidUser),pkg]);
  // Flutter splits dart-flags on commas and applies an allowlist. Direct
  // timeline_recorder/profile_buffer_size flags are forbidden even in profile.
  // Use the embedding's recorder switch and the allowed duration-based CPU
  // buffer (covers the longest 120s browse window at the requested 1000us rate).
  device(['shell','am','start','--user',String(androidUser),'-n',`${pkg}/com.example.remotepi.MainActivity`,
    '--ez','enable-dart-profiling','true',
    '--ez','endless-trace-buffer','true','--es','dart-flags',
    `--sample-buffer-duration=180,--profile_period=${CPU_SAMPLE_PERIOD_US},--max_profile_depth=255`]);
  const pid = await waitFor(async () => device(['shell','pidof',pkg]),
    v => /^\d+$/.test(v), 15000,'own_package_pid_missing');
  let authenticated;
  await waitFor(async () => {
    const text = device(['logcat','-d',`--pid=${pid}`,'-s','flutter:D','DartVM:D','*:S']);
    const matches = [...text.matchAll(/(?:Dart VM service is listening on|Observatory listening on)\s+(https?:\/\/127\.0\.0\.1:(\d+)\/[^\s]+)/g)];
    if(!matches.length) return false;
    authenticated = new URL(matches.at(-1)[1]);
    return true;
  }, Boolean, 20000,'own_process_vm_uri_missing');
  check(authenticated.hostname === '127.0.0.1' && authenticated.pathname.length > 2 && !authenticated.search,
    'vm_uri_shape');
  const port = device(['forward','tcp:0',`tcp:${authenticated.port}`]);
  check(/^\d+$/.test(port),'forward_port');forward = port;
  authenticated.port = port;
  authenticated.protocol = 'ws:';
  authenticated.pathname = `${authenticated.pathname.replace(/\/$/,'')}/ws`;
  await connect(authenticated.href);
  authenticated = undefined;
  const vm = await rpc('getVM');
  check(String(vm.pid) === pid, 'vm_pid_does_not_match_own_package');
  let selected;
  await waitFor(async () => {
    for(const ref of (await rpc('getVM')).isolates ?? []) {
      const isolate = await rpc('getIsolate',{isolateId:ref.id});
      if(isolate.extensionRPCs?.includes(extension)) {
        selected = isolate;return true;
      }
    }
    return false;
  }, Boolean, 15000,'capture_extension_missing');
  const isolateId = selected.id;
  const gateCall = action => rpc(extension,{isolateId,action,...(action==='start'?{mode}:{})});
  const ready = await gateCall('ready');
  check(ready.state === 'ready' && ready.build === opts.build && ready.suite === opts.suite,
    'capture_build_suite_or_state');
  const expectedRoot = ready.suite === 'p5' ? 'p5_profile_main.dart' : 'history_perf_main.dart';
  check(selected.rootLib?.uri?.endsWith(expectedRoot),'unexpected_root_library');
  const flagsInitial = await rpc('getVMTimelineFlags');
  check(['Ring','Endless','Startup'].includes(flagsInitial.recorderName),'recorder_not_exportable');
  const streams = mode === 'diagnostic' ? ['Dart','Embedder','GC','Compiler'] : [];
  check(streams.every(s => flagsInitial.availableStreams?.includes(s)),'required_timeline_stream_unavailable');
  await rpc('setVMTimelineFlags',{recordedStreams:streams});
  await rpc('setFlag',{name:'profiler',value:mode==='diagnostic'?'true':'false'});
  if(mode === 'diagnostic') await rpc('setFlag',{name:'profile_period',value:String(CPU_SAMPLE_PERIOD_US)});
  // Explicit extra diagnostic only: do not change the default Dart walker.
  if(nativeStacks) await rpc('setFlag',{name:'profile_vm',value:'true'});
  const flags = await rpc('getFlagList');
  const cpuEnabled = String(flags.flags?.find(f => f.name==='profiler')?.valueAsString) === 'true';
  check(cpuEnabled === (mode==='diagnostic'),'profiler_flag_not_applied');
  const profileVmFlag = flags.flags?.find(f => f.name==='profile_vm');
  const profileVmEnabled = profileVmFlag ? String(profileVmFlag.valueAsString)==='true' : null;
  check(!nativeStacks || profileVmEnabled === true,'native_stack_flag_not_applied');
  const flagsBefore = await rpc('getVMTimelineFlags');
  preserve('timeline-flags-before.json',flagsBefore);
  if(mode === 'diagnostic') await rpc('streamListen',{streamId:'Timeline'});
  await rpc('clearCpuSamples',{isolateId});
  // Give the enabled sampler time to settle after clearing its buffer.
  // Clear the timeline afterwards; neither warm-up events nor CPU samples
  // outside the measured interval count toward coverage.
  if(mode === 'diagnostic') await delay(40);
  await rpc('clearVMTimeline');
  streamed.length = 0;
  await gateCall('start');
  process.stdout.write(`p87 capture started suite=${ready.suite} mode=${mode}; authenticated URI kept in memory\n`);
  if(ready.suite === 'browse') {
    const duration = Number(opts['duration-ms'] ?? 60000);
    check(Number.isInteger(duration) && duration > 0 && duration <= 120000,'invalid_browse_duration');
    process.stdout.write(`Browse registered directory -> history list -> history viewer within ${duration}ms.\n`);
    await delay(duration);
    await gateCall('finish');
  }
  const gate = await waitFor(async () => {
    const value = await gateCall('captureComplete');
    evidence.set('capture.json',value);
    return value;
  },
    g => g.state === 'captureComplete', 30000,'capture_completion_timeout');
  preserve('capture.json',gate);
  let timeline = {traceEvents:[]}, cpu = {samples:[],functions:[],sampleCount:0};
  const exportIssues = [];
  const attempt = async (work, label) => {
    try { return await work(); }
    catch { exportIssues.push(label);return undefined; }
  };
  if(mode === 'diagnostic') {
    // Snapshot serialization reclaims per-thread blocks, finishing them and
    // emitting TimelineEvents. Flush before waiting for the streamed fence.
    // Persist each successful export even if another RPC or the fence fails.
    timeline = await attempt(async () => preserve('timeline.json',await rpc('getVMTimeline')),
      'timeline_export_failed') ?? timeline;
    if(hasCaptureBounds(gate)) {
      // The VM includes both endpoints (delta <= timeExtentMicros).
      cpu = await attempt(async () => preserve('cpu-samples.json',await rpc('getCpuSamples',{
        isolateId,timeOriginMicros:gate.begin_us,timeExtentMicros:gate.end_us-gate.begin_us})),
        'cpu_export_failed') ?? cpu;
    }
    await attempt(() => waitFor(async () => streamed.some(e => e.name === 'p87_capture_end'),
      Boolean, 10000, 'timeline_endmarker_not_streamed'), 'timeline_endmarker_not_streamed');
    if(!streamed.some(e => e.name === 'p87_capture_end')) streamGap = true;
    await attempt(() => rpc('streamCancel',{streamId:'Timeline'}),'timeline_stream_cancel_failed');
  }
  const flagsAfter = await attempt(async () => preserve('timeline-flags-after.json',
    await rpc('getVMTimelineFlags')), 'timeline_flags_export_failed');
  const coverage = assessCapture({gate,timeline,cpu,timelineBefore:flagsBefore,
    timelineAfter:flagsAfter,streamEvents:streamed,streamGap,cpuEnabled,
    expectedBuild:opts.build,mode});
  coverage.issues.push(...exportIssues);
  if(coverage.issues.length) coverage.status = 'incomplete';
  if(mode === 'unprofiled') {
    preserve('timeline.json',timeline);
    preserve('cpu-samples.json',cpu);
  }
  preserve('timeline-stream.json',{events:streamed,streamGap,
    endMarkerReceived:streamed.some(e => e.name === 'p87_capture_end')});
  finalManifest = {schema:1,package:pkg,androidUser,pid:Number(pid),suite:gate.suite,build:opts.build,
    apk_sha256:apkHash,mode,cpuEnabled,nativeStacksRequested:nativeStacks,profileVmEnabled,timelineFlagsBefore:flagsBefore,timelineFlagsAfter:flagsAfter,
    enabledProfilerFlags:flags.flags?.filter(f => /^(profiler|profile_period|max_profile_depth|profile_depth|profile_buffer_size|profile_vm)$/.test(f.name)),
    coverage,files:Object.fromEntries(['capture.json','timeline.json','cpu-samples.json','timeline-stream.json',
      'timeline-flags-before.json','timeline-flags-after.json']
      .filter(name => saved.has(name)).map(name => [name,{sha256:hash(join(out,name))}])),
    limitations:['VM CPU samples cover Dart isolate, not native raster/SwiftShader CPU',
      'diagnostic capture overhead is not an unprofiled performance budget',
      'software-GPU results cannot satisfy physical-device verification'],
    authenticatedVmUriPersisted:false};
  try {
    const acknowledged=await gateCall('exportAcknowledged');
    check(acknowledged?.state==='exportAcknowledged','export_acknowledgement_failed');
  } catch { throw new Error('export_acknowledgement_failed'); }
  preserveManifest(finalManifest);
  if(coverage.status !== 'complete') saveIncomplete(coverage.issues[0],coverage.issues);
  process.stdout.write(`p87 ${coverage.status}; manifest=${join(out,'manifest.json')}\n`);
  if(coverage.status !== 'complete') process.exitCode = 2;
} catch (error) {
  // Only our fixed symbolic codes can leave memory; never raw service errors.
  const reason = /^[A-Za-z0-9_]{1,128}$/.test(error?.message ?? '')
    ? error.message : 'collector_operation_failed';
  if(out) {
    // Retain all available raw evidence on unexpected failures too. Never
    // replace an already written snapshot or invent an unavailable RPC export.
    if(!saved.has('timeline-stream.json')) evidence.set('timeline-stream.json',{
      events:streamed,streamGap:true,endMarkerReceived:streamed.some(e => e.name === 'p87_capture_end')});
    for(const [name,value] of evidence) {
      if(!saved.has(name)) { try {preserve(name,value);} catch {} }
    }
    const issues = [...new Set([...(finalManifest?.coverage.issues ?? []),reason])];
    if(!saved.has('manifest.json')) {
      try {
        const manifest = finalManifest ?? {schema:1,mode,files:Object.fromEntries([...saved]
          .map(name => [name,{sha256:hash(join(out,name))}])),authenticatedVmUriPersisted:false};
        preserveManifest({...manifest,coverage:{performanceBudgetEvaluated:false,...manifest.coverage,
          status:'incomplete',issues}});
      } catch {}
    }
    try {saveIncomplete(reason,issues);} catch {}
  }
  process.stderr.write(`p87 incomplete: ${reason}; no authenticated URI logged\n`);
  process.exitCode = 2;
} finally {
  socket?.close();
  if(forward) {
    try {device(['forward','--remove',`tcp:${forward}`]);} catch {}
  }
}


