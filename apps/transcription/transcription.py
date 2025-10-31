"""Modal transcription service for OpenCut."""

from __future__ import annotations

import re

import modal
from pydantic import BaseModel, Field, field_validator, model_validator

DEFAULT_LANGUAGE = "auto"
SEGMENT_TIME_SHIFT_SECONDS = 0.5
MIN_SEGMENT_DURATION_SECONDS = 0.5
LANGUAGE_CODE_PATTERN = re.compile(r"^[a-z-]{2,10}$")


def normalize_language(language: str | None) -> str:
    """Normalize and validate the requested language string."""

    if language is None:
        return DEFAULT_LANGUAGE

    normalized = language.strip().lower()
    if not normalized:
        return DEFAULT_LANGUAGE

    if normalized == DEFAULT_LANGUAGE:
        return DEFAULT_LANGUAGE

    if not LANGUAGE_CODE_PATTERN.fullmatch(normalized):
        raise ValueError(
            "Language must contain 2-10 lowercase letters or hyphen (for example 'en' or 'en-us')"
        )

    return normalized


def adjust_segment_timing(segments: list[dict[str, object]]) -> list[dict[str, object]]:
    """Apply a consistent timing offset to Whisper segments.

    Whisper tends to report timestamps that are ~500ms late. We correct this by
    moving both the start and end time backwards while ensuring that segments
    never become negative in duration.
    """

    adjusted: list[dict[str, object]] = []
    for segment in segments:
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", start))

        shifted_start = max(0.0, start - SEGMENT_TIME_SHIFT_SECONDS)
        shifted_end = max(
            shifted_start + MIN_SEGMENT_DURATION_SECONDS,
            end - SEGMENT_TIME_SHIFT_SECONDS,
        )

        adjusted_segment = dict(segment)
        adjusted_segment["start"] = shifted_start
        adjusted_segment["end"] = shifted_end
        adjusted.append(adjusted_segment)

    return adjusted


class TranscribeRequest(BaseModel):
    filename: str = Field(min_length=1)
    language: str = Field(default=DEFAULT_LANGUAGE)
    decryptionKey: str | None = None
    iv: str | None = None

    @field_validator("decryptionKey", "iv", mode="before")
    @classmethod
    def _strip_encryption_fields(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("Encryption parameters must be strings")
        stripped = value.strip()
        if not stripped:
            raise ValueError("Encryption parameters cannot be blank")
        return stripped

    @field_validator("filename", mode="before")
    @classmethod
    def _strip_filename(cls, value: str) -> str:
        if isinstance(value, str):
            value = value.strip()
        if not value:
            raise ValueError("Filename is required")
        return value

    @field_validator("language", mode="before")
    @classmethod
    def _validate_language(cls, value: str | None) -> str:
        return normalize_language(value)

    @model_validator(mode="after")
    def _validate_encryption_fields(self) -> "TranscribeRequest":
        if bool(self.decryptionKey) ^ bool(self.iv):
            raise ValueError("decryptionKey and iv must both be provided together")

        if self.decryptionKey and self.iv:
            import base64
            import binascii

            try:
                key_bytes = base64.b64decode(self.decryptionKey)
                iv_bytes = base64.b64decode(self.iv)
            except (binascii.Error, ValueError) as exc:
                raise ValueError("Encryption parameters must be valid base64 strings") from exc

            if len(key_bytes) not in {16, 24, 32}:
                raise ValueError("Decryption key must be 128, 192, or 256 bits long")

            if len(iv_bytes) != 12:
                raise ValueError("IV must be 96 bits (12 bytes) long for AES-GCM")
        return self


app = modal.App("opencut-transcription")


def decrypt_file_in_place(path: str, key_b64: str, iv_b64: str) -> None:
    """Decrypt an AES-GCM encrypted file directly on disk."""

    import base64
    import binascii
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    try:
        key = base64.b64decode(key_b64)
        iv = base64.b64decode(iv_b64)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Encryption parameters must be valid base64 strings") from exc

    if len(key) not in {16, 24, 32}:
        raise ValueError("Decryption key must be 128, 192, or 256 bits long")

    if len(iv) != 12:
        raise ValueError("IV must be 96 bits (12 bytes) long for AES-GCM")

    with open(path, "rb") as file:
        encrypted_data = file.read()

    if len(encrypted_data) <= 16:
        raise ValueError("Encrypted audio is too short to contain authentication data")

    aesgcm = AESGCM(key)

    try:
        decrypted = aesgcm.decrypt(iv, encrypted_data, None)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Failed to decrypt audio content") from exc

    with open(path, "wb") as file:
        file.write(decrypted)


_whisper_model = None


def _get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        import whisper

        _whisper_model = whisper.load_model("base")
    return _whisper_model


@app.function(
    image=(
        modal.Image.debian_slim()
        .apt_install(["ffmpeg"])
        .pip_install([
            "openai-whisper",
            "boto3",
            "fastapi[standard]",
            "pydantic",
            "cryptography",
        ])
    ),
    gpu="A10G",
    timeout=300,  # 5 minutes
    secrets=[modal.Secret.from_name("opencut-r2-secrets")],
)
@modal.fastapi_endpoint(method="POST")
def transcribe_audio(request: TranscribeRequest):
    import os
    import tempfile
    from typing import Any

    import boto3

    try:
        filename = request.filename
        language = request.language

        if not filename:
            return {"error": "Missing filename parameter"}

        s3_client = boto3.client(
            "s3",
            endpoint_url=f"https://{os.environ['CLOUDFLARE_ACCOUNT_ID']}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
        )

        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_file:
            temp_path = temp_file.name

        try:
            s3_client.download_file(os.environ["R2_BUCKET_NAME"], filename, temp_path)

            if request.decryptionKey and request.iv:
                decrypt_file_in_place(temp_path, request.decryptionKey, request.iv)

            model = _get_whisper_model()

            if language == DEFAULT_LANGUAGE:
                result: dict[str, Any] = model.transcribe(temp_path)
            else:
                result = model.transcribe(temp_path, language=language)

            s3_client.delete_object(Bucket=os.environ["R2_BUCKET_NAME"], Key=filename)

            raw_segments = result.get("segments") if isinstance(result, dict) else []
            if not isinstance(raw_segments, list):
                raw_segments = []

            adjusted_segments = adjust_segment_timing(raw_segments)

            return {
                "text": result.get("text", ""),
                "segments": adjusted_segments,
                "language": result.get("language", language),
            }
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
    except Exception as exc:  # noqa: BLE001
        import traceback

        print(f"Transcription error: {exc}")
        print(f"Traceback: {traceback.format_exc()}")

        return {
            "error": str(exc),
            "text": "",
            "segments": [],
            "language": "unknown",
        }


@app.local_entrypoint()
def main():
    print("Transcription service is ready to deploy!")
    print("Deploy with: modal deploy transcription.py")
