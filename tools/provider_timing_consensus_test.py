import unittest

from provider_timing_consensus import analyze_result


class ProviderTimingConsensusTests(unittest.TestCase):
    def test_groups_same_first_line_into_distinct_timestamp_modes(self):
        result = {
            "song": "Sold Out",
            "video_id": "example",
            "app_lyric_track": {"title": "Sold Out", "artist": "Hawk Nelson", "source": "SyncLRC"},
            "lyric_candidate_timing_evidence": [
                {"stage": "lyric_candidate_timing_evidence", "provider": "SyncLRC",
                 "trackName": "Sold Out", "artistName": "Hawk Nelson", "synced": True,
                 "lineCount": 60, "firstLines": [{"time": 16.2, "effectiveTime": 16.2, "textFingerprint": "same"}]},
                {"stage": "lyric_candidate_timing_evidence", "provider": "LRCLIB",
                 "trackName": "Sold Out", "artistName": "Hawk Nelson", "synced": True,
                 "lineCount": 59, "firstLines": [{"time": 16.32, "effectiveTime": 16.32, "textFingerprint": "same"}]},
                {"stage": "lyric_candidate_timing_evidence", "provider": "LRCLIB",
                 "trackName": "Sold Out", "artistName": "Hawk Nelson", "synced": True,
                 "lineCount": 59, "firstLines": [{"time": 16.68, "effectiveTime": 16.68, "textFingerprint": "same"}]},
                {"stage": "lyric_candidate_timing_evidence", "provider": "LRCLIB",
                 "trackName": "Sold Out", "artistName": "Hawk Nelson", "synced": True,
                 "lineCount": 59, "firstLines": [{"time": 21.83, "effectiveTime": 21.83, "textFingerprint": "same"}]},
                {"stage": "lyric_candidate_timing_evidence", "provider": "LRCLIB",
                 "trackName": "Sold Out", "artistName": "Hawk Nelson", "synced": True,
                 "lineCount": 59, "firstLines": [{"time": 16.32, "effectiveTime": 16.32, "textFingerprint": "same"}]},
            ],
        }
        report = analyze_result(result)
        self.assertEqual(report["status"], "AMBIGUOUS_PROVIDER_TIMING")
        group = report["first_line_groups"][0]
        self.assertEqual(group["cluster_count"], 2)
        self.assertAlmostEqual(group["cluster_separation_seconds"], 5.51, places=2)
        self.assertEqual(report["automatic_correction_applied"], False)

    def test_deduplicates_repeated_provider_responses(self):
        event = {"stage": "lyric_candidate_timing_evidence", "provider": "LRCLIB",
                 "trackName": "Song", "artistName": "Artist", "synced": True,
                 "lineCount": 10, "firstLines": [{"time": 1.0, "textFingerprint": "same"}]}
        report = analyze_result({"lyric_candidate_timing_evidence": [event, event]})
        self.assertEqual(report["candidate_count"], 1)
        self.assertEqual(report["status"], "SINGLE_TIMING_CLUSTER")

    def test_ignores_unmatched_or_unsynced_candidates(self):
        result = {"lyric_candidate_timing_evidence": [
            {"stage": "lyric_candidate_timing_evidence", "provider": "A", "synced": False,
             "firstLines": [{"time": 1.0, "textFingerprint": "same"}]},
            {"stage": "lyric_candidate_timing_evidence", "provider": "B", "synced": True,
             "firstLines": [{"time": 2.0, "textFingerprint": ""}]},
            {"stage": "lyric_candidate_timing_evidence", "provider": "C", "synced": True,
             "firstLines": [{"time": 2.0, "textFingerprint": "empty", "textLength": 0}]},
        ]}
        report = analyze_result(result)
        self.assertEqual(report["candidate_count"], 0)
        self.assertEqual(report["status"], "NO_TIMING_EVIDENCE")

    def test_includes_selected_candidate_and_alternatives(self):
        result = {"lyric_candidate_timing_evidence": [{
            "stage": "lyric_candidate_selected", "provider": "A", "trackName": "Song",
            "artistName": "Artist", "synced": True, "firstLineTime": 1.0,
            "firstLineEffectiveTime": 1.05, "firstLineFingerprint": "same",
            "alternatives": [{"provider": "B", "trackName": "Song", "artistName": "Artist",
                              "firstLineTime": 2.0, "firstLineEffectiveTime": 2.0,
                              "firstLineFingerprint": "same"}],
        }]}
        report = analyze_result(result)
        self.assertEqual(report["candidate_count"], 2)
        self.assertEqual(report["status"], "AMBIGUOUS_PROVIDER_TIMING")
        self.assertTrue(any(cluster["selected_present"] for cluster in report["first_line_groups"][0]["clusters"]))


if __name__ == "__main__":
    unittest.main()
