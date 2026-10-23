import { realpathSync, statSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";

export interface WorkspaceIdentity {
  readonly root: string;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
  readonly key: string;
}

function hasCreationTime(root: string, info: BigIntStats): boolean {
  if (info.birthtimeNs <= 0n) return false;
  if (info.birthtimeNs !== info.ctimeNs) return true;

  // Equal times are valid for a new directory, but also occur when libuv uses
  // ctime as a fallback. Its synchronous Linux statx fallback is process-wide.
  // Require an older ancestor on the same filesystem to demonstrate support;
  // do not cache this evidence, since statx can become unavailable later.
  let path = root;
  while (dirname(path) !== path) {
    path = dirname(path);
    const ancestor = statSync(path, { bigint: true });
    if (!ancestor.isDirectory() || ancestor.dev !== info.dev || ancestor.birthtimeNs <= 0n)
      return false;
    if (ancestor.birthtimeNs !== ancestor.ctimeNs) return true;
  }
  return false;
}

/** Capture the stable directory identity used by authorization and coordination. */
export function inspectWorkspace(cwd: string): WorkspaceIdentity {
  const root = realpathSync(cwd);
  const info = statSync(root, { bigint: true });
  if (!info.isDirectory()) throw new Error("Workspace must be a directory.");
  if (info.dev < 0n || info.ino <= 0n || !hasCreationTime(root, info))
    throw new Error("Workspace identity is unavailable.");
  const device = info.dev.toString(10);
  const inode = info.ino.toString(10);
  const birthtimeNs = info.birthtimeNs.toString(10);
  return Object.freeze({
    root,
    device,
    inode,
    birthtimeNs,
    key: JSON.stringify([root, device, inode, birthtimeNs]),
  });
}

export function sameWorkspace(
  left: WorkspaceIdentity | undefined,
  right: WorkspaceIdentity | undefined,
): boolean {
  return left !== undefined && right !== undefined && left.key === right.key;
}
