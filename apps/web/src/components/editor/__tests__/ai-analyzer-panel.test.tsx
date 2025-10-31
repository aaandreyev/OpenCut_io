/**
 * Tests for AI Analyzer Panel component
 */

import { describe, it, expect } from 'vitest';

describe('AI Analyzer Panel', () => {
  it('should calculate average face confidence correctly', () => {
    const calculateAverageFaceConfidence = (faces: Array<{
      faces: Array<{ confidence: number }>;
    }>) => {
      if (faces.length === 0) return 0;
      const totalConfidence = faces.reduce((sum, f) => {
        const avgConfidence = f.faces.length > 0
          ? f.faces.reduce((fSum, face) => fSum + face.confidence, 0) / f.faces.length
          : 0;
        return sum + avgConfidence;
      }, 0);
      return Math.round((totalConfidence / faces.length) * 100);
    };

    const testFaces = [
      { faces: [{ confidence: 0.8 }, { confidence: 0.9 }] },
      { faces: [{ confidence: 0.7 }] },
    ];

    const result = calculateAverageFaceConfidence(testFaces);
    // Average: (0.85 + 0.7) / 2 = 0.775 = 78%
    expect(result).toBe(78);
  });

  it('should handle empty faces array', () => {
    const calculateAverageFaceConfidence = (faces: Array<{
      faces: Array<{ confidence: number }>;
    }>) => {
      if (faces.length === 0) return 0;
      const totalConfidence = faces.reduce((sum, f) => {
        const avgConfidence = f.faces.length > 0
          ? f.faces.reduce((fSum, face) => fSum + face.confidence, 0) / f.faces.length
          : 0;
        return sum + avgConfidence;
      }, 0);
      return Math.round((totalConfidence / faces.length) * 100);
    };

    expect(calculateAverageFaceConfidence([])).toBe(0);
  });
});

