/**
 * Resolve a deck and all of its descendant subdecks from a full deck set.
 *
 * The root is always included first. Traversal is cycle-guarded, so malformed
 * parent links cannot loop forever.
 */
export function descendantDeckIds(
  allDecks: { id: string; "parent-id"?: string | null }[],
  rootId: string
): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const deck of allDecks) {
    const parent = deck["parent-id"];
    if (parent) {
      const siblings = childrenByParent.get(parent) ?? [];
      siblings.push(deck.id);
      childrenByParent.set(parent, siblings);
    }
  }

  const ordered: string[] = [];
  const visited = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    ordered.push(id);
    const children = childrenByParent.get(id) ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return ordered;
}
