// Coverage rules shared by the OS-scratch collector and deterministic tests.
// Fail closed: this validates capture coverage, never a performance budget.
export const CPU_SAMPLE_PERIOD_US = 1000;
const CPU_EDGE_SLACK_US = 20000;

export function hasCaptureBounds(gate) {
  return Number.isSafeInteger(gate.begin_us) && gate.begin_us >= 0 &&
    Number.isSafeInteger(gate.end_us) && gate.end_us > gate.begin_us;
}

export function assessCapture({gate, timeline, cpu, timelineBefore, timelineAfter,
  streamEvents = [], streamGap = false, cpuEnabled, expectedBuild, mode}) {
  const issues = [];
  const require = (ok, label) => { if (!ok) issues.push(label); };
  require(gate.state === 'captureComplete', 'capture_not_complete');
  require(!gate.failure, 'harness_failure');
  require(gate.build === expectedBuild, 'build_mismatch');
  const validBounds = hasCaptureBounds(gate);
  require(validBounds, 'capture_bounds');
  const result = gate.result ?? {};
  const frames = gate.suite === 'p5' ? result : result.frames;
  const raw = frames?.raw_timings ?? [];
  const byVsync = new Map(raw.map(f => [f.vsync_us, f]));
  const phases = frames?.phases ?? [];
  if (gate.suite === 'p5') {
    require(result.assertions_passed === true, 'p5_assertions');
    require(JSON.stringify(phases.map(p => p.name)) === JSON.stringify(
      ['apply100', 'prepend', 'duplicate', 'same_length']), 'four_phases');
  } else {
    const stages = result.stages;
    require(stages?.dropped === 0, 'stage_ring_loss');
    for (const path of ['registered_workspace_directory', 'history_list', 'history_read']) {
      const sample = stages?.samples?.find(s => s.path === path && !s.cache_hit && !s.failed &&
        ['intent_us','request_us','transport_request_us','send_begin_us','send_complete_us',
          'typed_reply_us','map_begin_us','state_apply_us','real_post_frame_us',
          'viewport_vsync_us','viewport_raster_finish_us','viewport_frame_number']
          .every(k => Number.isInteger(s[k])));
      require(Boolean(sample), `stage_coverage_${path}`);
      require(sample && raw.some(frame => frame.frame_number === sample.viewport_frame_number &&
        frame.vsync_us === sample.viewport_vsync_us &&
        frame.raster_finish_us === sample.viewport_raster_finish_us),
      `stage_viewport_frame_unmatched_${path}`);
    }
  }
  require(raw.length > 0 && phases.length > 0, 'frame_samples');
  for (const p of phases) {
    require(p.open_vsync_us < p.target_vsync_us && p.target_vsync_us < p.close_vsync_us,
      `bilateral_bounds_${p.name}`);
    require(byVsync.has(p.target_vsync_us) && byVsync.has(p.close_vsync_us), `frame_fences_${p.name}`);
    for (const v of frames.observed_vsync_us ?? []) {
      if (v > p.open_vsync_us && v <= p.close_vsync_us) require(byVsync.has(v), `missing_raw_${v}`);
    }
  }
  if (mode === 'unprofiled') {
    require(cpuEnabled === false, 'unprofiled_cpu_enabled');
    require((timelineAfter?.recordedStreams?.length ?? -1) === 0, 'unprofiled_streams_enabled');
    return {status:issues.length ? 'incomplete' : 'complete', issues,
      diagnostic:false, performanceBudgetEvaluated:false};
  }
  require(cpuEnabled === true, 'cpu_profiler_disabled');
  const events = timeline?.traceEvents ?? [];
  require(events.length > 0, 'timeline_empty');
  require(!streamGap && streamEvents.length > 0, 'timeline_stream_gap_or_empty');
  const has = (name, phase) => events.some(e => e.name === name &&
    (!phase || e.args?.phase === phase));
  require(has('p87_capture_begin') && has('p87_capture_end'), 'timeline_endmarkers');
  require(['Ring','Endless','Startup'].includes(timelineAfter?.recorderName), 'unexportable_recorder');
  require(JSON.stringify(timelineBefore?.recordedStreams) === JSON.stringify(timelineAfter?.recordedStreams),
    'timeline_streams_changed');
  for (const stream of ['Dart','Embedder','GC','Compiler']) {
    require(timelineAfter?.recordedStreams?.includes(stream), `missing_stream_${stream}`);
  }
  // A streaming ledger survives a VM ring wrap. Every streamed event in the
  // capture interval must remain present in the final VM export; otherwise the
  // ordinary trace is incomplete, even though the loss ledger was retained.
  const fingerprint = e => JSON.stringify([e.name,e.ph,e.ts,e.tid,e.pid,e.id,e.dur]);
  const exported = new Set(events.map(fingerprint));
  require(streamEvents.filter(e => e.ts >= gate.begin_us && e.ts <= gate.end_us)
    .every(e => exported.has(fingerprint(e))), 'timeline_buffer_overflow_or_loss');
  const samples = Array.isArray(cpu?.samples) ? cpu.samples : [];
  const functions = Array.isArray(cpu?.functions) ? cpu.functions : [];
  require(samples.length > 0 && samples.length === cpu.sampleCount && functions.length > 0,
    'cpu_samples_or_functions_missing');
  require(samples.every(s => !s?.truncated && Array.isArray(s?.stack) && s.stack.length > 0 &&
    s.stack.every(i => Number.isInteger(i) && i >= 0 && i < functions.length)),
    'cpu_truncated_or_invalid_stack');
  if (samples.length > 0) {
    require(cpu.samplePeriod === CPU_SAMPLE_PERIOD_US, 'cpu_sample_period_mismatch');
  }
  const inCapture = s => validBounds && Number.isSafeInteger(s?.timestamp) &&
    s.timestamp >= gate.begin_us && s.timestamp <= gate.end_us;
  require(samples.every(inCapture), 'cpu_timestamp_outside_capture');
  // Edge sampling and per-phase sampling detect CPU ring clipping without
  // interpreting an idle gap in the middle as CPU work.
  require(samples.some(s => inCapture(s) && s.timestamp - gate.begin_us <= CPU_EDGE_SLACK_US),
    'cpu_start_coverage');
  require(samples.some(s => inCapture(s) && gate.end_us - s.timestamp <= CPU_EDGE_SLACK_US),
    'cpu_end_coverage');
  for (const p of phases) {
    if (gate.suite === 'p5') {
      require(has('p87_phase_sealed', p.name), `timeline_phase_${p.name}`);
      require(samples.some(s => inCapture(s) &&
        s.timestamp >= p.open_vsync_us && s.timestamp <= p.close_vsync_us),
        `cpu_phase_${p.name}`);
    }
    const frame = byVsync.get(p.target_vsync_us);
    require(frame && events.some(e => e.ts >= frame.vsync_us &&
      e.ts <= frame.raster_finish_us && /flutter|embedder/i.test(e.cat ?? '')),
      `timeline_frame_${p.name}`);
  }
  return {status:issues.length ? 'incomplete' : 'complete', issues,
    diagnostic:true, performanceBudgetEvaluated:false,
    timelineEvents:events.length, streamedEvents:streamEvents.length,
    cpuSamples:samples.length, functions:functions.length,
    nativeRasterCpuProfile:false};
}
