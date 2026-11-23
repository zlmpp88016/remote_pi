import test from 'node:test';
import assert from 'node:assert/strict';
import {assessCapture} from '../../tool/history_perf/p87_capture_coverage.mjs';

function fixture(scale = 1) {
  const ts = value => value * scale;
  const names = ['apply100','prepend','duplicate','same_length'];
  const phases = names.map((name,i) => ({name,open_vsync_us:ts(100+i*100),
    target_vsync_us:ts(120+i*100),close_vsync_us:ts(140+i*100)}));
  const raw = phases.flatMap(p => [p.target_vsync_us,p.close_vsync_us].map(v =>
    ({vsync_us:v,raster_finish_us:v+8})));
  const traceEvents = [{name:'p87_capture_begin',ts:ts(90),ph:'i'},
    ...phases.flatMap(p => [{name:'p87_phase_sealed',args:{phase:p.name},ts:p.close_vsync_us+1,ph:'i'},
      {name:'Frame',cat:'flutter',ts:p.target_vsync_us+1,ph:'X'}]),
    {name:'p87_capture_end',ts:ts(460),ph:'i'}];
  const flags = {recorderName:'Ring',recordedStreams:['Dart','Embedder','GC','Compiler']};
  return {gate:{suite:'p5',state:'captureComplete',build:'test',begin_us:ts(90),end_us:ts(460),
      result:{assertions_passed:true,phases,raw_timings:raw,observed_vsync_us:raw.map(r=>r.vsync_us)}},
    timeline:{traceEvents},cpu:{sampleCount:4,samples:phases.map(p=>({timestamp:p.target_vsync_us,stack:[0]})),
      functions:[{function:{name:'work'}}],samplePeriod:1000},
    timelineBefore:flags,timelineAfter:flags,streamEvents:structuredClone(traceEvents),
    streamGap:false,cpuEnabled:true,expectedBuild:'test',mode:'diagnostic'};
}

test('complete diagnostic has four phase/target frame coverage and functions', () => {
  assert.equal(assessCapture(fixture()).status,'complete');
});

function addCpuSamples(f, timestamps) {
  f.cpu.samples.push(...timestamps.map(timestamp => ({timestamp,stack:[0]})));
  f.cpu.sampleCount = f.cpu.samples.length;
}

test('CPU samples outside the capture cannot satisfy either edge and are not discarded', () => {
  const f = fixture(1000);
  addCpuSamples(f, [f.gate.begin_us - 1, f.gate.end_us + 1]);
  const original = structuredClone(f.cpu);
  const result = assessCapture(f);
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.issues, ['cpu_timestamp_outside_capture','cpu_start_coverage','cpu_end_coverage']);
  assert.equal(result.cpuSamples, original.sampleCount);
  assert.deepEqual(f.cpu, original);
});

test('CPU edges are inclusive at 20 ms; a longer reported period cannot widen the gate', () => {
  const f = fixture(1000);
  addCpuSamples(f, [f.gate.begin_us + 20000, f.gate.end_us - 20000]);
  assert.equal(assessCapture(f).status, 'complete');
  const [first,last] = f.cpu.samples.slice(-2);
  first.timestamp++;
  last.timestamp--;
  assert.deepEqual(assessCapture(f).issues, ['cpu_start_coverage','cpu_end_coverage']);
  f.cpu.samplePeriod = 10000;
  assert.deepEqual(assessCapture(f).issues, ['cpu_sample_period_mismatch','cpu_start_coverage','cpu_end_coverage']);
});

test('noninteger gate bounds and CPU timestamps fail closed', () => {
  const badBound = fixture();
  badBound.gate.end_us = '460';
  assert.ok(assessCapture(badBound).issues.includes('capture_bounds'));
  const badSample = fixture();
  badSample.cpu.samples.at(-1).timestamp = '420';
  assert.ok(assessCapture(badSample).issues.includes('cpu_timestamp_outside_capture'));
});
for(const [label,mutate] of [
  ['disabled CPU', f=>f.cpuEnabled=false],
  ['missing functions', f=>f.cpu.functions=[]],
  ['missing end marker', f=>f.timeline.traceEvents.pop()],
  ['missing phase', f=>f.gate.result.phases.pop()],
  ['late final timing absent', f=>f.gate.result.raw_timings.pop()],
  ['buffer overflow ledger mismatch', f=>f.streamEvents.push({name:'lost',ts:200,ph:'i'})],
  ['timeline stream disconnect', f=>f.streamGap=true],
  ['truncated CPU stack', f=>f.cpu.samples[0].truncated=true],
  ['wrong authenticated endpoint build', f=>f.gate.build='other'],
]) {
  test(`incomplete on ${label}`,()=>{
    const f=fixture();mutate(f);
    assert.equal(assessCapture(f).status,'incomplete');
  });
}
test('unprofiled is separate, requires CPU and timeline disabled, evaluates no budget', () => {
  const f=fixture();f.mode='unprofiled';f.cpuEnabled=false;
  f.timelineAfter={recordedStreams:[]};f.timeline={};f.cpu={};
  const result=assessCapture(f);
  assert.equal(result.status,'complete');assert.equal(result.diagnostic,false);
  assert.equal(result.performanceBudgetEvaluated,false);
  f.cpuEnabled=true;assert.equal(assessCapture(f).status,'incomplete');
});
test('browse requires all three noncached paths through viewport raster',()=>{
  const f=fixture();f.gate.suite='browse';f.mode='unprofiled';f.cpuEnabled=false;
  f.timelineAfter={recordedStreams:[]};
  const fields=['intent_us','request_us','transport_request_us','send_begin_us','send_complete_us',
    'typed_reply_us','map_begin_us','state_apply_us','real_post_frame_us','viewport_vsync_us','viewport_raster_finish_us'];
  const frames=f.gate.result;
  const samples=['registered_workspace_directory','history_list','history_read'].map((path,i)=>{
    const frame=frames.raw_timings[i];
    frame.frame_number=100+i;
    return {path,cache_hit:false,failed:false,
      ...Object.fromEntries(fields.map((k,n)=>[k,n+1])),
      viewport_frame_number:frame.frame_number,
      viewport_vsync_us:frame.vsync_us,viewport_raster_finish_us:frame.raster_finish_us};
  });
  f.gate.result={frames,stages:{dropped:0,samples}};
  assert.equal(assessCapture(f).status,'complete');
  delete f.gate.result.stages.samples[2].viewport_raster_finish_us;
  assert.equal(assessCapture(f).status,'incomplete');
  const mismatch=fixture();
  mismatch.gate.suite='browse';mismatch.mode='unprofiled';mismatch.cpuEnabled=false;
  mismatch.timelineAfter={recordedStreams:[]};
  const mismatchFrames=mismatch.gate.result;
  const mismatchSamples=['registered_workspace_directory','history_list','history_read'].map((path,i)=>{
    const frame=mismatchFrames.raw_timings[i];
    frame.frame_number=200+i;
    return {path,cache_hit:false,failed:false,
      ...Object.fromEntries(fields.map((k,n)=>[k,n+1])),
      viewport_frame_number:frame.frame_number,
      viewport_vsync_us:frame.vsync_us,viewport_raster_finish_us:frame.raster_finish_us};
  });
  mismatch.gate.result={frames:mismatchFrames,stages:{dropped:0,samples:mismatchSamples}};
  mismatchSamples[2].viewport_frame_number++;
  assert.ok(assessCapture(mismatch).issues.includes('stage_viewport_frame_unmatched_history_read'));
});
