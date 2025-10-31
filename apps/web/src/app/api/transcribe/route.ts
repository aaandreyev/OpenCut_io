import { Buffer } from "node:buffer";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/env";
import { baseRateLimit } from "@/lib/rate-limit";
import { isTranscriptionConfigured } from "@/lib/transcription-utils";

const LANGUAGE_PATTERN = /^[a-z-]{2,10}$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const segmentSchema = z.object({
  id: z.number(),
  seek: z.number(),
  start: z.number(),
  end: z.number(),
  text: z.string(),
  tokens: z.array(z.number()),
  temperature: z.number(),
  avg_logprob: z.number(),
  compression_ratio: z.number(),
  no_speech_prob: z.number(),
});

const transcribeRequestSchema = z
  .object({
    filename: z.string().trim().min(1, "Filename is required"),
    language: z.string().optional(),
    decryptionKey: z
      .string()
      .trim()
      .min(1, "Decryption key is required")
      .optional(),
    iv: z.string().trim().min(1, "IV is required").optional(),
  })
  .superRefine((value, ctx) => {
    const hasKey = Boolean(value.decryptionKey?.trim());
    const hasIv = Boolean(value.iv?.trim());

    if (hasKey !== hasIv) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "decryptionKey and iv must both be provided together",
        path: hasKey ? ["iv"] : ["decryptionKey"],
      });
    }

    if (value.language) {
      const normalized = value.language.trim().toLowerCase();
      if (
        normalized &&
        normalized !== "auto" &&
        !LANGUAGE_PATTERN.test(normalized)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Language must contain 2-10 letters or hyphen (for example 'en' or 'en-us')",
          path: ["language"],
        });
      }
    }

    if (hasKey && hasIv) {
      const trimmedKey = value.decryptionKey!.trim();
      const trimmedIv = value.iv!.trim();

      const base64Issues: Array<{ path: string[]; message: string }> = [];

      if (!BASE64_PATTERN.test(trimmedKey)) {
        base64Issues.push({
          path: ["decryptionKey"],
          message: "Encryption parameters must be valid base64 strings",
        });
      }

      if (!BASE64_PATTERN.test(trimmedIv)) {
        base64Issues.push({
          path: ["iv"],
          message: "Encryption parameters must be valid base64 strings",
        });
      }

      base64Issues.forEach((issue) => {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: issue.path,
          message: issue.message,
        });
      });

      if (base64Issues.length > 0) {
        return;
      }

      const keyBytes = Buffer.from(trimmedKey, "base64");
      const ivBytes = Buffer.from(trimmedIv, "base64");

      if (![16, 24, 32].includes(keyBytes.length)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Decryption key must be 128, 192, or 256 bits long",
          path: ["decryptionKey"],
        });
      }

      if (ivBytes.length !== 12) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "IV must be 96 bits (12 bytes) long for AES-GCM",
          path: ["iv"],
        });
      }
    }
  })
  .transform((value) => ({
    filename: value.filename.trim(),
    language: value.language
      ? value.language.trim().toLowerCase() || "auto"
      : "auto",
    decryptionKey: value.decryptionKey?.trim(),
    iv: value.iv?.trim(),
  }));

const modalResponseSchema = z.object({
  text: z.string(),
  segments: z.array(segmentSchema),
  language: z.string(),
});

const apiResponseSchema = modalResponseSchema;

export async function POST(request: NextRequest) {
  try {
    // Rate limiting
    const forwardedFor = request.headers.get("x-forwarded-for");
    const ip = forwardedFor?.split(",")[0]?.trim() ?? "anonymous";
    const { success } = await baseRateLimit.limit(ip);

    if (!success) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    // Check transcription configuration
    const transcriptionCheck = isTranscriptionConfigured();
    if (!transcriptionCheck.configured) {
      console.error(
        "Missing environment variables:",
        JSON.stringify(transcriptionCheck.missingVars)
      );

      return NextResponse.json(
        {
          error: "Transcription not configured",
          message: `Auto-captions require environment variables: ${transcriptionCheck.missingVars.join(", ")}. Check README for setup instructions.`,
        },
        { status: 503 }
      );
    }

    // Parse and validate request body
    const rawBody = await request.json().catch(() => null);
    if (!rawBody) {
      return NextResponse.json(
        { error: "Invalid JSON in request body" },
        { status: 400 }
      );
    }

    const validationResult = transcribeRequestSchema.safeParse(rawBody);
    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: "Invalid request parameters",
          details: validationResult.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { filename, language, decryptionKey, iv } = validationResult.data;

    // Prepare request body for Modal
    const modalRequestBody: Record<string, string> = {
      filename,
      language,
    };

    // Add encryption parameters if provided (zero-knowledge)
    if (decryptionKey && iv) {
      modalRequestBody.decryptionKey = decryptionKey;
      modalRequestBody.iv = iv;
    }

    // Call Modal transcription service
    const response = await fetch(env.MODAL_TRANSCRIPTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(modalRequestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Modal API error:", response.status, errorText);

      let errorMessage = "Transcription service unavailable";
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Use default message if parsing fails
      }

      return NextResponse.json(
        {
          error: errorMessage,
          message: "Failed to process transcription request",
        },
        { status: response.status >= 500 ? 502 : response.status }
      );
    }

    const rawResult = await response.json();

    // Validate Modal response
    const modalValidation = modalResponseSchema.safeParse(rawResult);
    if (!modalValidation.success) {
      console.error("Invalid Modal API response:", modalValidation.error);
      return NextResponse.json(
        { error: "Invalid response from transcription service" },
        { status: 502 }
      );
    }

    const responseValidation = apiResponseSchema.safeParse(modalValidation.data);
    if (!responseValidation.success) {
      console.error(
        "Invalid API response structure:",
        responseValidation.error
      );
      return NextResponse.json(
        { error: "Internal response formatting error" },
        { status: 500 }
      );
    }

    return NextResponse.json(responseValidation.data);
  } catch (error) {
    console.error("Transcription API error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: "An unexpected error occurred during transcription",
      },
      { status: 500 }
    );
  }
}
