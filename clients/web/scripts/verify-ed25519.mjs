/**
 * Ed25519 verification for the web client (plan 69 W4).
 *
 * Two independent layers of proof for the browser crypto:
 *   1. RFC 8032 §7.1 test vectors (TEST 1/2/3) through `pureTsVerify` — the
 *      pure-TS fallback must accept the canonical signatures and reject
 *      tampered ones.
 *   2. Cross-backend equivalence with Node's native Ed25519 (itself
 *      RFC-correct): both backends sign/verify each other's output, and the
 *      pure-TS fallback produces signatures Node accepts.
 *
 * Run: node scripts/verify-ed25519.mjs
 */

import { createPublicKey, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import {
  base64ToBytes,
  bytesToBase64,
  createEd25519Signer,
  detectEd25519Support,
  pureTsVerify,
  webcryptoVerify,
} from "../src/lib/remote-pi/ed25519.ts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** RFC 8032 §7.1 — TEST 1/2/3 (vectors fetched from rfc-editor.org). */
const RFC_VECTORS = [
  {
    name: "TEST 1",
    pk: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    msg: "",
    sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    name: "TEST 2",
    pk: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    msg: "72",
    sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
  {
    name: "TEST 3",
    pk: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    msg: "af82",
    sig: "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
  },
];

let failures = 0;
function check(label, condition, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function nodeKeyObjectFromRaw(rawB64) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawB64, "base64")]),
    format: "der",
    type: "spki",
  });
}

async function main() {
  // ── 1. capability detection ───────────────────────────────────────────────
  console.log("\n== capability detection ==");
  const detected = await detectEd25519Support();
  check("Node 22 detecta WebCrypto Ed25519 como backend nativo", detected === "webcrypto", `backend=${detected}`);

  // ── 2. RFC 8032 vectors via the pure-TS verifier ──────────────────────────
  console.log("\n== RFC 8032 §7.1 vectors (pure-ts fallback) ==");
  for (const vector of RFC_VECTORS) {
    const pk = hexToBytes(vector.pk);
    const msg = hexToBytes(vector.msg);
    const sig = hexToBytes(vector.sig);
    check(`${vector.name}: assinatura canônica verifica`, await pureTsVerify(pk, msg, sig));
    const tamperedMsg = msg.length > 0 ? new Uint8Array(msg) : new Uint8Array([0x01]);
    if (msg.length > 0) tamperedMsg[0] ^= 0x01;
    check(`${vector.name}: mensagem adulterada rejeitada`, !(await pureTsVerify(pk, tamperedMsg, sig)));
    const tamperedSig = new Uint8Array(sig);
    tamperedSig[10] ^= 0x01;
    check(`${vector.name}: assinatura adulterada rejeitada`, !(await pureTsVerify(pk, msg, tamperedSig)));
    check(`${vector.name}: assinatura curta rejeitada`, !(await pureTsVerify(pk, msg, sig.subarray(0, 63))));
  }

  // ── 3. cross-backend equivalence (deterministic signatures) ───────────────
  console.log("\n== cross-backend (webcrypto ⇄ pure-ts) ==");
  const message = new TextEncoder().encode("remote-pi web client handshake probe");
  for (const backend of ["webcrypto", "pure-ts"]) {
    const signer = await createEd25519Signer(backend);
    check(`${backend}: chave pública tem 32 bytes`, signer.publicKeyRaw.length === 32);
    check(
      `${backend}: publicKeyBase64 canônica (std, com padding)`,
      bytesToBase64(signer.publicKeyRaw) === signer.publicKeyBase64 &&
        signer.publicKeyBase64.length === 44 &&
        signer.publicKeyBase64.endsWith("="),
    );
    const signature = await signer.sign(message);
    check(`${backend}: assinatura tem 64 bytes`, signature.length === 64);

    // Node native accepts this signature.
    check(
      `${backend}: Node nativo aceita a assinatura`,
      nodeVerify(null, message, nodeKeyObjectFromRaw(signer.publicKeyBase64), Buffer.from(signature)),
    );
    // The other backend's verifier accepts it too.
    check(
      `${backend}: verificador do backend oposto aceita`,
      backend === "webcrypto"
        ? await pureTsVerify(signer.publicKeyRaw, message, signature)
        : await webcryptoVerify(signer.publicKeyRaw, message, signature),
    );
    // Ed25519 is deterministic: same signer + same message ⇒ same bytes.
    const again = await signer.sign(message);
    check(`${backend}: assinatura determinística`, bytesToBase64(signature) === bytesToBase64(again));
    // Different message ⇒ different signature.
    const other = await signer.sign(new TextEncoder().encode("outra mensagem"));
    check(`${backend}: mensagem diferente ⇒ assinatura diferente`, bytesToBase64(signature) !== bytesToBase64(other));
  }

  // ── 4. signer created by detection (no force) is usable ───────────────────
  console.log("\n== signer padrão (detecção) ==");
  const auto = await createEd25519Signer();
  const autoSig = await auto.sign(message);
  check(
    `backend ${auto.backend}: assinatura verificada pelo WebCrypto`,
    await webcryptoVerify(auto.publicKeyRaw, message, autoSig),
  );

  // ── 5. pair-uri epk round-trip (base64url → canonical) ────────────────────
  console.log("\n== encoding round-trip ==");
  const epkBytes = new Uint8Array(auto.publicKeyRaw);
  const epkUrl = bytesToBase64(epkBytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  check(
    "base64url → base64 padrão round-trip preserva os 32 bytes",
    base64ToBytes(
      epkUrl.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (epkUrl.length % 4)) % 4),
    ).length === 32,
  );

  console.log(
    failures === 0
      ? "\nverify-ed25519: ALL PASS\n"
      : `\nverify-ed25519: ${failures} FAILURE(S)\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
