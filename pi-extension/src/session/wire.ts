/**
 * Plan 01 — wire-format mapping for the session tree and runtime status.
 *
 * The protocol is snake_case (matching every other message) while the internal
 * modules use camelCase. Keeping the translation in one place means the
 * collectors stay free of wire concerns and there is a single spot to check
 * when the wire shape changes.
 */

import type { RuntimeStatus } from "./runtime_status.js";
import type { TreeEntry, TreeSnapshot } from "./tree.js";
import type { RuntimeStatusWire, TreeEntryWire, TreeSnapshotWire } from "../protocol/types.js";

export function toRuntimeStatusWire(status: RuntimeStatus): RuntimeStatusWire {
  return {
    model: status.model
      ? {
          provider: status.model.provider,
          id: status.model.id,
          ...(status.model.name === undefined ? {} : { name: status.model.name }),
          ...(status.model.contextWindow === undefined ? {} : { context_window: status.model.contextWindow }),
          ...(status.model.reasoning === undefined ? {} : { reasoning: status.model.reasoning }),
        }
      : null,
    thinking_level: status.thinkingLevel,
    usage: {
      input: status.usage.input,
      output: status.usage.output,
      cache_read: status.usage.cacheRead,
      cache_write: status.usage.cacheWrite,
      cost: {
        input: status.usage.cost.input,
        output: status.usage.cost.output,
        cache_read: status.usage.cost.cacheRead,
        cache_write: status.usage.cost.cacheWrite,
        total: status.usage.cost.total,
      },
    },
    context: status.context
      ? { tokens: status.context.tokens, context_window: status.context.contextWindow, percent: status.context.percent }
      : null,
    updated_at: status.updatedAt,
  };
}

export function toTreeSnapshotWire(snapshot: TreeSnapshot): TreeSnapshotWire {
  return {
    snapshot_version: snapshot.snapshotVersion,
    branch_version: snapshot.branchVersion,
    leaf_id: snapshot.leafId,
    entries: snapshot.entries.map(toTreeEntryWire),
    default_filter: snapshot.defaultFilter,
    filters: [...snapshot.filters],
  };
}

function toTreeEntryWire(entry: TreeEntry): TreeEntryWire {
  return {
    id: entry.id,
    parent_id: entry.parentId,
    type: entry.type,
    ...(entry.role === undefined ? {} : { role: entry.role }),
    ...(entry.customType === undefined ? {} : { custom_type: entry.customType }),
    ...(entry.toolName === undefined ? {} : { tool_name: entry.toolName }),
    title: entry.title,
    preview: entry.preview,
    timestamp: entry.timestamp,
    is_current_leaf: entry.isCurrentLeaf,
    is_on_active_branch: entry.isOnActiveBranch,
    is_forkable: entry.isForkable,
    navigation_behavior: entry.navigationBehavior,
  };
}
