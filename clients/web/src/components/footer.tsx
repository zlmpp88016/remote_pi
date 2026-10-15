import Link from "next/link";

import { isRemotePiWebClientEnabled } from "@/lib/flags";

const GITHUB_URL = "https://github.com/zlmpp88016/remote_pi";

export function SiteFooter() {
  const clientEnabled = isRemotePiWebClientEnabled();

  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <div className="copy">
          © {new Date().getFullYear()} Remote Pi. Open source under the MIT
          license.
        </div>
        <nav className="footer-links">
          {clientEnabled ? <Link href="/">Connect</Link> : null}
          <Link href="/remote-pi/docs">Docs</Link>
          <a
            href={`${GITHUB_URL}/blob/main/PROTOCOL.md`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Protocol
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
