import { describe, expect, it } from "vitest";
import { buildTreeSnapshot, TREE_PREVIEW_LIMIT, type TreeNodeInput } from "./tree.js";

function messageNode(
  id: string,
  parentId: string | null,
  timestamp: string,
  role: "user" | "assistant",
  content: unknown,
  children: TreeNodeInput[] = [],
  extra: Record<string, unknown> = {},
): TreeNodeInput {
  return {
    entry: {
      type: "message",
      id,
      parentId,
      timestamp,
      message: { role, content, ...extra },
    },
    children,
  };
}

const userRoot = messageNode("u1", null, "2026-09-29T10:00:00.000Z", "user", "first prompt");

describe("buildTreeSnapshot", () => {
  it("flattens the tree and marks the active branch and leaf", () => {
    const tree: TreeNodeInput[] = [
      {
        ...userRoot,
        children: [
          messageNode("a1", "u1", "2026-09-29T10:01:00.000Z", "assistant", [{ type: "text", text: "reply" }], [
            messageNode("u2", "a1", "2026-09-29T10:02:00.000Z", "user", "second prompt"),
          ]),
          // Abandoned branch, never extended.
          messageNode("x1", "u1", "2026-09-29T10:03:00.000Z", "assistant", [{ type: "text", text: "abandoned" }]),
        ],
      },
    ];
    const snapshot = buildTreeSnapshot({ roots: tree, leafId: "u2" });
    const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));

    expect(snapshot.leafId).toBe("u2");
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(["u1", "a1", "u2", "x1"]);
    expect(byId.get("u2")!.isCurrentLeaf).toBe(true);
    expect(byId.get("u1")!.isOnActiveBranch).toBe(true);
    expect(byId.get("x1")!.isOnActiveBranch).toBe(false);
  });

  it("marks only user messages as forkable, with edit_prompt navigation", () => {
    const tree: TreeNodeInput[] = [
      {
        ...userRoot,
        children: [
          messageNode("a1", "u1", "2026-09-29T10:01:00.000Z", "assistant", [{ type: "text", text: "reply" }]),
        ],
      },
    ];
    const byId = new Map(buildTreeSnapshot({ roots: tree, leafId: "a1" }).entries.map((e) => [e.id, e]));
    expect(byId.get("u1")!.isForkable).toBe(true);
    expect(byId.get("u1")!.navigationBehavior).toBe("edit_prompt");
    expect(byId.get("a1")!.isForkable).toBe(false);
    expect(byId.get("a1")!.navigationBehavior).toBe("navigate");
  });

  it("hides an empty assistant turn but keeps it when it is the leaf", () => {
    const tree: TreeNodeInput[] = [
      messageNode("u1", null, "2026-09-29T10:00:00.000Z", "user", "prompt", [
        messageNode("a1", "u1", "2026-09-29T10:01:00.000Z", "assistant", []),
      ]),
    ];
    expect(buildTreeSnapshot({ roots: tree, leafId: "u1" }).entries.map((e) => e.id)).toEqual(["u1"]);
    // As the leaf it must stay visible, or the picker could not show position.
    expect(buildTreeSnapshot({ roots: tree, leafId: "a1" }).entries.map((e) => e.id)).toEqual(["u1", "a1"]);
  });

  it("keeps an empty assistant turn that ended in an error", () => {
    const tree: TreeNodeInput[] = [
      messageNode("u1", null, "2026-09-29T10:00:00.000Z", "user", "prompt", [
        messageNode("a1", "u1", "2026-09-29T10:01:00.000Z", "assistant", [], [], { stopReason: "error" }),
      ]),
    ];
    expect(buildTreeSnapshot({ roots: tree, leafId: "a1" }).entries.map((e) => e.id)).toEqual(["u1", "a1"]);
  });

  it("re-parents children of a hidden entry so the tree stays connected", () => {
    const tree: TreeNodeInput[] = [
      messageNode("u1", null, "2026-09-29T10:00:00.000Z", "user", "prompt", [
        {
          ...messageNode("a1", "u1", "2026-09-29T10:01:00.000Z", "assistant", []),
          children: [messageNode("u2", "a1", "2026-09-29T10:02:00.000Z", "user", "next")],
        },
      ]),
    ];
    const byId = new Map(buildTreeSnapshot({ roots: tree, leafId: "u2" }).entries.map((e) => [e.id, e]));
    expect(byId.has("a1")).toBe(false);
    expect(byId.get("u2")!.parentId).toBe("u1");
  });

  it("bounds a long preview at the limit", () => {
    const long = "x".repeat(TREE_PREVIEW_LIMIT + 50);
    const tree: TreeNodeInput[] = [messageNode("u1", null, "2026-09-29T10:00:00.000Z", "user", long)];
    const [entry] = buildTreeSnapshot({ roots: tree, leafId: "u1" }).entries;
    expect(entry!.preview).toHaveLength(TREE_PREVIEW_LIMIT);
  });

  it("leaves a preview at exactly the limit untouched", () => {
    const exact = "x".repeat(TREE_PREVIEW_LIMIT);
    const tree: TreeNodeInput[] = [messageNode("u1", null, "2026-09-29T10:00:00.000Z", "user", exact)];
    const [entry] = buildTreeSnapshot({ roots: tree, leafId: "u1" }).entries;
    expect(entry!.preview).toHaveLength(TREE_PREVIEW_LIMIT);
  });

  it("titles a label entry from its label text", () => {
    const tree: TreeNodeInput[] = [
      { entry: { type: "label", id: "l1", parentId: null, timestamp: "2026-09-29T10:00:00.000Z", label: "checkpoint" }, children: [] },
    ];
    const [entry] = buildTreeSnapshot({ roots: tree, leafId: "l1" }).entries;
    expect(entry!.type).toBe("label");
    expect(entry!.preview).toBe("checkpoint");
  });
});

describe("tree version fence", () => {
  function snapshotFor(leafId: string | null, extraChild = false) {
    const children: TreeNodeInput[] = [
      messageNode("a1", "u1", "2026-09-29T10:01:00.000Z", "assistant", [{ type: "text", text: "reply" }]),
    ];
    if (extraChild) {
      children.push(messageNode("u2", "u1", "2026-09-29T10:02:00.000Z", "user", "branch"));
    }
    return buildTreeSnapshot({
      roots: [messageNode("u1", null, "2026-09-29T10:00:00.000Z", "user", "prompt", children)],
      leafId,
    });
  }

  it("keeps snapshotVersion stable when only the branch moves", () => {
    const before = snapshotFor("u1");
    const after = snapshotFor("a1");
    expect(after.snapshotVersion).toBe(before.snapshotVersion);
    expect(after.branchVersion).not.toBe(before.branchVersion);
  });

  it("changes snapshotVersion when entry content changes", () => {
    const before = snapshotFor("u1", false);
    const after = snapshotFor("u1", true);
    expect(after.snapshotVersion).not.toBe(before.snapshotVersion);
    expect(after.branchVersion).not.toBe(before.branchVersion);
  });

  it("is deterministic for identical input", () => {
    expect(snapshotFor("a1").snapshotVersion).toBe(snapshotFor("a1").snapshotVersion);
    expect(snapshotFor("a1").branchVersion).toBe(snapshotFor("a1").branchVersion);
  });

  it("prefixes versions so clients cannot confuse them", () => {
    const snapshot = snapshotFor("a1");
    expect(snapshot.snapshotVersion.startsWith("treev_")).toBe(true);
    expect(snapshot.branchVersion.startsWith("branchv_")).toBe(true);
  });
});

describe("buildTreeSnapshot metadata", () => {
  it("advertises exactly the filters the app implements", () => {
    const snapshot = buildTreeSnapshot({ roots: [userRoot], leafId: "u1" });
    expect(snapshot.defaultFilter).toBe("default");
    // Must match session_tree_sheet.dart's _filterEntries vocabulary — a filter
    // the app does not know would render as a chip that filters nothing.
    expect(snapshot.filters).toEqual(["default", "user", "assistant", "tools"]);
  });

  it("maps an unknown entry type to 'other' rather than dropping it", () => {
    const tree: TreeNodeInput[] = [{ entry: { type: "mystery", id: "m1", parentId: null, timestamp: "2026-09-29T10:00:00.000Z" } }];
    const [entry] = buildTreeSnapshot({ roots: tree, leafId: "m1" }).entries;
    expect(entry!.type).toBe("other");
    expect(entry!.title).toBe("other");
  });
});
