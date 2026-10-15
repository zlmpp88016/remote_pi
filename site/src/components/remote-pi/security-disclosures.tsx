/* Fixed, client-authored security disclosures (review F4).
 *
 * These statements are STATIC string constants owned by the web client: they
 * never come from the host, the relay or a transient error, and they contain
 * no token, no key material and no host-provided text. They exist so a user
 * reads the real limits of this client (unencrypted local storage, no E2EE,
 * TLS-only transport protection, Origin/allow-list caveats, bearer-token
 * lifetime) instead of inferring safety from a padlock or a green pill.
 *
 * Grounding (all read, none restated from memory):
 *   • src/lib/remote-pi/persistence.ts — the stored record is exactly
 *     relayUrl/hostEpk/name/roomId/token under `remote-pi-web-session-v1`;
 *     there is no private key field and `localStorage` is used unencrypted.
 *   • server/src/session + relay `ct` — `ct` is base64(JSON), not E2EE.
 *   • relay/src/origin.rs — the Origin allow-list is a browser-context
 *     restriction, "not an authentication mechanism"; empty/unset is
 *     permissive and Origin-less handshakes are always accepted.
 *   • server/src/daemon/host_bridge.ts — the host room drops non-pair
 *     traffic from peers outside the allow-list only while
 *     `allowedPeers.size > 0`; `pair_request` is carved out of that check, so
 *     an unknown peer may always ask for pairing. The request itself is still
 *     authorized: server/src/daemon/host_control.ts only persists the peer
 *     when `host_pairing.ts` reports the token `ok` (`unknown`/`expired`/
 *     `consumed` tokens are rejected).
 *   • server/src/pairing/host_pairing.ts — a persistent token stays valid
 *     until `--rotate`; rotation invalidates the token, not the peers already
 *     registered with it.
 *
 * Rendering note: native <details>/<summary> only — no JS, no state, no wire.
 */
import type { ReactNode } from "react";

export interface SecurityDisclosure {
  /** Stable key (static list, never randomized). */
  id: string;
  /** Fixed, client-authored sentence. No token/key/host value is ever here. */
  text: string;
}

export const SECURITY_DISCLOSURES: readonly SecurityDisclosure[] = [
  {
    id: "storage-unencrypted",
    text: "The pairing token is kept in this browser's localStorage without encryption, so any script running on this origin can read it.",
  },
  {
    id: "no-private-key",
    text: "The Ed25519 private key is not persisted: it is generated in memory for the current connection and is not written to disk.",
  },
  {
    id: "stored-schema",
    text: "The saved session record is exactly relayUrl, hostEpk, name, roomId and token — no private key and no transcript.",
  },
  {
    id: "no-e2ee",
    text: "Messages are not end-to-end encrypted: ct is base64-encoded JSON, so the relay operator can read their contents.",
  },
  {
    id: "transport",
    text: "wss:// protects the transport with TLS while it is in transit; ws:// is plaintext and gives the transport no protection.",
  },
  {
    id: "origin-not-auth",
    text: "The relay's Origin restriction is not authentication: an empty allow-list accepts every origin, and clients that send no Origin header are always accepted.",
  },
  {
    id: "host-allow-list",
    text: "An unknown peer may always ask the host to pair, but pairing succeeds only with a valid pairing token the host still accepts — unknown, expired or already-used tokens are rejected. Requests other than pairing are rejected for unknown peers only while the host's allow-list is non-empty, so an empty allow-list is not fail-closed.",
  },
  {
    id: "bearer-lifetime",
    text: "A leaked bearer token may register new clients. A persistent token stays valid until it is rotated, and rotating it does not revoke peers that already registered.",
  },
];

const SUMMARY_LABEL = "Security & privacy disclosures";

export interface SecurityDisclosuresProps {
  /** Optional DOM id, so a verification pass can address one placement. */
  id?: string;
  /** Placement-only spacing; the section keeps its own compact chrome. */
  className?: string;
}

/**
 * Collapsed-by-default disclosure list. `<details>` content is present in the
 * DOM while collapsed (and `textContent` includes it), and the summary is the
 * keyboard-reachable control that reveals it. There is deliberately no
 * `aria-hidden` and no `title`-only shortcut here.
 */
export function SecurityDisclosures({ id, className }: SecurityDisclosuresProps): ReactNode {
  return (
    <details
      id={id}
      className={`min-w-0 max-w-full rounded-[12px] border border-white/10 bg-white/[0.02] px-3 py-2 ${className ?? ""}`}
    >
      <summary className="cursor-pointer break-words text-[12px] font-semibold text-[#d4d4d4] transition hover:text-white">
        {SUMMARY_LABEL}
      </summary>
      <ul className="mt-2 grid list-disc gap-1.5 pl-4">
        {SECURITY_DISCLOSURES.map((item) => (
          <li
            key={item.id}
            className="break-words text-[11.5px] leading-relaxed text-[#a3a3a3]"
          >
            {item.text}
          </li>
        ))}
      </ul>
    </details>
  );
}
