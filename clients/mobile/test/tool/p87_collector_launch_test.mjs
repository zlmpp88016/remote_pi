// Collector integration smoke: all device and websocket I/O is mocked in memory.
// No ADB executable, emulator, network or auth store is accessed.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync,readdirSync,mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseAndroidUiNodes,androidUiNodeLabel} from '../../tool/history_perf/p87_android_ui_xml.mjs';

const scenario=process.env.P87_TEST_SCENARIO ?? 'flush';
if(!process.env.P87_TEST_SCENARIO) {
  const hierarchy=`<hierarchy><node package="com.example.remotepi.p90" text='Synthetic history rp87-large-0008 / 4970&#10;Entry: R&amp;D' content-desc="P87_LARGE_8&#10;只读" bounds='[0,451][1080,2159]' /><node package='other.package' text='not owned' /></hierarchy>`;
  const owned=parseAndroidUiNodes(hierarchy,{packageName:'com.example.remotepi.p90'});
  assert.equal(owned.length,1);
  assert.equal(owned[0].text,'Synthetic history rp87-large-0008 / 4970\nEntry: R&D');
  assert.match(androidUiNodeLabel(owned[0]),/P87_LARGE_8 只读/);
  process.stdout.write('PASS Android UI hierarchy single-quote/XML entity regression\n');
  for(const variant of ['existing-output','malformed-hash','hash-wrong-base','hash-mismatch','hash-command-failure','hash-timeout','missing-marker','cpu-failure','cpu-outside-window','invalid-bounds','ack-disconnect','ack-wrong-state','manifest-write-failure','manifest-publish-conflict','unprofiled','user10','package90','native-stacks','native-unprofiled','native-flag-not-applied','native-flag-failure']) {
    const result=childProcess.spawnSync(process.execPath,[fileURLToPath(import.meta.url)],{
      env:{...process.env,P87_TEST_SCENARIO:variant},encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stdout+result.stderr);
    process.stdout.write(result.stdout);
  }
}
const collector=process.env.P87_COLLECTOR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../tool/history_perf/p87_collect_mobile.mjs');
const temp=mkdtempSync(join(tmpdir(),'p87-collector-test-'));
process.on('exit',()=>{
  const target=resolve(temp);
  assert.equal(dirname(target),resolve(tmpdir()));
  assert.ok(basename(target).startsWith('p87-collector-test-'));
  rmSync(target,{recursive:true,force:true});
});
const apk=join(temp,'mock.apk');
writeFileSync(apk,'MOCK APK ONLY');
const directory=join(temp,'capture');
if(scenario==='existing-output') {
  mkdirSync(directory);
  writeFileSync(join(directory,'keep.txt'),'existing evidence');
}
const secret='AUTHENTICATED_TEST_URI_SENTINEL';
const build='p87-78-20261117T065243Z';
const names=['apply100','prepend','duplicate','same_length'];
const phases=names.map((name,i)=>({name,open_vsync_us:100+i*100,target_vsync_us:120+i*100,close_vsync_us:140+i*100}));
const raw=phases.flatMap(p=>[p.target_vsync_us,p.close_vsync_us].map(v=>({vsync_us:v,raster_finish_us:v+8})));
const events=[{name:'p87_capture_begin',ts:90,ph:'i'},...phases.flatMap(p=>[
  {name:'p87_phase_sealed',ts:p.close_vsync_us+1,ph:'i',args:{phase:p.name}},
  {name:'Frame',ts:p.target_vsync_us+1,ph:'X',cat:'flutter'}]),{name:'p87_capture_end',ts:460,ph:'i'}];
const cpu={sampleCount:4,samples:phases.map(p=>({timestamp:p.target_vsync_us,stack:[0]})),functions:[{function:{name:'work'}}],samplePeriod:1000};
const gate={schema:1,suite:'p5',build,state:'ready',begin_us:90,end_us:460,result:{assertions_passed:true,phases,raw_timings:raw,observed_vsync_us:raw.map(r=>r.vsync_us)}};
if(scenario==='cpu-outside-window') {
  cpu.samples.push({timestamp:gate.end_us+1,stack:[0]});
  cpu.sampleCount++;
}
const calls=[];
childProcess.spawnSync=(_command,args,options)=>{
  assert.equal(_command,'MOCK_ADB_ONLY');
  assert.equal(args[0],'-s');assert.equal(args[1],'mock-serial');
  const a=args.slice(2);calls.push(a);
  assert.equal(options.timeout,a[0]==='shell'&&a[1]==='sha256sum'?45000:15000);
  let output='';
  if(a[0]==='shell'&&a[1]==='cmd') {
    assert.ok(a.includes('--user'));
    output=(scenario==='package90'?'com.example.remotepi.p90':'com.example.remotepi.p86')+'/com.example.remotepi.MainActivity';
  }
  else if(a[0]==='shell'&&a[1]==='pm'&&a[2]==='path') {
    assert.ok(a.includes('--user'));
    output='package:/data/app/mock/base.apk';
  }
  else if(a[0]==='shell'&&a[1]==='sha256sum') {
    assert.equal(a[2],'/data/app/mock/base.apk');
    if(scenario==='hash-command-failure') return {status:1,stdout:'',stderr:secret};
    if(scenario==='hash-timeout') return {status:null,error:{code:'ETIMEDOUT'},stdout:'',stderr:secret};
    const digest=createHash('sha256').update(readFileSync(apk)).digest('hex');
    output=scenario==='malformed-hash'?'not-a-sha256 /data/app/mock/base.apk':
      scenario==='hash-wrong-base'?digest+'  /data/app/another/base.apk':
      (scenario==='hash-mismatch'?'0'.repeat(64):digest)+'  /data/app/mock/base.apk';
  }
  else if(a[0]==='exec-out') assert.fail('APK verification must never copy binary data');
  else if(a[0]==='shell'&&a[1]==='am'&&a[2]==='start') {
    assert.equal(a[a.indexOf('endless-trace-buffer')+1],'true');
    assert.equal(a[a.indexOf('enable-dart-profiling')+1],'true');
    const flags=a[a.indexOf('dart-flags')+1].split(',');
    // switches.cc ParseCommaDelimited + non-release kAllowedDartFlags.
    // Rejects the original space-delimited forbidden flags.
    assert.deepEqual(flags,['--sample-buffer-duration=180','--profile_period=1000','--max_profile_depth=255']);
    assert.ok(flags.every(f=>/^--(?:sample-buffer-duration|profile_period|max_profile_depth)=\d+$/.test(f)));
    assert.equal(a[a.indexOf('-n')+1],(scenario==='package90'?'com.example.remotepi.p90':'com.example.remotepi.p86')+'/com.example.remotepi.MainActivity');
    assert.ok(a.includes('--user'));
    if(scenario==='user10') assert.equal(a[a.indexOf('--user')+1],'10');
    if(scenario==='package90') assert.equal(a[a.indexOf('-n')+1],'com.example.remotepi.p90/com.example.remotepi.MainActivity');
  }
  else if(a[0]==='shell'&&a[1]==='pidof') output='12345';
  else if(a[0]==='logcat') output=`Dart VM service is listening on http://127.0.0.1:1234/${secret}=/`;
  else if(a[0]==='forward'&&a[1]==='tcp:0') output='54321';
  return {status:0,stdout:output,stderr:''};
};
const manifestPath=join(directory,'manifest.json');
const existingManifest='pre-existing manifest must not be replaced';
if(scenario==='manifest-write-failure') {
  const write=fs.writeFileSync;
  let failed=false;
  fs.writeFileSync=(file,data,options)=>{
    if(!failed&&typeof file==='number') {
      failed=true;
      write(file,'{"partial":');
      throw Object.assign(new Error(secret),{code:'ENOSPC'});
    }
    return write(file,data,options);
  };
}
syncBuiltinESMExports();
let streams=[];
let profiler='true';
let profileVm='false';
const flagSets=[];
let vmPolls=0,isolatePolls=0;
let filesAtAck;
const rpcCalls=[];
class MockWebSocket extends EventTarget {
  constructor(uri){super();assert.ok(uri.includes(secret));queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  send(text){
    const q=JSON.parse(text);let result={type:'Success'};
    rpcCalls.push(q.method);
    switch(q.method){
      // The VM can start before main exists; discovery must refresh getVM on
      // every poll, including after an empty first discovery poll.
      case 'getVM':result={pid:12345,isolates:++vmPolls<=2?[]:[{id:'isolates/1'}]};break;
      case 'getIsolate':
        assert.equal(q.params.isolateId,'isolates/1');
        // Real VM API spelling. Registration can also lag isolate creation.
        result={id:'isolates/1',extensionRPCs:++isolatePolls===1?[]:['ext.remote_pi.p87.capture'],rootLib:{uri:'file:///p5_profile_main.dart'}};break;
      case 'getVMTimelineFlags':result={recorderName:'Ring',availableStreams:['Dart','Embedder','GC','Compiler'],recordedStreams:[...streams]};break;
      case 'setVMTimelineFlags':streams=q.params.recordedStreams;break;
      case 'setFlag':
        flagSets.push({...q.params});
        if(q.params.name==='profiler')profiler=q.params.value;
        if(q.params.name==='profile_vm'){
          if(scenario==='native-flag-failure'){
            queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:q.id,error:{code:103,message:secret}})})));
            return;
          }
          if(scenario!=='native-flag-not-applied')profileVm=q.params.value;
        }
        break;
      case 'getFlagList':result={flags:[{name:'profiler',valueAsString:profiler},
        {name:'max_profile_depth',valueAsString:'255'},{name:'profile_vm',valueAsString:profileVm}]};break;
      case 'ext.remote_pi.p87.capture':
        if(q.params.action==='start')gate.state='capturing';
        if(q.params.action==='captureComplete'){
          gate.state='captureComplete';
          if(scenario==='invalid-bounds') gate.end_us='460';
        }
        if(q.params.action==='exportAcknowledged'){
          filesAtAck=readdirSync(directory);
          if(scenario==='manifest-publish-conflict') writeFileSync(manifestPath,existingManifest,{flag:'wx'});
          if(scenario==='ack-disconnect') {
            queueMicrotask(()=>this.dispatchEvent(new Event('close')));
            return;
          }
          if(scenario!=='ack-wrong-state')gate.state='exportAcknowledged';
        }
        result=structuredClone(gate);break;
      case 'getVMTimeline':{
        // A partially filled Dart block is emitted only when snapshotting
        // reclaims it. Deliver after the RPC response, as a separate event.
        const flushed=scenario==='missing-marker'?events.filter(e=>e.name!=='p87_capture_end'):events;
        const notice={method:'streamNotify',params:{streamId:'Timeline',event:{kind:'TimelineEvents',timelineEvents:flushed}}};
        setTimeout(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(notice)})),10);
        result={traceEvents:events};break;
      }
      case 'getCpuSamples':
        assert.deepEqual(q.params,{isolateId:'isolates/1',timeOriginMicros:90,timeExtentMicros:370});
        if(scenario==='cpu-failure') {
          queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({
            jsonrpc:'2.0',id:q.id,error:{code:-32603,message:secret}})})));
          return;
        }
        result=cpu;break;
    }
    queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({jsonrpc:'2.0',id:q.id,result})})));
  }
  close(){}
}
globalThis.WebSocket=MockWebSocket;
const lines=[];
const stdout=process.stdout.write.bind(process.stdout),stderr=process.stderr.write.bind(process.stderr);
process.stdout.write=(chunk)=>{lines.push(String(chunk));return true;};
process.stderr.write=(chunk)=>{lines.push(String(chunk));return true;};
process.argv=['node','p87-collect-mobile.mjs','--adb','MOCK_ADB_ONLY','--serial','mock-serial','--out',directory,
  '--apk',apk,'--build',build,'--suite','p5','--mode',['unprofiled','native-unprofiled'].includes(scenario)?'unprofiled':'diagnostic',
  ...(scenario.startsWith('native-')?['--native-stacks']:[]),
  ...(scenario==='user10'?['--user','10']:[]),
  ...(scenario==='package90'?['--package','com.example.remotepi.p90']:[])];
await import(pathToFileURL(collector).href);
process.stdout.write=stdout;process.stderr.write=stderr;
const hashFailure={
  'malformed-hash':'installed_apk_hash_malformed',
  'hash-wrong-base':'installed_apk_hash_malformed',
  'hash-mismatch':'installed_apk_hash_mismatch',
  'hash-command-failure':'adb_operation_failed',
  'hash-timeout':'installed_apk_hash_timeout',
}[scenario];
if(scenario==='existing-output') {
  assert.equal(process.exitCode,2,lines.join(''));
  process.exitCode=0;
  assert.deepEqual(calls,[]);
  assert.deepEqual(rpcCalls,[]);
  assert.match(lines.join(''),/p87 incomplete: output_dir_exists;/);
  assert.deepEqual(readdirSync(directory),['keep.txt']);
  assert.equal(readFileSync(join(directory,'keep.txt'),'utf8'),'existing evidence');
  stdout('PASS existing-output: existing evidence untouched; no device I/O\n');
} else if(scenario==='native-unprofiled') {
  assert.equal(process.exitCode,2,lines.join(''));process.exitCode=0;
  assert.deepEqual(calls,[]);assert.deepEqual(rpcCalls,[]);
  assert.ok(!fs.existsSync(directory));
  assert.match(lines.join(''),/native_stacks_requires_diagnostic/);
  stdout('PASS native-unprofiled: extra native walker rejected before device/output I/O\n');
} else if(['native-flag-not-applied','native-flag-failure'].includes(scenario)) {
  assert.equal(process.exitCode,2,lines.join(''));process.exitCode=0;
  const reason=scenario==='native-flag-not-applied'?'native_stack_flag_not_applied':'vm_rpc_setFlag_103';
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  assert.deepEqual(manifest.coverage.issues,[reason]);
  assert.equal(gate.state,'ready');
  assert.ok(!rpcCalls.includes('streamListen')&&!rpcCalls.includes('clearCpuSamples'));
  assert.ok(calls.some(a=>a[0]==='forward'&&a[1]==='--remove'));
  for(const file of readdirSync(directory))assert.ok(!readFileSync(join(directory,file),'utf8').includes(secret));
  assert.ok(!lines.join('').includes(secret));
  stdout('PASS '+scenario+': native flag failure preserved incomplete before capture\n');
} else if(hashFailure) {
  assert.equal(process.exitCode,2,lines.join(''));
  process.exitCode=0;
  const manifest=JSON.parse(readFileSync(join(directory,'manifest.json')));
  assert.equal(manifest.coverage.status,'incomplete');
  assert.deepEqual(manifest.coverage.issues,[hashFailure]);
  assert.ok(!calls.some(a=>a[0]==='exec-out'));
  assert.ok(!calls.some(a=>a[0]==='shell'&&a[1]==='am'),'reject before modifying app process');
  assert.equal(rpcCalls.length,0);
  for(const file of readdirSync(directory)) {
    const raw=readFileSync(join(directory,file),'utf8');
    assert.ok(!raw.includes(secret));
    assert.ok(!raw.includes('/data/app/mock/base.apk'));
  }
  assert.ok(!lines.join('').includes(secret));
  assert.ok(!lines.join('').includes('/data/app/mock/base.apk'));
  stdout(`PASS ${scenario}: on-device exact-base APK hash rejected before launch; no binary copy/device I/O\n`);
} else {
const ackFailed=['ack-disconnect','ack-wrong-state'].includes(scenario);
const publishConflict=scenario==='manifest-publish-conflict';
const outputFailed=publishConflict||scenario==='manifest-write-failure';
const incomplete=ackFailed||outputFailed||['missing-marker','cpu-failure','cpu-outside-window','invalid-bounds'].includes(scenario);
assert.equal(process.exitCode??0,incomplete?2:0,lines.join(''));
process.exitCode=0;
assert.ok(vmPolls>=4,'refresh VM isolates until main and its extension appear');
assert.ok(isolatePolls>=2,'retry until extension registration completes');
const manifest=publishConflict?null:JSON.parse(readFileSync(manifestPath,'utf8'));
if(publishConflict) {
  assert.equal(readFileSync(manifestPath,'utf8'),existingManifest);
} else {
assert.equal(manifest.coverage.status,incomplete?'incomplete':'complete');assert.equal(manifest.authenticatedVmUriPersisted,false);
assert.equal(manifest.androidUser,scenario==='user10'?10:0);
assert.equal(manifest.nativeStacksRequested,scenario==='native-stacks');
assert.equal(manifest.profileVmEnabled,scenario==='native-stacks');
assert.equal(flagSets.some(f=>f.name==='profile_vm'),scenario==='native-stacks');
assert.equal(manifest.package,scenario==='package90'?'com.example.remotepi.p90':'com.example.remotepi.p86');
assert.deepEqual(manifest.enabledProfilerFlags.find(f=>f.name==='max_profile_depth'),
  {name:'max_profile_depth',valueAsString:'255'});
for(const [name,entry] of Object.entries(manifest.files)) {
  assert.equal(entry.sha256,createHash('sha256').update(readFileSync(join(directory,name))).digest('hex'));
}
}
assert.equal(JSON.parse(readFileSync(join(directory,'capture.json'))).state,'captureComplete');
const ledger=JSON.parse(readFileSync(join(directory,'timeline-stream.json')));
if(scenario==='missing-marker') {
  assert.ok(manifest.coverage.issues.includes('timeline_endmarker_not_streamed'));
  assert.equal(ledger.endMarkerReceived,false);assert.equal(ledger.streamGap,true);
  assert.deepEqual(JSON.parse(readFileSync(join(directory,'timeline.json'))).traceEvents,events);
  assert.deepEqual(JSON.parse(readFileSync(join(directory,'cpu-samples.json'))),cpu);
} else if(scenario==='cpu-failure') {
  assert.ok(manifest.coverage.issues.includes('cpu_export_failed'));
  assert.ok(!('cpu-samples.json' in manifest.files));
  assert.equal(ledger.endMarkerReceived,true);
} else if(scenario==='cpu-outside-window') {
  assert.deepEqual(manifest.coverage.issues,['cpu_timestamp_outside_capture']);
  assert.deepEqual(JSON.parse(readFileSync(join(directory,'cpu-samples.json'))),cpu);
} else if(scenario==='invalid-bounds') {
  assert.ok(manifest.coverage.issues.includes('capture_bounds'));
  assert.ok(!rpcCalls.includes('getCpuSamples'));
  assert.ok(!('cpu-samples.json' in manifest.files));
} else if(ackFailed) {
  assert.deepEqual(manifest.coverage.issues,['export_acknowledgement_failed']);
  assert.deepEqual(ledger,{events,streamGap:false,endMarkerReceived:true});
  assert.deepEqual(JSON.parse(readFileSync(join(directory,'timeline.json'))).traceEvents,events);
  assert.deepEqual(JSON.parse(readFileSync(join(directory,'cpu-samples.json'))),cpu);
} else if(outputFailed) {
  if(manifest) assert.deepEqual(manifest.coverage.issues,['collector_output_persist_failed']);
  assert.match(lines.join(''),/p87 incomplete: collector_output_persist_failed;/);
  assert.deepEqual(ledger,{events,streamGap:false,endMarkerReceived:true});
  assert.deepEqual(JSON.parse(readFileSync(join(directory,'timeline.json'))).traceEvents,events);
  assert.deepEqual(JSON.parse(readFileSync(join(directory,'cpu-samples.json'))),cpu);
  assert.ok(!readdirSync(directory).some(name=>name.endsWith('.tmp')));
} else if(scenario==='unprofiled') {
  assert.ok(!rpcCalls.includes('getVMTimeline'));
  assert.ok(!rpcCalls.includes('getCpuSamples'));
  assert.equal(manifest.cpuEnabled,false);
  assert.deepEqual(manifest.timelineFlagsAfter.recordedStreams,[]);
} else assert.equal(ledger.endMarkerReceived,true);
if(incomplete){
  const marker=JSON.parse(readFileSync(join(directory,'collector-incomplete.json')));
  assert.equal(marker.status,'incomplete');
  assert.deepEqual(marker.issues,manifest?.coverage.issues??['collector_output_persist_failed']);
  if(outputFailed) assert.equal(marker.reason,'collector_output_persist_failed');
} else assert.ok(!readdirSync(directory).includes('collector-incomplete.json'));
assert.deepEqual(filesAtAck,manifest ? [...Object.keys(manifest.files)].sort() : [
  'capture.json','cpu-samples.json','timeline-flags-after.json','timeline-flags-before.json','timeline-stream.json','timeline.json']);
assert.equal(gate.state,ackFailed?'captureComplete':'exportAcknowledged');
assert.ok(calls.some(a=>a[0]==='forward'&&a[1]==='--remove'));
for(const file of readdirSync(directory))assert.ok(!readFileSync(join(directory,file),'utf8').includes(secret));
assert.ok(!lines.join('').includes(secret));
assert.ok(calls.some(a=>a[0]==='shell'&&a[1]==='am'&&a[2]==='start'));
assert.ok(calls.some(a=>a[0]==='shell'&&a[1]==='am'&&a[2]==='force-stop'&&a.includes('--user')));
for(const c of calls.filter(a=>a[0]==='shell'&&a[1]==='cmd'&&a[2]==='package'&&a[3]==='resolve-activity')) assert.equal(c[c.indexOf('--user')+1],scenario==='user10'?'10':'0');
for(const c of calls.filter(a=>a[0]==='shell'&&a[1]==='pm'&&a[2]==='path')) assert.equal(c[c.indexOf('--user')+1],scenario==='user10'?'10':'0');
for(const c of calls.filter(a=>a[0]==='shell'&&a[1]==='am'&&a[2]==='force-stop')) assert.equal(c.at(-1),scenario==='package90'?'com.example.remotepi.p90':'com.example.remotepi.p86');
assert.ok(calls.some(a=>a[0]==='logcat'&&a.includes('--pid=12345')));
assert.equal(calls.filter(a=>a[0]==='shell'&&a[1]==='sha256sum').length,1);
assert.ok(!calls.some(a=>a[0]==='exec-out'));
stdout(`PASS ${scenario}: launch/RPC discovery + block flush/fence + raw export/hash/URI-memory smoke; no device I/O\n`);

}
