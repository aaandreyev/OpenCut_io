import { useCallback, useMemo, useRef } from "react";

import type { TimelineTrack } from "@/types/timeline";
import type { MediaFile } from "@/types/media";
import type { TProject } from "@/types/project";

import {
  FrameCacheManager,
  getSharedResources,
  normalizeOptions,
  type FrameCacheOptions,
} from "./frame-cache-manager";

export type { FrameCacheOptions } from "./frame-cache-manager";

export function useFrameCache(options: FrameCacheOptions = {}) {
  const normalizedOptions = useMemo(
    () => normalizeOptions(options),
    [
      options.cacheResolution,
      options.maxCacheSize,
      options.maxMemoryUsageMB,
    ]
  );

  const sharedResourcesRef = useRef(getSharedResources());
  const managerRef = useRef<FrameCacheManager | null>(null);

  if (managerRef.current === null) {
    managerRef.current = new FrameCacheManager(
      sharedResourcesRef.current,
      normalizedOptions
    );
  } else {
    managerRef.current.updateOptions(normalizedOptions);
  }

  const isFrameCached = useCallback(
    (
      time: number,
      tracks: TimelineTrack[],
      mediaFiles: MediaFile[],
      activeProject: TProject | null,
      sceneId?: string
    ) => {
      return (
        managerRef.current?.isFrameCached(
          time,
          tracks,
          mediaFiles,
          activeProject,
          sceneId
        ) ?? false
      );
    },
    []
  );

  const getCachedFrame = useCallback(
    (
      time: number,
      tracks: TimelineTrack[],
      mediaFiles: MediaFile[],
      activeProject: TProject | null,
      sceneId?: string
    ) => {
      return (
        managerRef.current?.getCachedFrame(
          time,
          tracks,
          mediaFiles,
          activeProject,
          sceneId
        ) ?? null
      );
    },
    []
  );

  const cacheFrame = useCallback(
    (
      time: number,
      imageData: ImageData,
      tracks: TimelineTrack[],
      mediaFiles: MediaFile[],
      activeProject: TProject | null,
      sceneId?: string
    ) => {
      managerRef.current?.cacheFrame(
        time,
        imageData,
        tracks,
        mediaFiles,
        activeProject,
        sceneId
      );
    },
    []
  );

  const invalidateCache = useCallback(() => {
    managerRef.current?.clear();
  }, []);

  const getRenderStatus = useCallback(
    (
      time: number,
      tracks: TimelineTrack[],
      mediaFiles: MediaFile[],
      activeProject: TProject | null,
      sceneId?: string
    ): "cached" | "not-cached" => {
      return isFrameCached(time, tracks, mediaFiles, activeProject, sceneId)
        ? "cached"
        : "not-cached";
    },
    [isFrameCached]
  );

  const preRenderNearbyFrames = useCallback(
    async (
      currentTime: number,
      tracks: TimelineTrack[],
      mediaFiles: MediaFile[],
      activeProject: TProject | null,
      renderFunction: (time: number) => Promise<ImageData>,
      sceneId?: string,
      range: number = 3
    ) => {
      const manager = managerRef.current;
      if (!manager) return;

      const cacheResolution = manager.cacheResolution;
      const framesToPreRender: number[] = [];

      for (
        let offset = -range;
        offset <= range;
        offset += 1 / cacheResolution
      ) {
        const time = currentTime + offset;
        if (time < 0) continue;
        if (!manager.isFrameCached(time, tracks, mediaFiles, activeProject, sceneId)) {
          framesToPreRender.push(time);
        }
      }

      const secondsToPreRender = new Set<number>();
      for (const t of framesToPreRender) {
        secondsToPreRender.add(Math.floor(t));
      }

      const expandedTimes: number[] = [];
      for (const s of secondsToPreRender) {
        for (let k = 0; k < cacheResolution; k++) {
          const t = s + k / cacheResolution;
          if (t < 0) continue;
          if (!manager.isFrameCached(t, tracks, mediaFiles, activeProject, sceneId)) {
            expandedTimes.push(t);
          }
        }
      }

      expandedTimes.sort((a, b) => {
        const da = a >= currentTime ? a - currentTime : currentTime - a + 1e6;
        const db = b >= currentTime ? b - currentTime : currentTime - b + 1e6;
        return da - db;
      });

      const CAP = Math.max(30, Math.min(90, cacheResolution * 3));
      const toSchedule = expandedTimes.slice(0, CAP);

      for (const time of toSchedule) {
        requestIdleCallback(async () => {
          try {
            const imageData = await renderFunction(time);
            manager.cacheFrame(
              time,
              imageData,
              tracks,
              mediaFiles,
              activeProject,
              sceneId
            );
          } catch (error) {
            console.warn(`Pre-render failed for time ${time}:`, error);
          }
        });
      }
    },
    []
  );

  return {
    isFrameCached,
    getCachedFrame,
    cacheFrame,
    invalidateCache,
    getRenderStatus,
    preRenderNearbyFrames,
    cacheSize: managerRef.current?.cacheSize ?? 0,
    memoryUsageMB: managerRef.current?.memoryUsageMB ?? 0,
  };
}
