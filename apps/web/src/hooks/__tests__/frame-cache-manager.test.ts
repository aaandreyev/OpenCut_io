import { describe, it, expect, beforeEach } from "bun:test";

import {
  FrameCacheManager,
  DEFAULT_FRAME_CACHE_OPTIONS,
  type FrameCacheSharedResources,
} from "../frame-cache-manager";
import type { TimelineTrack } from "@/types/timeline";

const BASE_OPTIONS = {
  ...DEFAULT_FRAME_CACHE_OPTIONS,
  maxCacheSize: 3,
  cacheResolution: 30,
  maxMemoryUsageMB: 0.01, // ~10KB, easy to reason about in tests
};

function createSharedResources(): FrameCacheSharedResources {
  return {
    cache: new Map(),
    stats: { totalBytes: 0 },
  };
}

function createImageData(byteLength: number): ImageData {
  const data = new Uint8ClampedArray(byteLength);
  return { data } as unknown as ImageData;
}

function createTracks(): TimelineTrack[] {
  return [
    {
      id: "track-1",
      name: "Track",
      type: "media",
      elements: [
        {
          id: "element-1",
          name: "Clip",
          type: "media",
          mediaId: "media-1",
          startTime: 0,
          duration: 10,
          trimStart: 0,
          trimEnd: 0,
        },
      ],
      muted: false,
    },
  ];
}

describe("FrameCacheManager", () => {
  let shared: FrameCacheSharedResources;
  let now = 0;

  beforeEach(() => {
    shared = createSharedResources();
    now = 0;
  });

  it("stores cached frames and evicts the oldest when exceeding max cache size", () => {
    const manager = new FrameCacheManager(shared, {
      ...BASE_OPTIONS,
      maxCacheSize: 2,
    }, () => ++now);

    const tracks = createTracks();

    manager.cacheFrame(0, createImageData(4), tracks, [], null);
    manager.cacheFrame(1 / 30, createImageData(4), tracks, [], null);

    expect(manager.cacheSize).toBe(2);

    manager.cacheFrame(2 / 30, createImageData(4), tracks, [], null);

    expect(manager.cacheSize).toBe(2);
    expect(
      manager.getCachedFrame(0, tracks, [], null)
    ).toBeNull();
    expect(
      manager.getCachedFrame(1 / 30, tracks, [], null)
    ).not.toBeNull();
    expect(
      manager.getCachedFrame(2 / 30, tracks, [], null)
    ).not.toBeNull();
  });

  it("keeps memory usage under the configured limit by evicting old frames", () => {
    const manager = new FrameCacheManager(shared, {
      ...BASE_OPTIONS,
      maxMemoryUsageMB: 0.00001, // ~10 bytes
    }, () => ++now);

    const tracks = createTracks();

    manager.cacheFrame(0, createImageData(4), tracks, [], null);
    manager.cacheFrame(1 / 30, createImageData(4), tracks, [], null);

    expect(manager.memoryUsageBytes).toBeLessThanOrEqual(8);
    expect(manager.cacheSize).toBeLessThanOrEqual(2);

    manager.cacheFrame(2 / 30, createImageData(4), tracks, [], null);

    expect(manager.memoryUsageBytes).toBeLessThanOrEqual(8);
    expect(manager.cacheSize).toBeLessThanOrEqual(2);
  });

  it("skips caching frames larger than the allowed memory budget", () => {
    const manager = new FrameCacheManager(shared, {
      ...BASE_OPTIONS,
      maxMemoryUsageMB: 0.000001, // ~1 byte
    }, () => ++now);

    const tracks = createTracks();

    manager.cacheFrame(0, createImageData(4), tracks, [], null);

    expect(manager.cacheSize).toBe(0);
    expect(manager.memoryUsageBytes).toBe(0);
  });

  it("preserves existing frames when a new frame exceeds the memory budget", () => {
    const manager = new FrameCacheManager(shared, {
      ...BASE_OPTIONS,
      maxMemoryUsageMB: 0.00001, // ~10 bytes
    }, () => ++now);

    const tracks = createTracks();

    manager.cacheFrame(0, createImageData(4), tracks, [], null);

    expect(manager.cacheSize).toBe(1);
    const cachedFrame = manager.getCachedFrame(0, tracks, [], null);
    expect(cachedFrame).not.toBeNull();

    manager.cacheFrame(1 / 30, createImageData(1024), tracks, [], null);
    expect(manager.cacheSize).toBe(1);
    expect(manager.getCachedFrame(0, tracks, [], null)).toBe(cachedFrame);
    expect(manager.isFrameCached(0, tracks, [], null)).toBe(true);
  });

  it("invalidates cached frames when timeline state changes", () => {
    const manager = new FrameCacheManager(shared, BASE_OPTIONS, () => ++now);
    const tracks = createTracks();

    manager.cacheFrame(0, createImageData(4), tracks, [], null);

    expect(manager.isFrameCached(0, tracks, [], null)).toBe(true);

    const updatedTracks = createTracks();
    updatedTracks[0].elements[0].trimEnd = 1;

    expect(manager.isFrameCached(0, updatedTracks, [], null)).toBe(false);
    expect(manager.getCachedFrame(0, updatedTracks, [], null)).toBeNull();
  });

  it("replaces existing entries without inflating memory usage", () => {
    const manager = new FrameCacheManager(shared, BASE_OPTIONS, () => ++now);
    const tracks = createTracks();

    manager.cacheFrame(0, createImageData(4), tracks, [], null);
    expect(manager.memoryUsageBytes).toBe(4);

    manager.cacheFrame(0, createImageData(8), tracks, [], null);

    expect(manager.cacheSize).toBe(1);
    expect(manager.memoryUsageBytes).toBe(8);
  });
});
