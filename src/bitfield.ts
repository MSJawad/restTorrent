// A fixed-size bit set in the BitTorrent wire format: the high bit of the
// first byte is piece 0.

export class Bitfield {
  readonly size: number;
  readonly buffer: Buffer;
  #count = 0;

  constructor(size: number, buffer?: Buffer) {
    this.size = size;
    this.buffer = Buffer.alloc(Math.ceil(size / 8));
    if (buffer) {
      buffer.copy(this.buffer, 0, 0, this.buffer.length);
      // Spare bits at the end must be ignored.
      const spare = this.buffer.length * 8 - size;
      if (spare > 0 && this.buffer.length > 0) {
        const last = this.buffer.length - 1;
        this.buffer[last] = (this.buffer[last] as number) & (0xff << spare);
      }
      for (let i = 0; i < size; i++) if (this.has(i)) this.#count++;
    }
  }

  has(index: number): boolean {
    const byte = this.buffer[index >> 3];
    return byte !== undefined && (byte & (0x80 >> (index & 7))) !== 0;
  }

  set(index: number): void {
    if (index < 0 || index >= this.size || this.has(index)) return;
    this.buffer[index >> 3] = (this.buffer[index >> 3] as number) | (0x80 >> (index & 7));
    this.#count++;
  }

  clear(index: number): void {
    if (!this.has(index)) return;
    this.buffer[index >> 3] = (this.buffer[index >> 3] as number) & ~(0x80 >> (index & 7));
    this.#count--;
  }

  get count(): number {
    return this.#count;
  }

  get complete(): boolean {
    return this.#count === this.size;
  }
}
