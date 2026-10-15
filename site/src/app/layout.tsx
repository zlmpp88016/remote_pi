import type { Metadata } from "next";
import { Space_Grotesk, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/header";
import { SiteFooter } from "@/components/footer";

const display = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

const body = Hanken_Grotesk({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

const siteTagline =
  "Remote Pi: drive your Pi coding agents from the browser";
const siteDescription =
  "Pair this browser with a Remote Pi host over a relay: browse the host filesystem, start a Pi workspace in any directory, and talk to the agent — no install required.";

export const metadata: Metadata = {
  /* No production domain is fixed for this fork; relative metadataBase keeps
     OpenGraph/Twitter URLs resolvable from whatever host serves the site. */
  metadataBase: new URL("http://localhost:3000"),
  title: {
    default: siteTagline,
    template: "%s · Remote Pi",
  },
  description: siteDescription,
  applicationName: "Remote Pi",
  keywords: [
    "Remote Pi",
    "Pi coding agent",
    "web client",
    "remote development",
    "coding agents",
    "relay pairing",
  ],
  openGraph: {
    type: "website",
    title: siteTagline,
    description: siteDescription,
    siteName: "Remote Pi",
  },
  twitter: {
    card: "summary_large_image",
    title: siteTagline,
    description: siteDescription,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-bg text-fg">
        <div className="app flex min-h-full flex-1 flex-col" id="top">
          <SiteHeader />
          <main className="flex-1">{children}</main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
