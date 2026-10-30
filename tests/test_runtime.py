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


def test_launch_environment_only_reads_known_tools_and_exposes_runtime(tmp_path, monkeypatch):
    import json
    import os

    from dswhale.runtime import launch_environment

    node = str(tmp_path / "tools" / "node")
    media = tmp_path / "media"
    token = str(tmp_path / "token" / "SECRET")
    (tmp_path / "tool-env.json").write_text(
        json.dumps(
            {
                "node": node,
                "ffmpeg": str(media / "ffmpeg"),
                "ffprobe": str(media / "ffprobe"),
                "secret": token,
            }
        )
    )
    env = launch_environment(tmp_path)
    assert env.get("DSWHALE_RUNTIME_DIR") == str(tmp_path.resolve())
    assert env["ASTRBOT_ROOT"] == str(tmp_path.resolve() / "astrbot")
    assert env["DSWHALE_NODE"] == node
    assert env["PATH"].split(os.pathsep).count(str(media)) == 1
    assert str(tmp_path / "token") not in env["PATH"]


def test_node_rejects_prereleases_and_repairs_corrupt_private_copy(tmp_path, monkeypatch):
    import hashlib
    import io
    import os
    import tarfile

    from dswhale import runtime

    if os.name == "nt":
        pytest.skip("POSIX fixture executable")
    target = tmp_path / "tools" / f"node-v{runtime.NODE_VERSION}"
    (target / "bin").mkdir(parents=True)
    (target / "bin/node").write_bytes(b"broken")
    (target / "lib/node_modules/npm/bin").mkdir(parents=True)
    (target / "lib/node_modules/npm/bin/npm-cli.js").touch()
    candidate = tmp_path / "node"
    candidate.write_text('#!/bin/sh\nprintf "v22.1.0-rc1\\n"\n')
    candidate.chmod(0o755)
    monkeypatch.setattr(
        runtime, "npm_cli", lambda node: target / "lib/node_modules/npm/bin/npm-cli.js"
    )
    assert not runtime.usable_node(candidate)
    content = io.BytesIO()
    with tarfile.open(fileobj=content, mode="w:gz") as archive:
        node = b'#!/bin/sh\nprintf "v22.23.4\\n"\n'
        info = tarfile.TarInfo("node-test/bin/node")
        info.mode = 0o755
        info.size = len(node)
        archive.addfile(info, io.BytesIO(node))
        info = tarfile.TarInfo("node-test/lib/node_modules/npm/bin/npm-cli.js")
        info.size = 0
        archive.addfile(info, io.BytesIO())
    binary = content.getvalue()
    asset = runtime.select_node_asset()
    monkeypatch.setitem(
        runtime.NODE_HASHES,
        asset.removeprefix(f"node-v{runtime.NODE_VERSION}-"),
        hashlib.sha256(binary).hexdigest(),
    )

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def raise_for_status(self):
            pass

        def iter_bytes(self):
            yield binary

    monkeypatch.setattr(runtime.httpx, "stream", lambda *args, **kwargs: Response())
    result = runtime.ensure_node(tmp_path, reuse=False)
    assert result == target / "bin/node"
    assert runtime.usable_node(result)
    assert runtime.ensure_node(tmp_path, reuse=False) == result


@pytest.mark.parametrize(
    "version, expected",
    [
        ("v22.0.0", False),
        ("v22.23.3", False),
        ("v22.23.4", True),
        ("v22.23.5", True),
        ("v22.24.0", True),
        ("v24.0.0", False),
    ],
)
def test_node_reuse_requires_current_supported_patch(tmp_path, monkeypatch, version, expected):
    from dswhale import runtime

    node = tmp_path / "bin/node"
    npm = tmp_path / "lib/node_modules/npm/bin/npm-cli.js"
    npm.parent.mkdir(parents=True)
    npm.touch()
    monkeypatch.setattr(runtime.subprocess, "check_output", lambda *args, **kwargs: version)
    assert runtime.usable_node(node) is expected


def test_python_launcher_keeps_private_tools_first_and_finds_gui_macos_tools(tmp_path, monkeypatch):
    import json
    import os

    from dswhale import runtime

    monkeypatch.setattr(runtime.platform, "system", lambda: "Darwin")
    monkeypatch.setenv("PATH", "")
    managed = str(tmp_path / "managed-tools")
    (tmp_path / "tool-env.json").write_text(json.dumps({"node": managed + "/node"}))
    directories = runtime.launch_environment(tmp_path)["PATH"].split(os.pathsep)
    assert directories[0] == managed
    assert "/opt/homebrew/bin" in directories
    assert "/usr/local/bin" in directories
    assert "" not in directories
    monkeypatch.setenv("PATH", os.pathsep.join(directories))
    repeated = runtime.launch_environment(tmp_path)["PATH"].split(os.pathsep)
    assert len(repeated) == len(set(repeated))
