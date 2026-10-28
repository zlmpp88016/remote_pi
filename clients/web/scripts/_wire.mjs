/**
 * Decoding for relay WebSocket frames.
 *
 * The relay wraps every payload in `{peer, ct}` where `ct` is base64 of the next
 * JSON document, and the nesting DEPTH DEPENDS ON DIRECTION:
 *   browser -> host : host_forward -> payload
 *   host -> browser : host_message -> payload
 * so peeling a fixed number of levels leaves the envelope `type` on the outside
 * and every `msg.type` check silently sees "host_forward" instead.
 *
 * This lived inside one E2E script until a second script needed it and matched on
 * the raw (still-encoded) payload instead — so its wire assertions all reported
 * "no traffic" while the traffic was there. One implementation, imported by both,
 * is the fix.
 */
export function decodeFrame(raw) {
  let outer;
  try {
    outer = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!outer || typeof outer.ct !== "string") return null;
  let inner;
  try {
    inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8"));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 4 && inner && typeof inner.ct === "string"; depth++) {
    try {
      inner = JSON.parse(Buffer.from(inner.ct, "base64").toString("utf8"));
    } catch {
      break;
    }
  }
  return inner;
}

/** Decoded frames of `type` from a raw frame buffer. */
export function framesOfType(rawFrames, type) {
  const out = [];
  for (const raw of rawFrames) {
    const msg = decodeFrame(raw);
    if (msg && msg.type === type) out.push(msg);
  }
  return out;
}
