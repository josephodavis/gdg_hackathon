// Binary payload decoder — mirrors backend/payload.py (PLAN.md §4).

export interface CameraInfo {
  c2w: number[]; // 16, row-major, OpenCV camera axes (x right, y down, z forward) in Y-up world
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface PayloadHeader {
  version: number;
  numPoints: number;
  units: string;
  metricScale: number | null;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  floorY?: number;
  cameras: CameraInfo[];
  up: [number, number, number];
  upMethod?: string;
  timingMs: Record<string, number>;
  numImages: number;
}

export interface Payload {
  header: PayloadHeader;
  positions: Float32Array; // N*3 meters
  colors: Uint8Array; // N*3
}

export function decodePayload(buf: ArrayBuffer): Payload {
  const dv = new DataView(buf);
  const hlen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen))) as PayloadHeader;
  let off = 4 + hlen;
  off += (4 - (off % 4)) % 4;
  const n = header.numPoints;
  const need = off + n * 15;
  if (buf.byteLength < need) throw new Error(`Payload truncated: ${buf.byteLength} < ${need} bytes`);
  const positions = new Float32Array(buf, off, n * 3);
  const colors = new Uint8Array(buf, off + n * 12, n * 3);
  return { header, positions, colors };
}
