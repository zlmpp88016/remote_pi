// Collector integration smoke: all device and websocket I/O is mocked in memory.
// No ADB executable, emulator, network or auth store is accessed.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync,readdirSync,mkdirSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const collector=process.env.P87_COLLECTOR ?? 'C:/Users/zlmpp/AppData/Local/Temp/p87-collect-mobile.mjs';
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
const calls=[];
childProcess.spawnSync=(_command,args)=>{
  assert.equal(_command,'MOCK_ADB_ONLY');
  assert.equal(args[0],'-s');assert.equal(args[1],'mock-serial');
  const a=args.slice(2);calls.push(a);
  let output='';
  if(a[0]==='shell'&&a[1]==='cmd') output='com.example.remotepi.p86/com.example.remotepi.MainActivity';
  else if(a[0]==='shell'&&a[1]==='pm') output='package:/data/app/mock/base.apk';
  else if(a[0]==='exec-out') output=readFileSync(apk);
  else if(a[0]==='shell'&&a[1]==='am'&&a[2]==='start') {
    assert.equal(a[a.indexOf('endless-trace-buffer')+1],'true');
    assert.equal(a[a.indexOf('enable-dart-profiling')+1],'true');
    const flags=a[a.indexOf('dart-flags')+1].split(',');
    // switches.cc ParseCommaDelimited + non-release kAllowedDartFlags.
    // Rejects the original space-delimited forbidden flags.
    assert.deepEqual(flags,['--sample-buffer-duration=180','--profile_period=1000']);
    assert.ok(flags.every(f=>/^--(?:sample-buffer-duration|profile_period)=\d+$/.test(f)));
    assert.equal(a[4],'com.example.remotepi.p86/com.example.remotepi.MainActivity');
  }
  else if(a[0]==='shell'&&a[1]==='pidof') output='12345';
  else if(a[0]==='logcat') output=`Dart VM service is listening on http://127.0.0.1:1234/${secret}=/`;
  else if(a[0]==='forward'&&a[1]==='tcp:0') output='54321';
  return {status:0,stdout:output,stderr:''};
};
syncBuiltinESMExports();
let streams=[];
let profiler='true';
class MockWebSocket extends EventTarget {
  constructor(uri){super();assert.ok(uri.includes(secret));queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  send(text){
    const q=JSON.parse(text);let result={type:'Success'};
    switch(q.method){
      case 'getVM':result={pid:12345,isolates:[{id:'isolates/1'}]};break;
      case 'getIsolate':result={id:'isolates/1',serviceExtensionRPCs:['ext.remote_pi.p87.capture'],rootLib:{uri:'file:///p5_profile_main.dart'}};break;
      case 'getVMTimelineFlags':result={recorderName:'Ring',availableStreams:['Dart','Embedder','GC','Compiler'],recordedStreams:[...streams]};break;
      case 'setVMTimelineFlags':streams=q.params.recordedStreams;break;
      case 'setFlag':if(q.params.name==='profiler')profiler=q.params.value;break;
      case 'getFlagList':result={flags:[{name:'profiler',value:profiler}]};break;
      case 'ext.remote_pi.p87.capture':
        if(q.params.action==='start')gate.state='capturing';
        if(q.params.action==='captureComplete'){
          gate.state='captureComplete';
          const notice={method:'streamNotify',params:{streamId:'Timeline',event:{kind:'TimelineEvents',timelineEvents:events}}};
          queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(notice)})));
        }
        if(q.params.action==='exportAcknowledged')gate.state='exportAcknowledged';
        result=structuredClone(gate);break;
      case 'getVMTimeline':result={traceEvents:events};break;
      case 'getCpuSamples':result=cpu;break;
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
  '--apk',apk,'--build',build,'--suite','p5','--mode','diagnostic'];
await import(pathToFileURL(collector).href);
process.stdout.write=stdout;process.stderr.write=stderr;
assert.ok(!process.exitCode,lines.join(''));
const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
assert.equal(manifest.coverage.status,'complete');assert.equal(manifest.authenticatedVmUriPersisted,false);
assert.equal(manifest.files['cpu-samples.json'].sha256,createHash('sha256').update(readFileSync(join(directory,'cpu-samples.json'))).digest('hex'));
assert.equal(gate.state,'exportAcknowledged');
assert.ok(calls.some(a=>a[0]==='forward'&&a[1]==='--remove'));
for(const file of readdirSync(directory))assert.ok(!readFileSync(join(directory,file),'utf8').includes(secret));
assert.ok(!lines.join('').includes(secret));
assert.ok(calls.some(a=>a[0]==='shell'&&a[1]==='am'&&a[2]==='start'));
assert.ok(calls.some(a=>a[0]==='logcat'&&a.includes('--pid=12345')));
stdout('PASS launch allowlist/comma parsing + mocked collector full protocol/export/hash/URI-memory smoke; no device I/O\n');
