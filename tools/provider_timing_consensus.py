"""Read-only analysis of competing first-line lyric timestamps.

This module never changes playback timing. It identifies timestamp clusters
for the same first-line text so that ambiguous provider data can be reviewed
before any calibration is considered.
"""
from __future__ import annotations

import json
import math
import statistics
from pathlib import Path
from typing import Any


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _candidate_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    events = result.get("lyric_candidate_timing_evidence") or []
    for event in events:
        if event.get("stage") == "lyric_candidate_timing_evidence":
            first = (event.get("firstLines") or [{}])[0]
            rows.append({
                "provider": str(event.get("provider") or ""),
                "track": str(event.get("trackName") or ""),
                "artist": str(event.get("artistName") or ""),
                "time": _number(first.get("effectiveTime", first.get("time"))),
                "fingerprint": str(first.get("textFingerprint") or ""),
                "synced": bool(event.get("synced")),
                "line_count": int(event.get("lineCount") or 0),
                "kind": "candidate",
            })
        elif event.get("stage") == "lyric_candidate_selected":
            rows.append({
                "provider": str(event.get("provider") or ""),
                "track": str(event.get("trackName") or ""),
                "artist": str(event.get("artistName") or ""),
                "time": _number(event.get("firstLineEffectiveTime", event.get("firstLineTime"))),
                "fingerprint": str(event.get("firstLineFingerprint") or ""),
                "synced": bool(event.get("synced")),
                "line_count": 1 if _number(event.get("firstLineTime")) is not None else 0,
                "kind": "selected",
            })
            for alt in event.get("alternatives") or []:
                rows.append({
                    "provider": str(alt.get("provider") or ""),
                    "track": str(alt.get("trackName") or ""),
                    "artist": str(alt.get("artistName") or ""),
                    "time": _number(alt.get("firstLineEffectiveTime", alt.get("firstLineTime"))),
                    "fingerprint": str(alt.get("firstLineFingerprint") or ""),
                    "synced": True,
                    "line_count": 1 if _number(alt.get("firstLineTime")) is not None else 0,
                    "kind": "alternative",
                })
    return [row for row in rows if row["synced"] and row["time"] is not None and row["fingerprint"]]


def _deduplicate(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[tuple[Any, ...], dict[str, Any]] = {}
    for row in rows:
        key = (
            row["provider"].casefold(),
            row["track"].casefold(),
            row["artist"].casefold(),
            row["fingerprint"],
            round(row["time"], 3),
        )
        # Keep the selected record when otherwise identical evidence repeats.
        if key not in unique or row["kind"] == "selected":
            unique[key] = row
    return list(unique.values())


def _clusters(rows: list[dict[str, Any]], tolerance: float) -> list[list[dict[str, Any]]]:
    ordered = sorted(rows, key=lambda row: row["time"])
    groups: list[list[dict[str, Any]]] = []
    for row in ordered:
        if not groups or row["time"] - statistics.median(x["time"] for x in groups[-1]) > tolerance:
            groups.append([row])
        else:
            groups[-1].append(row)
    return groups


def analyze_result(result: dict[str, Any], cluster_tolerance_seconds: float = 0.25) -> dict[str, Any]:
    rows = _deduplicate(_candidate_rows(result))
    by_fingerprint: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_fingerprint.setdefault(row["fingerprint"], []).append(row)

    analyses = []
    for fingerprint, matching in by_fingerprint.items():
        groups = _clusters(matching, cluster_tolerance_seconds)
        summaries = []
        for group in groups:
            times = [row["time"] for row in group]
            summaries.append({
                "median_seconds": round(statistics.median(times), 3),
                "min_seconds": round(min(times), 3),
                "max_seconds": round(max(times), 3),
                "spread_seconds": round(max(times) - min(times), 3),
                "candidate_count": len(group),
                "providers": sorted({row["provider"] for row in group if row["provider"]}),
                "tracks": sorted({row["track"] for row in group if row["track"]}),
                "selected_present": any(row["kind"] == "selected" for row in group),
            })
        if len(summaries) > 1:
            separation = round(max(x["median_seconds"] for x in summaries) -
                               min(x["median_seconds"] for x in summaries), 3)
        else:
            separation = 0.0
        analyses.append({
            "first_line_fingerprint": fingerprint,
            "cluster_count": len(summaries),
            "cluster_separation_seconds": separation,
            "ambiguous": len(summaries) > 1,
            "clusters": summaries,
        })

    return {
        "song": result.get("song", ""),
        "video_id": result.get("video_id", ""),
        "selected_track": result.get("app_lyric_track") or {},
        "selected_first_line": result.get("app_selected_first_line"),
        "candidate_count": len(rows),
        "first_line_groups": analyses,
        "status": (
            "AMBIGUOUS_PROVIDER_TIMING"
            if any(group["ambiguous"] for group in analyses)
            else "NO_MULTI_CLUSTER_CONFLICT"
        ),
        "automatic_correction_applied": False,
        "note": "Timestamp disagreement is diagnostic only; no audio-grounded correction is inferred.",
    }


def analyze_report(report: dict[str, Any], cluster_tolerance_seconds: float = 0.25) -> dict[str, Any]:
    results = report.get("results") or []
    analyzed = [analyze_result(item, cluster_tolerance_seconds) for item in results]
    return {
        "commit": report.get("commit"),
        "songs_analyzed": len(analyzed),
        "ambiguous_songs": sum(item["status"] == "AMBIGUOUS_PROVIDER_TIMING" for item in analyzed),
        "automatic_correction_applied": False,
        "results": analyzed,
    }


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="Historical lyric regression JSON")
    parser.add_argument("--output", type=Path, help="Optional JSON output path")
    args = parser.parse_args()
    data = json.loads(args.report.read_text(encoding="utf-8"))
    analyzed = analyze_report(data)
    rendered = json.dumps(analyzed, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
