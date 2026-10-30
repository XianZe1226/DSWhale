"""Desktop releases must never inherit a developer's local account state."""

import json

import pytest

from scripts.stage_desktop import stage_backend


def put(root, name, content="public source"):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return path


def test_stage_only_curated_sources_even_when_private_files_are_tracked(tmp_path):
    source = tmp_path / "source"
    tracked = {
        "pyproject.toml",
        "README.md",
        "LICENSE",
        "main.py",
        "metadata.yaml",
        "_conf_schema.json",
        "requirements.txt",
        "dswhale/__init__.py",
        "dswhale/bili_bridge/server.mjs",
        "dswhale/bili_bridge/package-lock.json",
        "scripts/bootstrap.py",
        "scripts/launch.py",
        ".private/token.json",
        "dswhale/data/chat.json",
        "dswhale/.env",
        "dswhale/cookies.txt",
        "dswhale/credentials.json",
        "dswhale/desktop-auth.json",
        "dswhale/model.key",
        "dswhale/bili_bridge/node_modules/dep/index.js",
        "dswhale/__pycache__/bad.pyc",
        "dswhale/.git/config",
        "desktop/ui/index.html",
        "tests/test_private.py",
        "dswhale/bili_bridge/user-data/account.json",
        "dswhale/secrets/secret.json",
        "dswhale/logs/output.log",
        "dswhale/runtime/state.json",
    }
    for name in tracked:
        put(source, name)
    put(source, "dswhale/untracked.py", "SECRET")
    put(source, "dswhale/media_assets.json", '{"assets": []}')
    put(source, ".runtime/astrbot/data/config.json", "SECRET")
    output = tmp_path / "resources" / "backend"
    manifest = stage_backend(source, output, tracked_files=tracked)
    expected = {
        name
        for name in tracked
        if name
        in {
            "pyproject.toml",
            "README.md",
            "LICENSE",
            "main.py",
            "metadata.yaml",
            "_conf_schema.json",
            "requirements.txt",
            "dswhale/__init__.py",
            "dswhale/bili_bridge/server.mjs",
            "dswhale/bili_bridge/package-lock.json",
            "scripts/bootstrap.py",
            "scripts/launch.py",
        }
    } | {"dswhale/media_assets.json"}
    assert set(manifest) == expected
    assert {p.relative_to(output).as_posix() for p in output.rglob("*") if p.is_file()} == expected
    assert json.loads((output.parent / "backend-manifest.json").read_text()) == manifest
    assert all(len(item) == 64 for item in manifest.values())


def test_stage_replaces_previous_output_without_retaining_stale_data(tmp_path):
    source = tmp_path / "source"
    put(source, "dswhale/public.py")
    output = tmp_path / "resources" / "backend"
    put(output, "old-private-data.txt", "SECRET")
    stage_backend(source, output, tracked_files={"dswhale/public.py"})
    assert not (output / "old-private-data.txt").exists()


def test_stage_rejects_symlink_source_files_and_directory_escapes(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    private = put(tmp_path, "private/public.py", "SECRET")
    (source / "dswhale").symlink_to(private.parent, target_is_directory=True)
    with pytest.raises(ValueError, match="[Ss]ymlink"):
        stage_backend(source, tmp_path / "resources/backend", tracked_files={"dswhale/public.py"})


def test_stage_rejects_unsafe_destination_and_git_paths(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    with pytest.raises(ValueError):
        stage_backend(source, source, tracked_files=set())
    with pytest.raises(ValueError):
        stage_backend(source, tmp_path / "out", tracked_files={"../dswhale/secret.py"})


def test_stage_cannot_replace_any_source_subdirectory(tmp_path):
    source = tmp_path / "source"
    put(source, "dswhale/public.py")
    with pytest.raises(ValueError, match="source"):
        stage_backend(source, source / "dswhale", tracked_files={"dswhale/public.py"})
    assert (source / "dswhale/public.py").is_file()
