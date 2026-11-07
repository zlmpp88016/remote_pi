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

import { Icon } from "../core/icons";
import { isSafeHref } from "@/lib/remote-pi/markdown-links";

import { compose } from "../primitives/recipes";
import css from "./markdown.module.css";

/** Copies `text`, reporting failure rather than pretending it worked. */
function CopyButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      aria-label="复制代码块"
      title="复制"
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
      className={css.copyButton}
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

/**
 * The fence's language, or `text` when the author gave none.
 *
 * markdown puts the language on the inner <code> as `language-ts`; the <pre>
 * renderer only receives the children, so it has to reach in for it. Anything
 * unrecognised falls back to "text" — a banner with no label would leave the
 * copy button floating.
 */
function languageOf(children: ReactNode): string {
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = languageOf(child);
      if (found !== "text") return found;
    }
    return "text";
  }
  if (typeof children === "object" && children !== null && "props" in children) {
    const props = (children as { props?: { className?: unknown; children?: ReactNode } }).props;
    const cls = props?.className;
    if (typeof cls === "string" && cls.startsWith("language-")) return cls.slice("language-".length);
    if (props?.children !== undefined) return languageOf(props.children);
  }
  return "text";
}

const COMPONENTS: Components = {
  /* ── links: protocol-checked, opened outside the app ─────────────────── */
  a({ href, children }) {
    if (!isSafeHref(href)) {
      // Not a link we will activate: keep the visible text, drop the target.
      return <span className={css.unsafeLink}>{children}</span>;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={css.link}
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
        <code className={compose(className, css.codeBlock)} {...rest}>
          {children}
        </code>
      );
    }
    return (
      <code className={css.codeInline}>
        {children}
      </code>
    );
  },

  pre({ children }) {
    /*
     * DSH's code block is TWO stacked segments, not one outlined box: a
     * #2c2c2e banner carrying the language and the copy action, then a
     * #1b1b1c body. The banner's bottom corners are square and the body's top
     * corners are square so the pair reads as one card with a header.
     *
     * The language is read off the <code> node's class, which is where
     * markdown places it (`language-ts`); a fence with no language keeps the
     * banner and shows "text" so the copy action still has a home.
     */
    const lang = languageOf(children);
    return (
      <div className={css.preWrap}>
        <div className={css.preBanner}>
          <span className={css.preLang}>{lang}</span>
          <CopyButton text={textOf(children)} />
        </div>
        <pre className={css.pre}>
          {children}
        </pre>
      </div>
    );
  },

  /* ── block structure ─────────────────────────────────────────────────── */
  p({ children }) {
    return <p className={css.p}>{children}</p>;
  },
  ul({ children }) {
    return <ul className={css.ul}>{children}</ul>;
  },
  ol({ children }) {
    return <ol className={css.ol}>{children}</ol>;
  },
  li({ children }) {
    return <li className={css.li}>{children}</li>;
  },
  h1({ children }) {
    return <h3 className={css.h3}>{children}</h3>;
  },
  h2({ children }) {
    return <h3 className={css.h3}>{children}</h3>;
  },
  h3({ children }) {
    return <h4 className={css.h4}>{children}</h4>;
  },
  h4({ children }) {
    return <h4 className={css.h4}>{children}</h4>;
  },
  h5({ children }) {
    return <h5 className={css.h5}>{children}</h5>;
  },
  h6({ children }) {
    return <h6 className={css.h6}>{children}</h6>;
  },
  blockquote({ children }) {
    return (
      <blockquote className={css.blockquote}>
        {children}
      </blockquote>
    );
  },
  hr() {
    return <hr className={css.hr} />;
  },
  table({ children }) {
    return (
      <div className={css.tableWrap}>
        <table className={css.table}>{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className={css.th}>
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className={css.td}>{children}</td>;
  },
  strong({ children }) {
    return <strong className={css.strong}>{children}</strong>;
  },
  em({ children }) {
    return <em className={css.em}>{children}</em>;
  },
};

/**
 * Renders one agent reply. `memo` matters here: a streaming turn re-renders on
 * every delta, and the parsed tree only changes when `text` does.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className={css.root}>
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
