import pytest

from dswhale.runtime import select_node_asset, validate_members


def test_windows10_and_both_mac_architectures_choose_native_runtime():
    assert select_node_asset("Windows", "AMD64").endswith("-win-x64.zip")
    assert select_node_asset("Darwin", "arm64").endswith("-darwin-arm64.tar.gz")
    assert select_node_asset("Darwin", "x86_64").endswith("-darwin-x64.tar.gz")
    with pytest.raises(ValueError):
        select_node_asset("Windows", "arm64")


def test_runtime_archive_must_have_one_safe_top_level():
    assert validate_members(["node-v-test/bin/node", "node-v-test/LICENSE"]) == "node-v-test"
    for names in [["../escape"], ["/etc/passwd"], ["a/file", "b/file"], ["node/../../outside"]]:
        with pytest.raises(ValueError):
            validate_members(names)
