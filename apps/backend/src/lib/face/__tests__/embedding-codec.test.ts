import { describe, expect, it } from "vitest";
import { decodeEmbedding, encodeEmbedding } from "../embedding-codec";

describe("embedding-codec", () => {
  it("encode → decode 互逆（512 维 ArcFace 典型尺寸）", () => {
    const original = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      original[i] = (i / 512 - 0.5) * 2;
    }
    const b64 = encodeEmbedding(original);
    const decoded = decodeEmbedding(b64);
    expect(decoded.length).toBe(512);
    for (let i = 0; i < 512; i++) {
      expect(decoded[i]).toBeCloseTo(original[i] ?? 0, 6);
    }
  });

  it("产出的 base64 长度符合 (4 bytes per float) 期望", () => {
    const arr = new Float32Array(512);
    const b64 = encodeEmbedding(arr);
    // 2048 bytes -> base64 = ceil(2048/3) * 4 = 2732 chars
    expect(b64.length).toBe(2732);
  });

  it("空数组 round-trip 仍工作", () => {
    const empty = new Float32Array(0);
    expect(decodeEmbedding(encodeEmbedding(empty)).length).toBe(0);
  });

  it("含 NaN / Infinity 也能 round-trip", () => {
    const arr = new Float32Array([
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -0,
    ]);
    const decoded = decodeEmbedding(encodeEmbedding(arr));
    expect(Number.isNaN(decoded[0])).toBe(true);
    expect(decoded[1]).toBe(Number.POSITIVE_INFINITY);
    expect(decoded[2]).toBe(Number.NEGATIVE_INFINITY);
    expect(decoded[3]).toBe(0);
    expect(Object.is(decoded[4], -0)).toBe(true);
  });
});
