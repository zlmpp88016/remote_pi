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

import { Icon, RemotePiMark } from "../core/icons";
import css from "./connection-launcher.module.css";
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

const FIELD = css.FIELD;

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
    <div className={css.page}>
      <div className={css.column}>
        <div className={css.brandRow}>
          <span className={css.brandMark}>
            <RemotePiMark size={20} />
          </span>
          <div>
            <div
              className={css.brandName}
              style={{ fontFamily: "var(--ff-display)" }}
            >
              Remote Pi
            </div>
            <div className={css.eyebrow}>
              Web client
            </div>
          </div>
        </div>

        <h1
          className={css.lede}
          style={{ fontFamily: "var(--ff-display)" }}
        >
          Connect to a host
        </h1>
        <p className={css.body}>
          Paste the relay address and the pairing code printed by{" "}
          <code className={css.inlineCode}>remote-pi-server pair</code> on the
          machine you want to drive. No Pi has to be running.
        </p>

        {resuming ? <Loading label="Restoring the stored pairing…" /> : null}

        <form className={css.form} onSubmit={onSubmit}>
          <label className={css.fieldGroup}>
            <span className={css.fieldLabel}>Relay address</span>
            <input
              className={`${FIELD} ${css.fieldTall}`}
              value={address}
              onChange={(event) => onAddressChange(event.target.value)}
              placeholder="wss://relay.example.com"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
            />
          </label>

          <label className={css.fieldGroup}>
            <span className={css.fieldLabel}>Pairing code</span>
            <textarea
              className={`${FIELD} ${css.pairField}`}
              value={code}
              onChange={(event) => onCodeChange(event.target.value)}
              placeholder="remotepi://pair?t=…&epk=…&n=…"
              spellCheck={false}
              disabled={disabled}
            />
            <span className={css.errorLine}>
              The URI itself is the code — paste it whole. The token in it is never logged or
              re-displayed, and it is stored in this browser (see the disclosures below).
            </span>
          </label>

          <button
            type="submit"
            disabled={disabled}
            className={css.submit}
          >
            {busy ?? "Connect"}
          </button>

          {error ? <ErrorState title="Pairing failed" detail={error} /> : null}
        </form>

        {stored ? (
          <div className={css.storedBox}>
            <div className={css.storedTitle}>
              Stored pairing
            </div>
            <div className={css.storedRow}>
              <span className={css.storedDot} />
              <span className={css.storedText}>
                <span className={css.storedName}>{stored.name}</span>
                <span className={css.storedMeta}>
                  {stored.relayUrl}
                </span>
              </span>
              <button
                type="button"
                onClick={onForgetStored}
                className={css.unpairButton}
              >
                <Icon name="x" size={13} />
                Forget
              </button>
            </div>
            <p className={css.storedNote}>
              The pairing is re-established on load. Forget removes it from this browser and clears
              the stored token.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
