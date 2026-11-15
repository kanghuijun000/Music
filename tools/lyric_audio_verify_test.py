#!/usr/bin/env python3
"""Focused identity tests for the live lyric regression verifier."""
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
print("PASS: exact collaboration, credited performer, unrelated artist rejection, and VEVO normalization")
