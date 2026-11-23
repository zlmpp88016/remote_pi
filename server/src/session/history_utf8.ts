/**
 * Plan 86 P2 — a fast, allocation-free UTF-8 decoder for raw JSON string bytes.
 *
 * The tokenizer and the body sidecar both decode JSON string content that can
 * be 100 MiB. `TextDecoder.decode` per escape-delimited run is correct but too
 * slow for millions of tiny runs, and a per-code-point `Buffer.from` would be
 * worse. This state machine validates UTF-8 exactly like Node's non-fatal
 * decoder (invalid/overlong/surrogate/out-of-range sequences become U+FFFD)
 * and emits code points through a callback.
 *
 * Keeping ONE implementation is also what makes the tokenizer's digest and the
 * sidecar's bytes agree for escapes/surrogates/invalid UTF-8.
 */

export class HistoryUtf8Decoder {
  private needed = 0;
  private codePoint = 0;
  private minimum = 0;

  /** Feed one byte. Emits zero or more code points (invalid bytes → U+FFFD). */
  push(byte: number, emit: (cp: number) => void): void {
    let current = byte;
    for (;;) {
      if (this.needed === 0) {
        if (current < 0x80) {
          emit(current);
          return;
        }
        if (current >= 0xc2 && current <= 0xdf) {
          this.needed = 1;
          this.codePoint = current & 0x1f;
          this.minimum = 0x80;
          return;
        }
        if (current >= 0xe0 && current <= 0xef) {
          this.needed = 2;
          this.codePoint = current & 0x0f;
          this.minimum = 0x800;
          return;
        }
        if (current >= 0xf0 && current <= 0xf4) {
          this.needed = 3;
          this.codePoint = current & 0x07;
          this.minimum = 0x10000;
          return;
        }
        emit(0xfffd);
        return;
      }
      if ((current & 0xc0) !== 0x80) {
        // The pending sequence is invalid; emit one replacement and reprocess
        // this byte as a potential lead byte.
        this.needed = 0;
        this.codePoint = 0;
        this.minimum = 0;
        emit(0xfffd);
        continue;
      }
      this.codePoint = (this.codePoint << 6) | (current & 0x3f);
      this.needed -= 1;
      if (this.needed > 0) return;
      const cp = this.codePoint;
      const minimum = this.minimum;
      this.needed = 0;
      this.codePoint = 0;
      this.minimum = 0;
      if (
        cp < minimum ||
        cp > 0x10ffff ||
        (cp >= 0xd800 && cp <= 0xdfff)
      ) {
        emit(0xfffd);
      } else {
        emit(cp);
      }
      return;
    }
  }

  /** End of the raw run: an incomplete sequence becomes one U+FFFD. */
  flush(emit: (cp: number) => void): void {
    if (this.needed > 0) {
      this.needed = 0;
      this.codePoint = 0;
      this.minimum = 0;
      emit(0xfffd);
    }
  }
}

/** Encode one code point into [buffer] at [offset]; returns the byte length. */
export function writeUtf8CodePoint(cp: number, buffer: Uint8Array, offset: number): number {
  if (cp < 0x80) {
    buffer[offset] = cp;
    return 1;
  }
  if (cp < 0x800) {
    buffer[offset] = 0xc0 | (cp >> 6);
    buffer[offset + 1] = 0x80 | (cp & 0x3f);
    return 2;
  }
  if (cp < 0x10000) {
    buffer[offset] = 0xe0 | (cp >> 12);
    buffer[offset + 1] = 0x80 | ((cp >> 6) & 0x3f);
    buffer[offset + 2] = 0x80 | (cp & 0x3f);
    return 3;
  }
  buffer[offset] = 0xf0 | (cp >> 18);
  buffer[offset + 1] = 0x80 | ((cp >> 12) & 0x3f);
  buffer[offset + 2] = 0x80 | ((cp >> 6) & 0x3f);
  buffer[offset + 3] = 0x80 | (cp & 0x3f);
  return 4;
}
