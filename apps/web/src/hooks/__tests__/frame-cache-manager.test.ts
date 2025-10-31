import { describe, it, expect, beforeEach } from "bun:test";

import {
  FrameCacheManager,
  DEFAULT_FRAME_CACHE_OPTIONS,
  type FrameCacheSharedResources,
} from "../frame-cache-manager";
import type { TimelineTrack } from "@/types/timeline";
import type { TProject } from "@/types/project";

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

function createTextTracks(): TimelineTrack[] {
  return [
    {
      id: "text-track-1",
      name: "Text Track",
      type: "text",
      elements: [
        {
          id: "text-1",
          name: "Caption",
          type: "text",
          startTime: 0,
          duration: 5,
          trimStart: 0,
          trimEnd: 0,
          hidden: false,
          content: "Hello",
          fontSize: 16,
          fontFamily: "Arial",
          color: "#000000",
          backgroundColor: "#ffffff",
          textAlign: "left",
          fontWeight: "normal",
          fontStyle: "normal",
          textDecoration: "none",
          x: 0,
          y: 0,
          rotation: 0,
          opacity: 1,
        },
      ],
    },
  ];
}

function createProject(): TProject {
  return {
    id: "project-1",
    name: "Demo",
    thumbnail: "",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    scenes: [],
    currentSceneId: "scene-1",
    mediaItems: [],
    backgroundColor: "#ffffff",
    backgroundType: "color" as const,
    blurIntensity: 4 as const,
    fps: 30,
    bookmarks: [1],
    canvasSize: { width: 1920, height: 1080 },
    canvasMode: "preset" as const,
  };
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

  it("updates recency when checking an existing frame", () => {
    const manager = new FrameCacheManager(shared, BASE_OPTIONS, () => ++now);
    const tracks = createTracks();

    manager.cacheFrame(0, createImageData(4), tracks, [], createProject());
    const frameKey = Math.floor(0 * BASE_OPTIONS.cacheResolution);
    const before = shared.cache.get(frameKey);
    expect(before?.timestamp).toBe(1);

    const cached = manager.isFrameCached(0, tracks, [], createProject());
    expect(cached).toBe(true);
    const after = shared.cache.get(frameKey);
    expect(after?.timestamp).toBe(2);
  });

  it("invalidates cached text frames when text styling changes", () => {
    const manager = new FrameCacheManager(shared, BASE_OPTIONS, () => ++now);
    const tracks = createTextTracks();
    const project = createProject();

    manager.cacheFrame(0, createImageData(4), tracks, [], project);
    expect(manager.isFrameCached(0, tracks, [], project)).toBe(true);

    const updatedTracks = createTextTracks();
    updatedTracks[0].elements[0].textAlign = "center";

    expect(manager.isFrameCached(0, updatedTracks, [], project)).toBe(false);
  });

  it("invalidates cached frames when project context changes", () => {
    const manager = new FrameCacheManager(shared, BASE_OPTIONS, () => ++now);
    const tracks = createTracks();
    const project = createProject();

    manager.cacheFrame(0, createImageData(4), tracks, [], project);
    expect(manager.isFrameCached(0, tracks, [], project)).toBe(true);

    const updatedProject = { ...project, bookmarks: [1, 2] };

    expect(manager.isFrameCached(0, tracks, [], updatedProject)).toBe(false);
  });
});
