import { toInt24, type Encoder, type EncoderOptions, type EncoderTail } from "@/lib/callRecording/encoder";

/**
 * A small streaming FLAC encoder: mono, 24-bit (Mumble's depth), fixed block
 * size, FIXED predictors of order 0–4 with partitioned Rice residuals, and
 * CONSTANT subframes for the silence the timeline pads with. No LPC, so it
 * compresses less than libFLAC, but every block is valid FLAC and decodes
 * bit-exactly. The MD5 is left unset, which the format allows.
 */

const BLOCK = 4096;
const BPS = 24;
const MAX_PARTITION_ORDER = 8;
/** RICE2 (5-bit parameters); 31 is its escape, which this encoder never uses. */
const MAX_RICE = 30;

export class FlacEncoder implements Encoder {
  private pending = new Int32Array(BLOCK);
  private fill = 0;
  private frame = 0;
  private totalSamples = 0;
  private minFrame = Infinity;
  private maxFrame = 0;

  constructor(private readonly opts: EncoderOptions) {}

  start(): Uint8Array[] {
    const comment = vorbisComment(this.opts.title);
    const head = new Uint8Array(4 + 4 + 34 + 4 + comment.length);
    head.set([0x66, 0x4c, 0x61, 0x43], 0); // fLaC
    head.set(blockHeader(false, 0, 34), 4);
    head.set(this.streamInfo(), 8);
    head.set(blockHeader(true, 4, comment.length), 42);
    head.set(comment, 46);
    return [head];
  }

  write(samples: Float32Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let i = 0; i < samples.length; i++) {
      this.pending[this.fill++] = toInt24(samples[i]);
      if (this.fill === BLOCK) {
        out.push(this.encodeFrame(this.pending));
        this.fill = 0;
      }
    }
    return out;
  }

  finish(): EncoderTail {
    const tail = this.fill > 0 ? [this.encodeFrame(this.pending.subarray(0, this.fill))] : [];
    this.fill = 0;
    return { tail, patches: [{ at: 8, bytes: this.streamInfo() }] };
  }

  private streamInfo(): Uint8Array {
    const w = new BitWriter(34);
    w.write(BLOCK, 16);
    w.write(BLOCK, 16);
    w.write(Number.isFinite(this.minFrame) ? this.minFrame : 0, 24);
    w.write(this.maxFrame, 24);
    w.write(this.opts.sampleRate, 20);
    w.write(0, 3); // channels - 1
    w.write(BPS - 1, 5);
    // 36 bits of total samples.
    w.write(Math.floor(this.totalSamples / 2 ** 32) & 0xf, 4);
    w.write(this.totalSamples % 2 ** 32, 32);
    for (let i = 0; i < 4; i++) w.write(0, 32); // MD5 unset
    return w.bytes();
  }

  private encodeFrame(block: Int32Array): Uint8Array {
    const n = block.length;
    const w = new BitWriter(n * 3 + 64);
    w.write(0xfff8, 16); // sync, fixed-blocksize stream
    w.write(n === BLOCK ? 0b1100 : 0b0111, 4); // 4096, or 16-bit (n-1) below
    w.write(0b0000, 4); // sample rate: from STREAMINFO
    w.write(0b0000, 4); // mono
    w.write(0b110, 3); // 24 bits per sample
    w.write(0, 1);
    for (const byte of utf8Number(this.frame)) w.write(byte, 8);
    if (n !== BLOCK) w.write(n - 1, 16);
    w.write(crc8(w.peek()), 8);

    writeSubframe(w, block);

    w.alignToByte();
    w.write(crc16(w.peek()), 16);
    const bytes = w.bytes();
    this.frame++;
    this.totalSamples += n;
    this.minFrame = Math.min(this.minFrame, bytes.length);
    this.maxFrame = Math.max(this.maxFrame, bytes.length);
    return bytes;
  }
}

function writeSubframe(w: BitWriter, block: Int32Array): void {
  const n = block.length;
  let constant = true;
  for (let i = 1; i < n && constant; i++) constant = block[i] === block[0];
  if (constant) {
    w.write(0b0000000, 8); // pad + CONSTANT + no wasted bits
    w.writeSigned(block[0], BPS);
    return;
  }

  let best: { order: number; residual: Int32Array; plan: RicePlan } | null = null;
  for (let order = 0; order <= Math.min(4, n - 1); order++) {
    const residual = fixedResidual(block, order);
    const plan = planRice(residual, n, order);
    if (plan && (!best || plan.bits + order * BPS < best.plan.bits + best.order * BPS)) {
      best = { order, residual, plan };
    }
  }

  if (!best || best.plan.bits + best.order * BPS >= n * BPS) {
    w.write(0b00000010, 8); // pad + VERBATIM + no wasted bits
    for (let i = 0; i < n; i++) w.writeSigned(block[i], BPS);
    return;
  }

  const { order, residual, plan } = best;
  w.write(0, 1);
  w.write(0b001000 | order, 6); // FIXED
  w.write(0, 1);
  for (let i = 0; i < order; i++) w.writeSigned(block[i], BPS);
  w.write(0b01, 2); // RICE2
  w.write(plan.order, 4);
  const parts = 1 << plan.order;
  const size = n >> plan.order;
  let index = 0;
  for (let p = 0; p < parts; p++) {
    const k = plan.params[p];
    w.write(k, 5);
    const count = p === 0 ? size - order : size;
    for (let i = 0; i < count; i++, index++) w.writeRice(zigzag(residual[index]), k);
  }
}

/** The residual of a FIXED predictor of `order` (FLAC format, "FIXED subframe"). */
function fixedResidual(x: Int32Array, order: number): Int32Array {
  const n = x.length;
  const r = new Int32Array(n - order);
  for (let i = order; i < n; i++) {
    let e: number;
    switch (order) {
      case 0: e = x[i]; break;
      case 1: e = x[i] - x[i - 1]; break;
      case 2: e = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: e = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: e = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
    r[i - order] = e;
  }
  return r;
}

const zigzag = (v: number) => (v >= 0 ? v * 2 : -v * 2 - 1);

interface RicePlan {
  order: number;
  params: number[];
  bits: number;
}

/** The cheapest partition order and per-partition Rice parameters, with the exact bit cost. */
function planRice(residual: Int32Array, n: number, predictorOrder: number): RicePlan | null {
  let maxOrder = 0;
  while (
    maxOrder < MAX_PARTITION_ORDER &&
    n % (1 << (maxOrder + 1)) === 0 &&
    n >> (maxOrder + 1) > predictorOrder
  ) {
    maxOrder++;
  }
  // Sums of zigzagged residuals per partition at the finest order, merged upward.
  const finest = 1 << maxOrder;
  const size = n >> maxOrder;
  let sums = new Array<number>(finest).fill(0);
  let counts = new Array<number>(finest).fill(0);
  for (let i = 0; i < residual.length; i++) {
    const p = Math.floor((i + predictorOrder) / size);
    sums[p] += zigzag(residual[i]);
    counts[p]++;
  }
  let best: RicePlan | null = null;
  for (let order = maxOrder; order >= 0; order--) {
    let bits = 4 + 2;
    const params: number[] = [];
    let ok = true;
    for (let p = 0; p < sums.length; p++) {
      const k = riceParam(sums[p], counts[p]);
      if (k > MAX_RICE) {
        ok = false;
        break;
      }
      params.push(k);
      bits += 5 + estimateRiceBits(residual, p, order, n, predictorOrder, k);
    }
    if (ok && (!best || bits < best.bits)) best = { order, params, bits };
    if (order > 0) {
      const nextSums: number[] = [];
      const nextCounts: number[] = [];
      for (let p = 0; p < sums.length; p += 2) {
        nextSums.push(sums[p] + sums[p + 1]);
        nextCounts.push(counts[p] + counts[p + 1]);
      }
      sums = nextSums;
      counts = nextCounts;
    }
  }
  return best;
}

/** The parameter that roughly minimizes a partition's size: log2 of its mean. */
function riceParam(sum: number, count: number): number {
  if (count === 0 || sum === 0) return 0;
  const mean = sum / count;
  return mean < 1 ? 0 : Math.floor(Math.log2(mean));
}

/** Exact bits for partition `p` of `order` at parameter `k`. */
function estimateRiceBits(
  residual: Int32Array,
  p: number,
  order: number,
  n: number,
  predictorOrder: number,
  k: number,
): number {
  const size = n >> order;
  const start = p === 0 ? 0 : p * size - predictorOrder;
  const end = (p + 1) * size - predictorOrder;
  const div = 2 ** k;
  let bits = 0;
  for (let i = start; i < end; i++) bits += Math.floor(zigzag(residual[i]) / div) + 1 + k;
  return bits;
}

/** The variable-length frame number of a fixed-blocksize stream (UTF-8's scheme, extended). */
export function utf8Number(value: number): number[] {
  if (value < 0x80) return [value];
  // Exclusive upper bounds for 2..7-byte encodings.
  const limits = [2 ** 11, 2 ** 16, 2 ** 21, 2 ** 26, 2 ** 31, 2 ** 36];
  let len = 2;
  while (value >= limits[len - 2]) len++;
  const bytes = new Array<number>(len);
  let v = value;
  for (let i = len - 1; i > 0; i--) {
    bytes[i] = 0x80 | (v % 64);
    v = Math.floor(v / 64);
  }
  bytes[0] = ((0xff << (8 - len)) & 0xff) | v;
  return bytes;
}

function blockHeader(last: boolean, type: number, length: number): Uint8Array {
  return new Uint8Array([(last ? 0x80 : 0) | type, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

function vorbisComment(title: string): Uint8Array {
  const enc = new TextEncoder();
  const vendor = enc.encode("Armada");
  const comments = [enc.encode(`TITLE=${title}`)];
  let size = 4 + vendor.length + 4;
  for (const c of comments) size += 4 + c.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  view.setUint32(at, vendor.length, true);
  out.set(vendor, (at += 4));
  at += vendor.length;
  view.setUint32(at, comments.length, true);
  at += 4;
  for (const c of comments) {
    view.setUint32(at, c.length, true);
    out.set(c, (at += 4));
    at += c.length;
  }
  return out;
}

const CRC8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

const CRC16 = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let b = 0; b < 8; b++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

function crc8(bytes: Uint8Array): number {
  let c = 0;
  for (const b of bytes) c = CRC8[c ^ b];
  return c;
}

function crc16(bytes: Uint8Array): number {
  let c = 0;
  for (const b of bytes) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b];
  return c;
}

/** MSB-first bit packing into a growable buffer. */
class BitWriter {
  private buf: Uint8Array;
  private pos = 0;
  private acc = 0;
  private nbits = 0;

  constructor(capacity: number) {
    this.buf = new Uint8Array(Math.max(16, capacity));
  }

  /** Write the low `n` (≤ 32) bits of the non-negative `value`. */
  write(value: number, n: number): void {
    while (n > 0) {
      const free = 8 - this.nbits;
      const take = free < n ? free : n;
      const shift = n - take;
      const bits = Math.floor(value / 2 ** shift) & ((1 << take) - 1);
      this.acc |= bits << (free - take);
      this.nbits += take;
      n -= take;
      if (this.nbits === 8) this.flushByte();
    }
  }

  writeSigned(value: number, n: number): void {
    this.write(value < 0 ? value + 2 ** n : value, n);
  }

  writeRice(u: number, k: number): void {
    const div = 2 ** k;
    let q = Math.floor(u / div);
    while (q > 0) {
      if (this.nbits === 0 && q >= 8) {
        this.push(0);
        q -= 8;
      } else {
        const take = Math.min(q, 8 - this.nbits);
        this.write(0, take);
        q -= take;
      }
    }
    this.write(1, 1);
    if (k > 0) this.write(u % div, k);
  }

  alignToByte(): void {
    if (this.nbits > 0) this.flushByte();
  }

  /** The whole bytes written so far. */
  peek(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }

  bytes(): Uint8Array {
    this.alignToByte();
    return this.buf.slice(0, this.pos);
  }

  private flushByte(): void {
    this.push(this.acc);
    this.acc = 0;
    this.nbits = 0;
  }

  private push(byte: number): void {
    if (this.pos === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.pos++] = byte;
  }
}
