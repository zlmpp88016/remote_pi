"use client";

/* Entry surface of the Remote Pi web client: relay address + pairing code.
 *
 * Presentation only — every wire call (parse, connect, pair, host hello) stays
 * in the route's client container, which owns the session and the refs. The
 * launcher receives values and reports intent, so it holds no network state.
 *
 * Visual source: docs/web_app/原型/index.html (#launcher) + styles.css §3.
 */
import type { FormEvent } from "react";

import { Icon, RemotePiMark } from "./icons";
import { SecurityDisclosures } from "./security-disclosures";
import { ErrorState, Loading } from "./states";

export interface StoredPairingSummary {
  name: string;
  relayUrl: string;
}

export interface ConnectionLauncherProps {
  address: string;
  onAddressChange: (value: string) => void;
  code: string;
  onCodeChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** Progress label while a pairing attempt is in flight. */
  busy: string | null;
  /** Diagnostic text, rendered as plain text. */
  error: string | null;
  /** A stored pairing is being re-established on mount. */
  resuming: boolean;
  /** A previously stored pairing, if any — real data, never a fixture. */
  stored: StoredPairingSummary | null;
  onForgetStored: () => void;
}

const FIELD =
  "w-full rounded-[10px] border border-white/15 bg-white/[0.045] px-3 text-[14px] text-white outline-none transition placeholder:text-[#6b6b6b] hover:border-white/25 focus:border-[#4fc3f7] focus:bg-white/[0.02]";

export function ConnectionLauncher({
  address,
  onAddressChange,
  code,
  onCodeChange,
  onSubmit,
  busy,
  error,
  resuming,
  stored,
  onForgetStored,
}: ConnectionLauncherProps) {
  const disabled = busy !== null || resuming;

  return (
    <div className="grid min-h-full place-items-center px-4 py-12">
      <div className="w-full min-w-0 max-w-[462px]">
        <div className="mb-7 flex items-center gap-3">
          <span className="grid size-[38px] place-items-center rounded-[11px] border border-[rgba(79,195,247,0.3)] bg-[rgba(79,195,247,0.13)] text-[#4fc3f7]">
            <RemotePiMark size={20} />
          </span>
          <div>
            <div
              className="text-[18px] font-semibold tracking-[-0.01em] text-white"
              style={{ fontFamily: "var(--ff-display)" }}
            >
              Remote Pi
            </div>
            <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#6b6b6b]">
              Web client
            </div>
          </div>
        </div>

        <h1
          className="mb-2 text-[30px] font-semibold leading-[1.14] tracking-[-0.02em] text-white"
          style={{ fontFamily: "var(--ff-display)" }}
        >
          Connect to a host
        </h1>
        <p className="mb-6 text-[14.5px] leading-relaxed break-words [overflow-wrap:anywhere] text-[#a3a3a3]">
          Paste the relay address and the pairing code printed by{" "}
          <code className="font-mono text-[12.5px] text-[#d4d4d4]">remote-pi pair</code> on the
          machine you want to drive. No Pi has to be running.
        </p>

        {resuming ? <Loading label="Restoring the stored pairing…" /> : null}

        <form className="grid gap-3.5" onSubmit={onSubmit}>
          <label className="grid gap-[7px]">
            <span className="text-[12.5px] font-medium text-[#a3a3a3]">Relay address</span>
            <input
              className={`${FIELD} h-10`}
              value={address}
              onChange={(event) => onAddressChange(event.target.value)}
              placeholder="wss://relay.example.com"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
            />
          </label>

          <label className="grid gap-[7px]">
            <span className="text-[12.5px] font-medium text-[#a3a3a3]">Pairing code</span>
            <textarea
              className={`${FIELD} min-h-[74px] resize-y py-2.5 font-mono text-[12.5px] leading-6`}
              value={code}
              onChange={(event) => onCodeChange(event.target.value)}
              placeholder="remotepi://pair?t=…&epk=…&n=…"
              spellCheck={false}
              disabled={disabled}
            />
            <span className="break-words text-[12px] text-[#a3a3a3]">
              The URI itself is the code — paste it whole. The token in it is never logged or
              re-displayed, and it is stored in this browser (see the disclosures below).
            </span>
          </label>

          <button
            type="submit"
            disabled={disabled}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-[10px] bg-[#4fc3f7] px-4 text-[14px] font-semibold text-[#04222e] transition hover:bg-[#7ad4fa] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy ?? "Connect"}
          </button>

          {error ? <ErrorState title="Pairing failed" detail={error} /> : null}
        </form>

        {/* Fixed security disclosures — static client text, shown on the
            launcher regardless of any pairing error above and independent of
            whether a pairing is currently in flight. */}
        <SecurityDisclosures id="launcher-security-disclosures" className="mt-6" />

        {stored ? (
          <div className="mt-6 grid gap-1.5 border-t border-white/10 pt-4">
            <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#6b6b6b]">
              Stored pairing
            </div>
            <div className="flex items-center gap-2.5 rounded-[10px] border border-white/10 px-2.5 py-2">
              <span className="size-[7px] shrink-0 rounded-full bg-[#5fd38a]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-white">{stored.name}</span>
                <span className="block truncate font-mono text-[11px] text-[#6b6b6b]">
                  {stored.relayUrl}
                </span>
              </span>
              <button
                type="button"
                onClick={onForgetStored}
                className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-white/15 px-2.5 text-[12.5px] text-[#a3a3a3] transition hover:bg-white/5 hover:text-white"
              >
                <Icon name="x" size={13} />
                Forget
              </button>
            </div>
            <p className="break-words text-[11.5px] leading-relaxed text-[#a3a3a3]">
              The pairing is re-established on load. Forget removes it from this browser and clears
              the stored token.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
