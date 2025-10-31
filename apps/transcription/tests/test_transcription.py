"""Tests for the Modal transcription helpers."""

from __future__ import annotations

import base64
import os
import sys
import types
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import ValidationError

# Ensure the repository root is on PYTHONPATH
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.append(str(REPO_ROOT))

# Provide a lightweight Modal stub so the module can be imported without the
# actual dependency during tests.
modal_module = types.ModuleType("modal")


class _ImageBuilder:
    def apt_install(self, _packages):
        return self

    def pip_install(self, _packages):
        return self


class _Image:
    @staticmethod
    def debian_slim():
        return _ImageBuilder()


class _Secret:
    @staticmethod
    def from_name(name: str):
        return {"name": name}


class _App:
    def __init__(self, _name: str):
        pass

    def function(self, *args, **kwargs):  # noqa: ANN003, ANN002 - decorator compatibility
        def decorator(func):
            return func

        return decorator

    def local_entrypoint(self, *args, **kwargs):  # noqa: ANN003, ANN002
        def decorator(func):
            return func

        return decorator


def _fastapi_endpoint(**_kwargs):  # noqa: ANN002
    def decorator(func):
        return func

    return decorator


modal_module.App = _App
modal_module.Image = _Image
modal_module.Secret = _Secret
modal_module.fastapi_endpoint = _fastapi_endpoint

sys.modules.setdefault("modal", modal_module)

from apps.transcription.transcription import (  # noqa: E402
    MIN_SEGMENT_DURATION_SECONDS,
    SEGMENT_TIME_SHIFT_SECONDS,
    TranscribeRequest,
    adjust_segment_timing,
    decrypt_file_in_place,
    normalize_language,
)


def test_normalize_language_handles_auto_and_codes():
    assert normalize_language(None) == "auto"
    assert normalize_language("  ") == "auto"
    assert normalize_language("EN-US") == "en-us"


def test_normalize_language_rejects_invalid_values():
    with pytest.raises(ValueError):
        normalize_language("invalid_language_code")


def test_adjust_segment_timing_shifts_and_limits_duration():
    segment = {
        "id": 1,
        "seek": 0,
        "start": 1.0,
        "end": 1.4,
        "text": "hello",
        "tokens": [1, 2, 3],
        "temperature": 0.0,
        "avg_logprob": 0.0,
        "compression_ratio": 1.0,
        "no_speech_prob": 0.0,
    }

    adjusted = adjust_segment_timing([segment])
    assert len(adjusted) == 1
    assert adjusted[0]["start"] == pytest.approx(
        max(0.0, segment["start"] - SEGMENT_TIME_SHIFT_SECONDS)
    )
    assert adjusted[0]["end"] >= adjusted[0]["start"] + MIN_SEGMENT_DURATION_SECONDS


def test_adjust_segment_timing_handles_empty_segments():
    assert adjust_segment_timing([]) == []


def test_transcribe_request_requires_encryption_pair():
    with pytest.raises(ValidationError):
        TranscribeRequest(filename="audio.wav", decryptionKey="abc")

    with pytest.raises(ValidationError):
        TranscribeRequest(filename="audio.wav", iv="abc")


def test_transcribe_request_rejects_invalid_base64():
    with pytest.raises(ValidationError):
        TranscribeRequest(
            filename="audio.wav",
            decryptionKey="!!invalid!!",
            iv=base64.b64encode(os.urandom(12)).decode(),
        )


def test_transcribe_request_rejects_invalid_key_length():
    bad_key = base64.b64encode(b"short").decode()
    with pytest.raises(ValidationError):
        TranscribeRequest(
            filename="audio.wav",
            decryptionKey=bad_key,
            iv=base64.b64encode(os.urandom(12)).decode(),
        )


def test_transcribe_request_rejects_invalid_iv_length():
    good_key = base64.b64encode(AESGCM.generate_key(bit_length=128)).decode()
    with pytest.raises(ValidationError):
        TranscribeRequest(
            filename="audio.wav",
            decryptionKey=good_key,
            iv=base64.b64encode(b"tiny").decode(),
        )


def test_transcribe_request_strips_filename():
    request = TranscribeRequest(filename="  audio.wav  ")
    assert request.filename == "audio.wav"


def test_decrypt_file_in_place_round_trip(tmp_path: Path):
    key = AESGCM.generate_key(bit_length=128)
    nonce = os.urandom(12)
    plaintext = b"test audio data"
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, None)

    file_path = tmp_path / "encrypted.bin"
    file_path.write_bytes(ciphertext)

    decrypt_file_in_place(
        str(file_path),
        base64.b64encode(key).decode(),
        base64.b64encode(nonce).decode(),
    )

    assert file_path.read_bytes() == plaintext


def test_decrypt_file_in_place_rejects_invalid_payload(tmp_path: Path):
    file_path = tmp_path / "invalid.bin"
    file_path.write_bytes(b"short")

    with pytest.raises(ValueError):
        decrypt_file_in_place(
            str(file_path),
            base64.b64encode(b"0" * 16).decode(),
            base64.b64encode(b"1" * 12).decode(),
        )


def test_decrypt_file_in_place_rejects_invalid_base64(tmp_path: Path):
    file_path = tmp_path / "invalid.bin"
    file_path.write_bytes(b"ciphertext")

    with pytest.raises(ValueError):
        decrypt_file_in_place(str(file_path), "!!notbase64!!", "also-bad")


def test_decrypt_file_in_place_requires_correct_iv_length(tmp_path: Path):
    key = AESGCM.generate_key(bit_length=128)
    ciphertext = AESGCM(key).encrypt(os.urandom(12), b"data", None)
    file_path = tmp_path / "invalid_iv.bin"
    file_path.write_bytes(ciphertext)

    with pytest.raises(ValueError):
        decrypt_file_in_place(
            str(file_path),
            base64.b64encode(key).decode(),
            base64.b64encode(b"short").decode(),
        )


def test_transcribe_request_validation_normalizes_language():
    request = TranscribeRequest(filename="audio.wav", language=" En ")
    assert request.language == "en"


def test_transcribe_request_accepts_auto_language_by_default():
    request = TranscribeRequest(filename="audio.wav")
    assert request.language == "auto"

