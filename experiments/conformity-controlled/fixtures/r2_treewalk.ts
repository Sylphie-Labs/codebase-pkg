// r2_treewalk.ts -- recursive in-order binary tree traversal collecting values.
interface TreeNode {
  value: number;
  left?: TreeNode;
  right?: TreeNode;
}

export function inOrder(node: TreeNode | undefined): number[] {
  const collected: number[] = [];
  if (node === undefined) {
    return collected;
  }
  collected.push(...inOrder(node.left));
  collected.push(node.value);
  collected.push(...inOrder(node.right));
  return collected;
}
