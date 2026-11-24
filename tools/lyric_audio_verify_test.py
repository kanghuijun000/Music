#!/usr/bin/env python3
"""Focused identity tests for the live lyric regression verifier."""
from unittest.mock import patch
import lyric_audio_verify as verifier
from lyric_audio_verify import norm, verify

EXPECTED_ARTISTS = "김하온 (HAON), Nosun, Raf Sandou, Marv, 정준혁"
IDENTITY = (
    "TICK TOCK (Feat. ZICO) (Prod. by ZICO, Crush) [쇼미더머니 12 Episode 1]",
    "TICK TOCK",
    EXPECTED_ARTISTS,
    "Mnet K-POP",
    "",
)

def result_for(app_artist: str) -> dict:
    snapshot = {
        "track": {"title": "TICK TOCK", "artist": app_artist, "source": "SyncLRC"},
        "lines": [{"time": 1.0, "text": "검증 가사"}],
        "timingBasis": "catalog",
        "lyricOffsetSeconds": 0,
        "plainLyricsPresent": True,
    }
    return verify(None, "test-video", snapshot, IDENTITY)

assert result_for(EXPECTED_ARTISTS)["identity_verified"], "full credited artist lineup must match itself"
assert result_for("Nosun")["identity_verified"], "a single credited performer must match the collaboration"
assert not result_for("Unrelated Artist")["identity_verified"], "an unrelated artist must be rejected"
assert norm("OneRepublicVEVO") == norm("OneRepublic"), "VEVO channel suffix must not alter artist identity"
assert abs(verifier.effective_app_offset({"lyricOffsetSeconds": 1.2, "videoManualAdvanceSeconds": 0.95, "lyricLeadSeconds": 0.04}) - 0.21) < 1e-9, "manual video correction and display lead must be included in the effective app offset"
assert abs(verifier.effective_app_offset({"lyricOffsetSeconds": 0.0}) + 0.04) < 1e-9, "legacy snapshots must include the display lead"

def identify_title(title: str, author: str):
    with patch("lyric_audio_verify.fetch_json", return_value={"title": title, "author_name": author}):
        with patch("lyric_audio_verify.fetch_video_description", return_value=""):
            return verifier.identify("test-video")

def verify_parsed_identity(title: str, author: str, app_title: str, app_artist: str):
    identity = identify_title(title, author)
    snapshot = {
        "track": {"title": app_title, "artist": app_artist, "source": "LRCLIB"},
        "lines": [{"time": 1.0, "text": "검증 가사"}],
        "timingBasis": "catalog",
        "lyricOffsetSeconds": 0,
        "plainLyricsPresent": True,
    }
    return identity, verify(None, "test-video", snapshot, identity)

# These were false-negative QA cases: presentation labels and channel metadata
# must not be mistaken for part of the song identity.
younha_identity, younha_result = verify_parsed_identity(
    "윤하(YOUNHA) - 사건의 지평선 M/V", "YOUNHA", "사건의 지평선", "YOUNHA")
assert younha_identity[1] == "사건의 지평선", younha_identity
assert younha_result["identity_verified"], younha_result

bts_identity, bts_result = verify_parsed_identity(
    "BTS (방탄소년단) 'Dynamite' Official MV", "HYBE LABELS", "Dynamite", "BTS")
assert bts_identity[1] == "Dynamite" and norm(bts_identity[2]) == norm("BTS"), bts_identity
assert bts_result["identity_verified"], bts_result

newjeans_identity, newjeans_result = verify_parsed_identity(
    "NewJeans (뉴진스) 'Ditto' Performance Video", "HYBE LABELS", "Ditto", "NewJeans")
assert newjeans_identity[1] == "Ditto" and norm(newjeans_identity[2]) == norm("NewJeans"), newjeans_identity
assert newjeans_result["identity_verified"], newjeans_result


# First-line calibration diagnostics must detect small signed offsets without
# treating them as automatic corrections.
near_late = verifier.measure_first_line_anchor(
    5.0, [(0.91, 5.05, 5.42, 0, 2)], 0.0)
assert near_late["verified"] and abs(near_late["first_line_signed_error_seconds"] - 0.05) < 1e-9, near_late
near_early = verifier.measure_first_line_anchor(
    5.0, [(0.94, 4.85, 5.20, 0, 2)], 0.0)
assert near_early["verified"] and abs(near_early["first_line_signed_error_seconds"] + 0.15) < 1e-9, near_early
assert near_late["automatic_correction_applied"] is False, near_late
assert not verifier.measure_first_line_anchor(
    5.0, [(0.60, 5.05, 5.42, 0, 2)], 0.0)["verified"], "low-confidence phrase match must not be accepted"
assert not verifier.measure_first_line_anchor(
    5.0, [], 0.0)["verified"], "missing vocal evidence must remain unverified"

print("PASS: identity matching, first-line offset diagnostics, and conservative no-auto-correction safeguards")
