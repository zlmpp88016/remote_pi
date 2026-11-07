/**
 * Plan/78 — the Changes dock panel.
 *
 * Renders git working-tree STATUS: a branch/HEAD line, four counts, and one row
 * per changed path. It deliberately does NOT render diff content — see
 * `daemon/changes.ts` for why a diff verb was rejected (it would widen a pairing
 * token from "a few allowlisted documents" to "everything you ever edited").
 *
 * Three states, and they are kept visually and lexically distinct on purpose:
 *
 *   reading  → "正在读取工作树…"
 *   failure  → the client-authored sentence for that reason (a non-repo is a
 *              FACT about the folder, not an error)
 *   clean    → "没有更改" with the branch shown, which is a real answer
 *
 * Collapsing failure into "nothing changed" would make the panel lie precisely
 * when a user is deciding whether it is safe to hand the worktree to an agent.
 */
import { EmptyState, Spinner } from "./states";
import { Icon } from "../core/icons";
import type { ChangesSnapshotWire, ChangesUnavailableReason } from "@/lib/remote-pi/protocol";
import css from "./changes-panel.module.css";

export interface ChangesPanelProps {
  snapshot: ChangesSnapshotWire | null;
  busy: boolean;
  /** Non-null when the host could not answer (or the request never left). */
  unavailable: ChangesUnavailableReason | string | null;
  /** Client-authored sentence for `unavailable`; never host text. */
  unavailableText: string | null;
  onRefresh: () => void;
  /** Set when this workspace cannot be queried at all (no live adapter). */
  disabledReason: string | null;
}

/**
 * Neutralises bidirectional and zero-width characters in a reported path.
 *
 * A filename is attacker-influenced data: a branch checkout, a dependency, or a
 * colleague's commit can carry `U+202E` (RIGHT-TO-LEFT OVERRIDE) and make
 * `invoice\u202Efdp.exe` render as `invoiceexe.pdf` — a real social-engineering
 * vector in a panel whose entire job is "is it safe to hand this tree over".
 * Zero-width joiners do the same invisibly by hiding a character outright.
 *
 * This is not HTML escaping (React already renders a text node): it removes the
 * characters that make rendered text LIE about its own bytes. Replaced with U+FFFD
 * rather than deleted, so a doctored name is visibly odd instead of silently
 * normalised into looking legitimate.
 */
function neutraliseBidi(s: string): string {
  /*
   * Ranges, and why each is here:
   *   U+202A-202E  bidi embedding/override — makes `invoice\u202Efdp.exe` render
   *                as `invoiceexe.pdf`, i.e. a name that lies about its extension
   *   U+2066-2069  bidi isolates, same class
   *   U+200B-200F  zero-width space/joiners + LRM/RLM — hides a character outright
   *   U+FEFF       zero-width no-break space (BOM) — invisible
   *   U+061C       Arabic letter mark — bidi control
   *   U+2028/2029  LINE/PARAGRAPH SEPARATOR (measured defect: HTML renders these
   *                as a line break, so ONE entry visually splits into TWO rows and
   *                can forge the appearance of extra records in a list whose
   *                length the user is reading as a fact)
   *
   * Homoglyphs (Cyrillic `а`), combining marks (`é` = `e` + U+0301) and variation
   * selectors (U+FE0F for emoji) are deliberately NOT touched: they are legitimate
   * international filenames, and neutralising them would corrupt real repositories
   * to defend against a threat that needs a human to misread a letter, not a
   * renderer to lie about bytes.
   */
  return s.replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF\u061C\u2028\u2029]/g, "\uFFFD");
}

/**
 * Turns the two porcelain columns into one short, human word.
 *
 * The columns are git's own closed vocabulary, so this is a rendering choice
 * rather than a translation of free text. Ordering matters: a conflicted row is
 * reported as conflicted even though it also carries M/U columns.
 */
function describeEntry(x: string, y: string, renamed: boolean): { label: string; tone: string } {
  /* `!!` is git's "ignored" marker. It is never requested (`--untracked-files`
   * without `=all` does not emit it) and must NOT be drawn as untracked if a
   * future flag change ever surfaces one — an ignored build artefact is not a
   * change the user needs to act on. */
  if (x === "!" || y === "!") return { label: "已忽略", tone: css.toneChanged };
  if (x === "?" || y === "?") return { label: "未跟踪", tone: css.toneNew };
  /* porcelain v1's whole unmerged set: DD AU UD UA DU AA UU. `U` in either
   * column covers AU/UD/UA/DU too. */
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
    return { label: "冲突", tone: css.toneWarn };
  }
  if (renamed) return { label: "重命名", tone: css.toneChanged };
  /* `T` is a typechange — a regular file replaced by a symlink (or vice versa).
   * It is neither added nor deleted, and calling it plain "modified" would hide
   * the one detail that matters about it. */
  if (x === "T" || y === "T") return { label: "类型变更", tone: css.toneWarn };
  if (x === "A") return { label: "新增", tone: css.toneNew };
  if (x === "D" || y === "D") return { label: "删除", tone: css.toneWarn };
  /* Staged AND unstaged on the same path. */
  if (x !== " " && y !== " ") return { label: "已暂存+又改动", tone: css.toneChanged };
  if (x !== " ") return { label: "已暂存", tone: css.toneChanged };
  return { label: "已修改", tone: css.toneChanged };
}

/** True when every count is zero — a clean worktree. */
function isClean(s: ChangesSnapshotWire): boolean {
  const t = s.total;
  return t.staged + t.unstaged + t.untracked + t.conflicted === 0;
}

export function ChangesPanel(props: ChangesPanelProps) {
  const { snapshot, busy, unavailable, unavailableText, onRefresh, disabledReason } = props;

  const inert = disabledReason !== null;

  return (
    <div className={css.root}>
      <div className={css.head}>
        <button
          type="button"
          className={css.refresh}
          disabled={inert || busy}
          onClick={onRefresh}
          title={
            inert
              ? disabledReason
              : "重新读取工作树（git status）。"
          }
          aria-label="重新加载工作树"
        >
          <Icon name="refresh" size={12} />
        </button>
        <span className={css.headTitle}>更改</span>
      </div>

      {inert ? (
        <EmptyState icon="branch" title="更改不可用" detail={disabledReason} />
      ) : busy && snapshot === null ? (
        <div className={css.loading}>
          <Spinner />
          <span>正在读取工作树…</span>
        </div>
      ) : unavailable !== null ? (
        /* A failure is NOT an empty list: this sentence says the host could not
         * answer, which is a different fact from "your tree is clean". */
        <EmptyState icon="alert" title="工作树无法读取" detail={unavailableText ?? "无法读取该工作区的工作树。"} />
      ) : snapshot === null ? (
        <div className={css.loading}>
          <Spinner />
          <span>正在读取工作树…</span>
        </div>
      ) : (
        <div className={css.scroller}>
          <dl className={css.facts}>
            <dt>分支</dt>
            <dd>
              {snapshot.branch === null
                ? <span className={css.dim}>分离的 HEAD</span>
                : <code className={css.mono}>{snapshot.branch}</code>}
              {snapshot.ahead !== null && snapshot.behind !== null && (snapshot.ahead > 0 || snapshot.behind > 0) ? (
                <span className={css.dim}>{`  领先 ${snapshot.ahead} · 落后 ${snapshot.behind}`}</span>
              ) : null}
            </dd>
            <dt>HEAD</dt>
            <dd>
              {snapshot.head === null
                ? <span className={css.dim}>还没有提交</span>
                : (
                  <>
                    <code className={css.mono}>{snapshot.head.sha7}</code>
                    <span className={css.subject}>{` ${snapshot.head.subject}`}</span>
                  </>
                )}
            </dd>
          </dl>

          <div className={css.counts}>
            <span className={css.count}>{`${snapshot.total.staged} 已暂存`}</span>
            <span className={css.count}>{`${snapshot.total.unstaged} 未暂存`}</span>
            <span className={css.count}>{`${snapshot.total.untracked} 未跟踪`}</span>
            {snapshot.total.conflicted > 0 ? (
              <span className={`${css.count} ${css.countWarn}`}>{`${snapshot.total.conflicted} 有冲突`}</span>
            ) : null}
          </div>

          {snapshot.truncated ? (
            <p className={css.truncated}>
              {`只显示前 ${snapshot.entries.length} 条，共 ${
                snapshot.total.staged + snapshot.total.unstaged + snapshot.total.untracked + snapshot.total.conflicted
              } 条变更路径。`}
            </p>
          ) : null}

          {/*
           * Untracked DIRECTORIES are collapsed to one row (`sub/`) by git's
           * default `--untracked-files=normal`. Without this line a folder holding
           * a hundred new files looks like a single empty directory, and a user
           * reading the list as an inventory of what changed would under-count it.
           * Expanding instead (`=all`) is not an option: one node_modules/ or
           * vendor/ tree would produce tens of thousands of rows the dock cannot
           * use.
           */}
          {snapshot.entries.some((e) => (e.x === "?" || e.y === "?") && e.rel.endsWith("/")) ? (
            <p className={css.untrackedNote}>
              未跟踪的目录以折叠形式显示；在终端里展开才能看到里面的文件。
            </p>          ) : null}

          {isClean(snapshot) ? (
            <p className={css.clean}>
              工作树与 HEAD 一致，没有更改。
            </p>
          ) : (
            <ul className={css.list}>
              {snapshot.entries.map((e) => {
                const d = describeEntry(e.x, e.y, e.renamed);
                return (
                  <li key={`${e.rel}\u0000${e.x}${e.y}`} className={css.row}>
                    <span className={`${css.badge} ${d.tone}`}>{d.label}</span>
                    {/* `rel` is repo-relative and rendered as a text node, never
                        as HTML: it is git's report of a filename, which is
                        attacker-influenced data as far as this client knows. */}
                    <span className={css.path} title={neutraliseBidi(e.rel)}>{neutraliseBidi(e.rel)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
