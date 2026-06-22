async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchBuffer: HTTP ${res.status} from ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function downloadInit(initUrl: string): Promise<Buffer> {
  return fetchBuffer(initUrl);
}

export async function downloadSegment(url: string): Promise<Buffer> {
  return fetchBuffer(url);
}

export function concatInitAndSegment(init: Buffer, segment: Buffer): Buffer {
  return Buffer.concat([init, segment]);
}
