"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { LogoMark, IconGithub } from "@/components/landing/icons";
import { isRemotePiWebClientEnabled } from "@/lib/flags";

/* The site now ships ONE product: the Remote Pi web client. The root route is
   the pairing screen, and the only other page is the reference under
   /remote-pi/docs. The nav is therefore intentionally tiny — client, docs,
   GitHub — and it disappears entirely when a deployment opts out with
   NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT=0 (same switch the routes use, so nav and
   routes can never disagree). */
type NavLink = { href: string; label: string };

const GITHUB_URL = "https://github.com/zlmpp88016/remote_pi";

const LINKS: NavLink[] = [
  { href: "/", label: "Connect" },
  { href: "/remote-pi/docs", label: "Docs" },
];

function HamburgerIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line
        x1="4"
        y1="6"
        x2="20"
        y2="6"
        style={{
          transform: open ? "rotate(45deg) translate(0, 6px)" : "none",
          transformOrigin: "center",
          transition: "transform 0.25s ease",
        }}
      />
      <line
        x1="4"
        y1="12"
        x2="20"
        y2="12"
        style={{
          opacity: open ? 0 : 1,
          transition: "opacity 0.2s ease",
        }}
      />
      <line
        x1="4"
        y1="18"
        x2="20"
        y2="18"
        style={{
          transform: open ? "rotate(-45deg) translate(0, -6px)" : "none",
          transformOrigin: "center",
          transition: "transform 0.25s ease",
        }}
      />
    </svg>
  );
}

export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname() ?? "/";
  const enabled = isRemotePiWebClientEnabled();

  const links = enabled ? LINKS : [{ href: "/remote-pi/docs", label: "Docs" }];

  return (
    <header className="nav">
      <div className="wrap nav-inner">
        <Link className="brand" href="/" aria-label="Remote Pi home">
          <span className="mark">
            <LogoMark />
          </span>
          Remote Pi
        </Link>

        {/* Desktop links */}
        <nav className="nav-links" aria-label="Primary">
          {links.map((l) => (
            <Link
              className="lnk"
              href={l.href}
              key={l.href}
              aria-current={pathname === l.href ? "page" : undefined}
            >
              {l.label}
            </Link>
          ))}
          <a
            className="lnk"
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <IconGithub /> GitHub
          </a>
        </nav>

        {/* Mobile menu toggle */}
        <button
          className="nav-toggle"
          onClick={() => setMenuOpen((s) => !s)}
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          type="button"
        >
          <HamburgerIcon open={menuOpen} />
        </button>
      </div>

      {/* Mobile drawer */}
      {menuOpen && (
        <div id="mobile-menu" className="mobile-nav open" aria-hidden={false}>
          <div className="wrap mobile-nav-inner">
            {links.map((l) => (
              <Link
                className="m-lnk"
                href={l.href}
                key={l.href}
                onClick={() => setMenuOpen(false)}
              >
                {l.label}
              </Link>
            ))}
            <a
              className="m-lnk"
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMenuOpen(false)}
            >
              <IconGithub /> GitHub
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
