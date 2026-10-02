/**
 * Plan 01 (Wave 3) — session tree snapshot.
 *
 * Ported from `zerray/pi-remote-control`'s `src/tree-snapshot.ts`. The daemon
 * there reduces Pi's full session tree into a flat, display-oriented entry list
 * that a client can render and act on without knowing raw Pi entry shapes.
 *
 * The load-bearing idea is the **two-version fence**:
 *
 *   - `snapshotVersion` covers entry content (ids, parents, previews, titles).
 *     Ordinary chat does not change it.
 *   - `branchVersion` covers the current position (leaf + snapshotVersion).
 *     Append-only chat does change it.
 *
 * A navigation/fork/clone request carries both. Checking only one is not enough:
 * a stale entry list with a correct leaf would let a client act on an entry that
 * no longer exists, and a correct entry list with a stale leaf would let it act
 * on a position the user never saw.
 */

import { createHash } from "node:crypto";

export const TREE_PREVIEW_LIMIT = 500;

/** Filter vocabulary the app implements in its tree picker. Kept in sync with
 *  `session_tree_sheet.dart`'s `_filterEntries`. */
export const TREE_FILTERS = ["default", "user", "assistant", "tools"] as const;
export type TreeFilter = (typeof TREE_FILTERS)[number];

export type TreeEntryType =
  | "message"
  | "custom_message"
  | "branch_summary"
  | "compaction"
  | "model_change"
  | "thinking_level_change"
  | "label"
  | "session_info"
  | "custom"
  | "other";

export interface TreeEntry {
  id: string;
  parentId: string | null;
  type: TreeEntryType;
  role?: "user" | "assistant" | "toolResult" | "system" | "custom";
  customType?: string;
  toolName?: string;
  title: string;
  preview: string;
  timestamp: string;
  isCurrentLeaf: boolean;
  isOnActiveBranch: boolean;
  isForkable: boolean;
  navigationBehavior: "edit_prompt" | "navigate";
}

export interface TreeSnapshot {
  snapshotVersion: string;
  branchVersion: string;
  leafId: string | null;
  entries: TreeEntry[];
  defaultFilter: TreeFilter;
  filters: TreeFilter[];
}

/** Minimal shape this module needs; mirrors the SDK's `SessionTreeNode`. */
export interface TreeNodeInput {
  entry: unknown;
  children?: TreeNodeInput[];
  label?: string;
}

export function buildTreeSnapshot(input: {
  roots: readonly TreeNodeInput[];
  leafId: string | null;
}): TreeSnapshot {
  const flat = flattenTree(input.roots, input.leafId);
  const parentById = new Map<string, string | null>();
  for (const raw of flat) parentById.set(raw.id, raw.parentId);
  const activeIds = activeBranchPath(input.leafId, parentById);
  const entries = flat.map((raw) => toTreeEntry(raw, input.leafId, activeIds));
  return {
    snapshotVersion: snapshotVersionFor(entries),
    branchVersion: branchVersionFor(input.leafId, entries),
    leafId: input.leafId,
    entries,
    defaultFilter: "default",
    filters: [...TREE_FILTERS],
  };
}

/**
 * Content hash over everything except leaf/branch position, so appending a chat
 * message with no other change leaves the version stable.
 */
export function snapshotVersionFor(entries: readonly TreeEntry[]): string {
  const stable = entries.map(({ isCurrentLeaf: _leaf, isOnActiveBranch: _branch, ...rest }) => rest);
  return `treev_${hashJson(stable)}`;
}

export function branchVersionFor(leafId: string | null, entries: readonly TreeEntry[]): string {
  return `branchv_${hashJson({ leafId, snapshotVersion: snapshotVersionFor(entries) })}`;
}

interface RawTreeEntry {
  source: Record<string, unknown>;
  id: string;
  parentId: string | null;
  timestamp: string;
}

function flattenTree(roots: readonly TreeNodeInput[], leafId: string | null): RawTreeEntry[] {
  const entries: RawTreeEntry[] = [];
  const visit = (node: TreeNodeInput, parentOverride?: string | null): void => {
    const source = asRecord(node.entry);
    const id = readString(source.id);
    if (!id) return;
    const parentId = parentOverride !== undefined ? parentOverride : (readString(source.parentId) ?? null);
    if (isHiddenAssistantEntry(source, leafId)) {
      // Hidden entries are structural only; children keep the hidden node's
      // parent so the flattened list stays connected to the real tree.
      for (const child of node.children ?? []) visit(child, parentId);
      return;
    }
    entries.push({
      source,
      id,
      parentId,
      timestamp: readString(source.timestamp) ?? new Date(0).toISOString(),
    });
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return entries;
}

/**
 * Pi's `/tree` hides assistant entries with no visible text unless they are the
 * current leaf or ended in a non-success stop reason. Mirroring that keeps the
 * remote picker from filling up with empty assistant turns.
 */
function isHiddenAssistantEntry(source: Record<string, unknown>, leafId: string | null): boolean {
  if (source.type !== "message") return false;
  const id = readString(source.id);
  if (id && id === leafId) return false;
  const message = asRecord(source.message);
  if (message.role !== "assistant") return false;
  if (hasTextContent(message.content)) return false;
  const stopReason = readString(message.stopReason) ?? readString(source.stopReason);
  return !(stopReason && stopReason !== "stop" && stopReason !== "toolUse");
}

function hasTextContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    const record = asRecord(item);
    return record.type === "text" && (readString(record.text)?.trim().length ?? 0) > 0;
  });
}

function activeBranchPath(leafId: string | null, parentById: Map<string, string | null>): Set<string> {
  const ids = new Set<string>();
  let currentId = leafId;
  while (currentId && !ids.has(currentId)) {
    ids.add(currentId);
    currentId = parentById.get(currentId) ?? null;
  }
  return ids;
}

function toTreeEntry(raw: RawTreeEntry, leafId: string | null, activeIds: Set<string>): TreeEntry {
  const type = treeEntryType(raw.source.type);
  const message = asRecord(raw.source.message);
  const role = publicRole(type, readString(message.role));
  const customType = readString(raw.source.customType);
  const preview = boundedPreview(previewText(raw.source, type));
  // Only a user message is a meaningful fork target: forking before an
  // assistant or tool entry has no prompt to return to the composer.
  const isForkable = type === "message" && role === "user";
  const entry: TreeEntry = {
    id: raw.id,
    parentId: raw.parentId,
    type,
    title: entryTitle(type, role, customType),
    preview,
    timestamp: raw.timestamp,
    isCurrentLeaf: raw.id === leafId,
    isOnActiveBranch: activeIds.has(raw.id),
    isForkable,
    navigationBehavior: isForkable || type === "custom_message" ? "edit_prompt" : "navigate",
  };
  if (role) entry.role = role;
  if (customType) entry.customType = customType;
  if (role === "toolResult") {
    const toolName = readString(message.toolName);
    if (toolName) entry.toolName = toolName;
  }
  return entry;
}

function treeEntryType(value: unknown): TreeEntryType {
  switch (value) {
    case "message":
    case "custom_message":
    case "branch_summary":
    case "compaction":
    case "model_change":
    case "thinking_level_change":
    case "label":
    case "session_info":
    case "custom":
      return value;
    default:
      return "other";
  }
}

function publicRole(type: TreeEntryType, role: string | undefined): TreeEntry["role"] | undefined {
  if (type === "custom_message") return "custom";
  if (role === "user" || role === "assistant" || role === "toolResult" || role === "system") return role;
  return undefined;
}

function entryTitle(type: TreeEntryType, role: TreeEntry["role"] | undefined, customType: string | undefined): string {
  if (type === "message") return role ?? "message";
  if (type === "custom_message") return customType ?? "custom";
  if (type === "branch_summary") return "branch summary";
  if (type === "thinking_level_change") return "thinking";
  if (type === "model_change") return "model";
  if (type === "session_info") return "title";
  if (type === "custom") return customType ?? "custom";
  return type;
}

function previewText(entry: Record<string, unknown>, type: TreeEntryType): string {
  if (type === "message") return contentText(asRecord(entry.message).content);
  if (type === "custom_message") return contentText(entry.content);
  if (type === "branch_summary" || type === "compaction") return readString(entry.summary) ?? "";
  if (type === "model_change") return readString(entry.modelId) ?? "";
  if (type === "thinking_level_change") return readString(entry.thinkingLevel) ?? "";
  if (type === "label") return readString(entry.label) ?? "";
  if (type === "session_info") return readString(entry.name) ?? "";
  if (type === "custom") return readString(entry.customType) ?? "";
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      const record = asRecord(item);
      if (record.type === "text") return readString(record.text) ?? "";
      if (record.type === "thinking") return readString(record.thinking) ?? "";
      return [];
    })
    .join("");
}

function boundedPreview(text: string): string {
  return text.length <= TREE_PREVIEW_LIMIT ? text : text.slice(0, TREE_PREVIEW_LIMIT);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 16);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
