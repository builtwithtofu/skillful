import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export class NarError extends Error {}
function encoded(value: string | Buffer) {
  const data = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(data.length));
  const padding = Buffer.alloc((8 - (data.length % 8)) % 8);
  return [length, data, padding];
}
function dump(path: string, chunks: Buffer[]) {
  const stat = lstatSync(path);
  chunks.push(...encoded("("), ...encoded("type"));
  if (stat.isDirectory()) {
    chunks.push(...encoded("directory"));
    const entries = readdirSync(path).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of entries) {
      chunks.push(...encoded("entry"), ...encoded("("), ...encoded("name"), ...encoded(name), ...encoded("node"));
      dump(join(path, name), chunks);
      chunks.push(...encoded(")"));
    }
  } else if (stat.isFile()) {
    chunks.push(...encoded("regular"));
    if ((stat.mode & 0o111) !== 0) chunks.push(...encoded("executable"), ...encoded(""));
    chunks.push(...encoded("contents"), ...encoded(readFileSync(path)));
  } else if (stat.isSymbolicLink()) {
    chunks.push(...encoded("symlink"), ...encoded("target"), ...encoded(readlinkSync(path)));
  } else throw new NarError(`unsupported filesystem kind for NAR: ${path}`);
  chunks.push(...encoded(")"));
}
export function narBytes(path: string) {
  const chunks: Buffer[] = [...encoded("nix-archive-1")];
  dump(path, chunks);
  return Buffer.concat(chunks);
}
export function narHash(path: string) {
  const digest = createHash("sha256").update(narBytes(path)).digest("base64");
  return `sha256-${digest}`;
}
export function cacheKey(hash: string) {
  if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(hash)) throw new NarError(`invalid SRI sha256: ${hash}`);
  return hash.slice("sha256-".length).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
