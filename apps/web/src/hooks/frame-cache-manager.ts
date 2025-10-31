import { TimelineTrack, MediaElement, TextElement } from "@/types/timeline";
import { MediaFile } from "@/types/media";
import { TProject } from "@/types/project";

interface CachedFrame {
  imageData: ImageData;
  timelineHash: string;
  timestamp: number;
  size: number;
}

interface CacheStats {
  totalBytes: number;
}

export interface FrameCacheOptions {
  maxCacheSize?: number;
  cacheResolution?: number;
  maxMemoryUsageMB?: number;
}

export interface FrameCacheSharedResources {
  cache: Map<number, CachedFrame>;
  stats: CacheStats;
}

export const DEFAULT_FRAME_CACHE_OPTIONS: Required<FrameCacheOptions> = {
  maxCacheSize: 300,
  cacheResolution: 30,
  maxMemoryUsageMB: 128,
};

const BYTES_PER_MB = 1024 * 1024;

function clampNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function normalizeOptions(
  options: FrameCacheOptions
): Required<FrameCacheOptions> {
  return {
    maxCacheSize: options.maxCacheSize ?? DEFAULT_FRAME_CACHE_OPTIONS.maxCacheSize,
    cacheResolution:
      options.cacheResolution ?? DEFAULT_FRAME_CACHE_OPTIONS.cacheResolution,
    maxMemoryUsageMB:
      options.maxMemoryUsageMB ?? DEFAULT_FRAME_CACHE_OPTIONS.maxMemoryUsageMB,
  };
}

export function getSharedResources(): FrameCacheSharedResources {
  const globalScope = globalThis as unknown as {
    __sharedFrameCache?: Map<number, CachedFrame>;
    __sharedCacheStats?: CacheStats;
  };

  if (!globalScope.__sharedFrameCache) {
    globalScope.__sharedFrameCache = new Map<number, CachedFrame>();
  }

  if (!globalScope.__sharedCacheStats) {
    globalScope.__sharedCacheStats = { totalBytes: 0 };
  }

  return {
    cache: globalScope.__sharedFrameCache,
    stats: globalScope.__sharedCacheStats,
  };
}

function computeActiveElements(
  time: number,
  tracks: TimelineTrack[]
): Array<{
  id: string;
  type: string;
  startTime: number;
  duration: number;
  trimStart: number;
  trimEnd: number;
  mediaId?: string;
  content?: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  backgroundColor?: string;
  x?: number;
  y?: number;
  rotation?: number;
  opacity?: number;
}> {
  const active: Array<{
    id: string;
    type: string;
    startTime: number;
    duration: number;
    trimStart: number;
    trimEnd: number;
    mediaId?: string;
    content?: string;
    fontSize?: number;
    fontFamily?: string;
    color?: string;
    backgroundColor?: string;
    x?: number;
    y?: number;
    rotation?: number;
    opacity?: number;
  }> = [];

  for (const track of tracks) {
    if (track.muted) continue;

    for (const element of track.elements) {
      const isHidden = "hidden" in element ? element.hidden : false;
      if (isHidden) continue;

      const elementStart = element.startTime;
      const elementEnd =
        element.startTime + (element.duration - element.trimStart - element.trimEnd);

      if (time >= elementStart && time < elementEnd) {
        if (element.type === "media") {
          const mediaElement = element as MediaElement;
          active.push({
            id: element.id,
            type: element.type,
            startTime: element.startTime,
            duration: element.duration,
            trimStart: element.trimStart,
            trimEnd: element.trimEnd,
            mediaId: mediaElement.mediaId,
          });
        } else if (element.type === "text") {
          const textElement = element as TextElement;
          active.push({
            id: element.id,
            type: element.type,
            startTime: element.startTime,
            duration: element.duration,
            trimStart: element.trimStart,
            trimEnd: element.trimEnd,
            content: textElement.content,
            fontSize: textElement.fontSize,
            fontFamily: textElement.fontFamily,
            color: textElement.color,
            backgroundColor: textElement.backgroundColor,
            x: textElement.x,
            y: textElement.y,
            rotation: textElement.rotation,
            opacity: textElement.opacity,
          });
        }
      }
    }
  }

  return active;
}

export class FrameCacheManager {
  private options: Required<FrameCacheOptions>;

  constructor(
    private readonly shared: FrameCacheSharedResources,
    options: FrameCacheOptions,
    private readonly now: () => number = () => Date.now()
  ) {
    this.options = normalizeOptions(options);
  }

  updateOptions(options: FrameCacheOptions): void {
    this.options = normalizeOptions(options);
  }

  private get cache(): Map<number, CachedFrame> {
    return this.shared.cache;
  }

  private get stats(): CacheStats {
    return this.shared.stats;
  }

  get cacheResolution(): number {
    return this.options.cacheResolution;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  get memoryUsageBytes(): number {
    return this.stats.totalBytes;
  }

  get memoryUsageMB(): number {
    return this.memoryUsageBytes / BYTES_PER_MB;
  }

  private get maxMemoryBytes(): number {
    return clampNonNegative(this.options.maxMemoryUsageMB) * BYTES_PER_MB;
  }

  private frameKeyFor(time: number): number {
    return Math.floor(time * this.options.cacheResolution);
  }

  private timelineHash(
    time: number,
    tracks: TimelineTrack[],
    mediaFiles: MediaFile[],
    activeProject: TProject | null,
    sceneId?: string
  ): string {
    const activeElements = computeActiveElements(time, tracks);

    const projectState = {
      backgroundColor: activeProject?.backgroundColor,
      backgroundType: activeProject?.backgroundType,
      blurIntensity: activeProject?.blurIntensity,
      canvasSize: activeProject?.canvasSize,
    };

    const clampedTime =
      Math.floor(time * this.options.cacheResolution) /
      this.options.cacheResolution;

    const mediaState = mediaFiles.map((file) => ({
      id: file.id,
      duration: file.duration,
      width: file.width,
      height: file.height,
      url: file.url,
      fps: file.fps,
      ephemeral: file.ephemeral,
    }));

    return JSON.stringify({
      activeElements,
      projectState,
      sceneId,
      time: clampedTime,
      mediaState,
    });
  }

  private removeFrame(frameKey: number): void {
    const existing = this.cache.get(frameKey);
    if (!existing) return;

    const size = existing.size ?? existing.imageData.data?.byteLength ?? 0;
    this.stats.totalBytes = Math.max(0, this.stats.totalBytes - size);
    this.cache.delete(frameKey);
  }

  private getOldestKey(): number | undefined {
    let oldestKey: number | undefined;
    let oldestTimestamp = Number.POSITIVE_INFINITY;

    for (const [key, value] of this.cache.entries()) {
      if (value.timestamp < oldestTimestamp) {
        oldestTimestamp = value.timestamp;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  private ensureCapacity(newFrameSize: number): boolean {
    const maxCacheSize = Math.floor(clampNonNegative(this.options.maxCacheSize));
    const maxMemoryBytes = this.maxMemoryBytes;

    if (maxCacheSize <= 0) {
      this.clear();
      return false;
    }

    if (newFrameSize > maxMemoryBytes) {
      return false;
    }

    while (
      (this.cache.size >= maxCacheSize && this.cache.size > 0) ||
      this.stats.totalBytes + newFrameSize > maxMemoryBytes
    ) {
      const oldestKey = this.getOldestKey();
      if (oldestKey === undefined) {
        break;
      }
      this.removeFrame(oldestKey);
    }

    if (
      this.cache.size >= maxCacheSize ||
      this.stats.totalBytes + newFrameSize > maxMemoryBytes
    ) {
      return false;
    }

    return true;
  }

  private touchFrame(frameKey: number): void {
    const existing = this.cache.get(frameKey);
    if (!existing) return;
    existing.timestamp = this.now();
  }

  isFrameCached(
    time: number,
    tracks: TimelineTrack[],
    mediaFiles: MediaFile[],
    activeProject: TProject | null,
    sceneId?: string
  ): boolean {
    const frameKey = this.frameKeyFor(time);
    const cached = this.cache.get(frameKey);
    if (!cached) return false;

    const currentHash = this.timelineHash(
      time,
      tracks,
      mediaFiles,
      activeProject,
      sceneId
    );
    const matches = cached.timelineHash === currentHash;
    if (!matches) {
      this.removeFrame(frameKey);
    }
    return matches;
  }

  getCachedFrame(
    time: number,
    tracks: TimelineTrack[],
    mediaFiles: MediaFile[],
    activeProject: TProject | null,
    sceneId?: string
  ): ImageData | null {
    const frameKey = this.frameKeyFor(time);
    const cached = this.cache.get(frameKey);
    if (!cached) return null;

    const currentHash = this.timelineHash(
      time,
      tracks,
      mediaFiles,
      activeProject,
      sceneId
    );

    if (cached.timelineHash !== currentHash) {
      this.removeFrame(frameKey);
      return null;
    }

    this.touchFrame(frameKey);
    return cached.imageData;
  }

  cacheFrame(
    time: number,
    imageData: ImageData,
    tracks: TimelineTrack[],
    mediaFiles: MediaFile[],
    activeProject: TProject | null,
    sceneId?: string
  ): void {
    const frameKey = this.frameKeyFor(time);
    const timelineHash = this.timelineHash(
      time,
      tracks,
      mediaFiles,
      activeProject,
      sceneId
    );
    const newFrameSize = imageData.data?.byteLength ?? 0;

    if (this.cache.has(frameKey)) {
      this.removeFrame(frameKey);
    }

    if (!this.ensureCapacity(newFrameSize)) {
      return;
    }

    this.cache.set(frameKey, {
      imageData,
      timelineHash,
      timestamp: this.now(),
      size: newFrameSize,
    });
    this.stats.totalBytes += newFrameSize;
  }

  clear(): void {
    this.cache.clear();
    this.stats.totalBytes = 0;
  }
}

export type { CachedFrame };
