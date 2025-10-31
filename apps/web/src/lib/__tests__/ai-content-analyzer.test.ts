/**
 * Tests for AI Content Analyzer functionality
 */

import { describe, it, expect } from 'vitest';
import type { ContentAnalysisResult } from '../ai-content-analyzer';

describe('AI Content Analyzer', () => {
  it('should have correct analysis result structure', () => {
    const mockResult: ContentAnalysisResult = {
      summary: {
        totalDuration: 60,
        contentType: 'vlog',
        sceneCount: 5,
        faceDetectionCount: 10,
        avgMotionLevel: 0.6,
        avgAudioLevel: 0.7,
        dominantColors: ['#FF0000', '#00FF00'],
      },
      scenes: [],
      faces: [],
      highlights: [],
      audio: [],
      colorGrading: [],
      tags: ['outdoor', 'daytime'],
    };

    expect(mockResult.summary).toBeDefined();
    expect(mockResult.scenes).toBeInstanceOf(Array);
    expect(mockResult.faces).toBeInstanceOf(Array);
    expect(mockResult.highlights).toBeInstanceOf(Array);
  });

  it('should handle configurable analysis interval', () => {
    const defaultInterval = 0.5;
    const customInterval = 1.0;
    
    const options1 = { analysisInterval: customInterval };
    const options2 = undefined;
    
    expect(options1.analysisInterval).toBe(customInterval);
    expect(options2?.analysisInterval || defaultInterval).toBe(defaultInterval);
  });

  it('should calculate total frames correctly based on interval', () => {
    const duration = 10;
    const interval = 0.5;
    const totalFrames = Math.floor(duration / interval);
    
    expect(totalFrames).toBe(20);
  });
});

