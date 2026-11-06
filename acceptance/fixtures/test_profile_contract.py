import json
import tempfile
import unittest
from pathlib import Path

from profile_contract import (
    MARKER,
    assert_same,
    authorize_paths,
    ensure_marker,
    protect,
    require_existing_storage,
    validate_index,
    validate_records,
)


class ContractTests(unittest.TestCase):
    def test_data_and_plugin_directory_links_are_rejected(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as outer:
            outer = Path(outer).resolve()
            for relative in ("data", "data/plugin_data"):
                with self.subTest(relative=relative):
                    root = outer / ("a12-sdk-" + relative.replace("/", "-"))
                    host = root / "profile/runtime/astrbot"
                    host.mkdir(parents=True)
                    (root / "synthetic-root.json").write_text(
                        json.dumps({"kind": "DSWhaleSyntheticAcceptance", "scenario": "small-only"})
                    )
                    outside = outer / ("outside-" + relative.replace("/", "-"))
                    outside.mkdir()
                    target = host / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.symlink_to(outside, target_is_directory=True)
                    with self.assertRaises(ValueError):
                        authorize_paths(
                            root, host, root / "baseline.json", root / "out.json", "small-only"
                        )
                    self.assertEqual(list(outside.iterdir()), [])

    def test_marker_verification_never_repairs_data(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            data = Path(directory)
            with self.assertRaises(FileNotFoundError):
                ensure_marker(data, seed=False)
            self.assertFalse((data / "synthetic-device-marker.txt").exists())
            ensure_marker(data, seed=True)
            self.assertEqual(ensure_marker(data, seed=False), MARKER)
            (data / "synthetic-device-marker.txt").write_text("corrupt")
            with self.assertRaises(ValueError):
                ensure_marker(data, seed=False)
            self.assertEqual((data / "synthetic-device-marker.txt").read_text(), "corrupt")

    def test_type_and_full_record_changes_are_rejected(self):
        before = {"flag": False, "personas": [{"prompt": "synthetic prompt"}], "id": "one"}
        for after in [
            dict(before, flag=0),
            dict(before, personas=[{"prompt": "lost"}]),
            dict(before, id="two"),
        ]:
            with self.assertRaises(ValueError):
                assert_same(before, after)

    def test_credentials_are_digest_only_and_changes_remain_visible(self):
        before = protect(
            {"ws_reverse_token": "SYNTHETIC_ONE", "nested": {"secret": "SYNTHETIC_TWO"}}
        )
        after = protect(
            {"ws_reverse_token": "SYNTHETIC_CHANGED", "nested": {"secret": "SYNTHETIC_TWO"}}
        )
        self.assertNotIn("SYNTHETIC_", json.dumps(before))
        with self.assertRaises(ValueError):
            assert_same(before, after)

    def test_missing_index_fails_without_recreating_it(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            host = Path(directory)
            with self.assertRaises(FileNotFoundError):
                require_existing_storage(host)
            self.assertEqual(list(host.iterdir()), [])

    def test_vector_index_must_cover_all_documents(self):
        good = {"dimension": 8, "count": 2, "ids": [1, 2]}
        docs = [{"id": 1, "doc_id": "one"}, {"id": 2, "doc_id": "two"}]
        validate_index(good, docs, ["one", "two"])
        for broken in [dict(good, count=0), dict(good, dimension=9), dict(good, ids=[1, 3])]:
            with self.assertRaises(ValueError):
                validate_index(broken, docs, ["one", "two"])
        with self.assertRaises(ValueError):
            validate_index(good, docs, ["one"])

    def test_empty_seed_cannot_become_a_passing_baseline(self):
        with self.assertRaises(ValueError):
            validate_records({"personas": [], "conversations": [], "documents": []})

    def test_paths_need_an_explicit_synthetic_owned_root(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd(), prefix="a12-sdk-test-") as directory:
            root = Path(directory).resolve()
            host = root / "profile/runtime/astrbot"
            host.mkdir(parents=True)
            baseline, output = root / "baseline.json", root / "out.json"
            with self.assertRaises(ValueError):
                authorize_paths(root, host, baseline, output, "small-only")
            (root / "synthetic-root.json").write_text(
                json.dumps({"kind": "DSWhaleSyntheticAcceptance", "scenario": "small-only"})
            )
            authorize_paths(root, host, baseline, output, "small-only")
            with self.assertRaises(ValueError):
                authorize_paths(root, root.parent, baseline, output, "small-only")
            with self.assertRaises(ValueError):
                authorize_paths(root, host, root.parent / "escaped.json", output, "small-only")


if __name__ == "__main__":
    unittest.main()
