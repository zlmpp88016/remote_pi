/**
 * Turning a picked `File` into the WIRE image shape (`data` base64 + `mime`).
 *
 * Held in the wire shape rather than a `File`/blob URL so the preview and the
 * send path use the exact bytes that will travel — nothing is re-encoded
 * between picking and sending.
 *
 * DOWNSCALING: a phone photo is many megabytes and the host pays for every
 * byte. Images are re-encoded to JPEG at a 1568px long edge (Anthropic's
 * recommended bound for vision input) instead of being sent raw. Every step
 * degrades to the ORIGINAL bytes rather than failing: an undecodable image, a
 * missing 2D context or a malformed data URL all fall back to the raw base64,
 * because refusing to attach is worse than attaching something large.
 */

import type { WireImage } from "@/lib/remote-pi/protocol";

/** Long-edge bound for the re-encode. */
const MAX_EDGE = 1568;

/** JPEG quality for the re-encode. */
const JPEG_QUALITY = 0.82;

/** The file's bytes, unmodified. */
async function rawBase64(file: File): Promise<WireImage> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return { data: btoa(binary), mime: file.type };
}

/**
 * Reads one image file into the wire shape, downscaling when possible.
 *
 * @param file - an image the user picked.
 * @returns base64 `data` plus the `mime` the bytes actually are.
 */
export async function fileToWireImage(file: File): Promise<WireImage> {
  if (typeof document === "undefined") return rawBase64(file);
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = url;
    });
    const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext("2d");
    if (ctx === null) return rawBase64(file);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return rawBase64(file);
    return { data: dataUrl.slice(comma + 1), mime: "image/jpeg" };
  } catch {
    return rawBase64(file);
  } finally {
    URL.revokeObjectURL(url);
  }
}
