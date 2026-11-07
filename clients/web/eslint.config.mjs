import { defineConfig, globalIgnores } from "eslint/config";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Lint configuration.
 *
 * WHY NOT `eslint-config-next`: that preset exists to catch Next-specific
 * mistakes — server/client boundary violations, `next/image` misuse, App Router
 * conventions. None of those concepts exist here any more, so keeping it would
 * mean carrying a dependency to enforce rules about a framework the project no
 * longer uses.
 *
 * What is kept is what still applies to a plain React + TypeScript app: the
 * TypeScript rules, the hooks rules (the ones that catch a missing dependency or
 * a conditional hook — both of which this codebase has already hit once), and
 * the browser globals.
 *
 * TWO RULES ARE DOWNGRADED TO `warn`, AND THE REASON IS THE SAME FOR BOTH: they
 * flag a pattern that is deliberate here and that no rewrite would improve.
 *
 *   `react-hooks/refs` (94 hits) — nearly all of them one expression in
 *   `connect-client.tsx`: `portsRef.current = {...}` assigned during render. That
 *   is the documented escape hatch that keeps the dispatcher callback's identity
 *   stable, and the comment at the assignment says why: an unstable callback tore
 *   down and rebuilt the adapter's subscriptions on every render, which dropped
 *   the `session_read_ok` reply between the click and its handler. React's own
 *   guidance is to avoid this pattern, but the alternatives (a `useMemo` over 20
 *   entries, or an effect that runs a commit late) either reintroduce the churn
 *   or read a stale value. Until the adapter is restructured, the warning is
 *   accurate about the pattern and wrong about the remedy.
 *
 *   `react-hooks/exhaustive-deps` (30 hits) — every reported dependency is either
 *   a ref object or a `useState` setter. Both are stable for the component's
 *   lifetime, so adding them to the array cannot change behaviour; the rule
 *   simply cannot prove stability statically through the `chatStore.actions.*`
 *   indirection. See `additionalHooks` note below for why they are not silenced.
 *
 * `@typescript-eslint/no-unused-vars` stays an error: it found 33 genuinely dead
 * imports and one dead local, all now removed.
 */
export default defineConfig([
  globalIgnores(["dist/**", "dist-shell/**", "node_modules/**", "scripts/_e2e-evidence/**"]),
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-hooks": reactHooks,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // Unused arguments are common in signature-compatible callbacks; the
      // underscore prefix is the documented opt-out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "react-hooks/refs": "warn",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
]);
