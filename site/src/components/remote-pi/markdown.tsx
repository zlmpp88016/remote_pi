"use client";

/* Markdown rendering for the agent half of the transcript.
 *
 * This module is the ONLY place wire text becomes structured markup. The
 * safety stance that made the plain-text transcript safe is kept intact:
 *
 *   • NO `rehype-raw`. Raw HTML in a reply is therefore rendered as TEXT, not
 *     parsed into the DOM — a `<script>` or `<img onerror=…>` in the stream
 *     cannot create an element. react-markdown builds React elements rather
 *     than an HTML string, so there is no `dangerouslySetInnerHTML` anywhere.
 *   • Links are protocol-checked. Only `http:`, `https:` and `mailto:` become
 *     anchors; anything else (`javascript:`, `data:`, a relative path) is
 *     rendered as plain text so it cannot be activated.
 *   • Fenced code renders as a <pre> with its text content untouched, and is
 *     never syntax-highlighted through a parser that could inject markup.
 *
 * Styling mirrors the app's dark mono look (the prototype's `.md-response`):
 * the transcript is a terminal, so prose stays readable but code is obviously
 * code.
 */
import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { Icon } from "./icons";
import { isSafeHref } from "@/lib/remote-pi/markdown-links";

/** Copies `text`, reporting failure rather than pretending it worked. */
function CopyButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      aria-label="Copy this code block"
      title="Copy"
      onClick={(event) => {
        const button = event.currentTarget;
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            button.dataset.copied = "1";
            window.setTimeout(() => delete button.dataset.copied, 1200);
          })
          .catch(() => {
            /* Clipboard blocked (no permission / insecure context). The code
               stays selectable, so no misleading "copied" state is shown. */
          });
      }}
      className="absolute right-1.5 top-1.5 inline-flex h-6 items-center gap-1 rounded-md border border-white/15 bg-[#151517]/90 px-2 font-mono text-[10.5px] text-[#a3a3a3] opacity-0 transition group-hover:opacity-100 focus:opacity-100 data-[copied]:text-[#5fd38a]"
    >
      <Icon name="check" size={11} />
      copy
    </button>
  );
}

/** Extract the raw text of a fenced code block's children (for the copy button). */
function textOf(children: ReactNode): string {
  if (children === null || children === undefined || children === false) return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (typeof children === "object" && "props" in (children as { props?: unknown })) {
    const props = (children as { props?: { children?: ReactNode } }).props;
    return textOf(props?.children);
  }
  return "";
}

const COMPONENTS: Components = {
  /* ── links: protocol-checked, opened outside the app ─────────────────── */
  a({ href, children }) {
    if (!isSafeHref(href)) {
      // Not a link we will activate: keep the visible text, drop the target.
      return <span className="text-[#a3a3a3]">{children}</span>;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[#4fc3f7] underline decoration-[rgba(79,195,247,0.4)] underline-offset-2 hover:decoration-[#4fc3f7]"
      >
        {children}
      </a>
    );
  },

  /* ── inline code ─────────────────────────────────────────────────────── */
  code({ className, children, ...rest }) {
    // A bare <code> (no <pre> parent) is INLINE. Fenced blocks are handled by
    // `pre` below, which owns the card + copy button.
    const isBlock = typeof className === "string" && className.startsWith("language-");
    if (isBlock) {
      // The <pre> wrapper renders the chrome; keep the code node plain.
      return (
        <code className={`${className ?? ""} block whitespace-pre`} {...rest}>
          {children}
        </code>
      );
    }
    return (
      <code className="rounded-[5px] bg-[rgba(79,195,247,0.1)] px-1.5 py-0.5 font-mono text-[12.5px] text-[#5fd38a]">
        {children}
      </code>
    );
  },

  pre({ children }) {
    return (
      <div className="group relative my-2">
        <pre className="overflow-x-auto rounded-[10px] border border-white/10 bg-black/40 p-3 pr-16 font-mono text-[12.5px] leading-relaxed text-[#d4d4d4]">
          {children}
        </pre>
        <CopyButton text={textOf(children)} />
      </div>
    );
  },

  /* ── block structure ─────────────────────────────────────────────────── */
  p({ children }) {
    return <p className="my-1.5 leading-[1.62] first:mt-0 last:mb-0">{children}</p>;
  },
  ul({ children }) {
    return <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>;
  },
  li({ children }) {
    return <li className="leading-[1.62] [&>p]:my-0">{children}</li>;
  },
  h1({ children }) {
    return <h3 className="mb-1 mt-3 font-semibold text-white first:mt-0">{children}</h3>;
  },
  h2({ children }) {
    return <h3 className="mb-1 mt-3 font-semibold text-white first:mt-0">{children}</h3>;
  },
  h3({ children }) {
    return <h4 className="mb-1 mt-2.5 font-semibold text-white first:mt-0">{children}</h4>;
  },
  h4({ children }) {
    return <h4 className="mb-1 mt-2.5 font-semibold text-white first:mt-0">{children}</h4>;
  },
  h5({ children }) {
    return <h5 className="mb-1 mt-2 font-semibold text-[#d4d4d4] first:mt-0">{children}</h5>;
  },
  h6({ children }) {
    return <h6 className="mb-1 mt-2 font-semibold text-[#a3a3a3] first:mt-0">{children}</h6>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 border-l-2 border-white/20 pl-3 text-[#a3a3a3]">
        {children}
      </blockquote>
    );
  },
  hr() {
    return <hr className="my-3 border-white/10" />;
  },
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border border-white/10 bg-white/[0.04] px-2 py-1 text-left font-semibold text-white">
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className="border border-white/10 px-2 py-1 align-top">{children}</td>;
  },
  strong({ children }) {
    return <strong className="font-semibold text-white">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic">{children}</em>;
  },
};

/**
 * Renders one agent reply. `memo` matters here: a streaming turn re-renders on
 * every delta, and the parsed tree only changes when `text` does.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[14.8px] text-[#d4d4d4] [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={COMPONENTS}
        /* Raw HTML is NOT enabled: `skipHtml` would drop it silently, so we
           leave it to react-markdown's default of rendering it as text — the
           user can SEE the markup the model emitted instead of it vanishing. */
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
