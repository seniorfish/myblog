import { createHash } from 'node:crypto';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Compute the Git blob SHA-1 used by Git's object model. */
export function gitBlobSha1(data: Buffer): string {
  const header = Buffer.from(`blob ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function shortHash(hash: string, length = 7): string {
  return hash.slice(0, length);
}
