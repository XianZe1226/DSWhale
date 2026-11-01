"""Independent component installation validates archives without executing them."""

import hashlib
import importlib.util
import stat
import zipfile

import pytest


def fixture_zip(tmp_path, extra=None):
    archive = tmp_path / "component.zip"
    files = {"index.js": b"synthetic official entry", "napcat/napcat.mjs": b"synthetic module"}
    with zipfile.ZipFile(archive, "w") as output:
        for name, data in files.items():
            output.writestr(name, data)
        if extra:
            output.writestr(*extra)
    metadata = {
        "version": "4.18.42",
        "asset": {"sha256": hashlib.sha256(archive.read_bytes()).hexdigest()},
        "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
    }
    return archive, metadata


def installer():
    assert importlib.util.find_spec("dswhale.napcat_install") is not None
    from dswhale.napcat_install import install_archive

    return install_archive


def test_archive_is_verified_and_installed_without_running_any_component(tmp_path):
    archive, metadata = fixture_zip(tmp_path)
    root = tmp_path / "private/napcat"
    destination = installer()(archive, root, metadata)
    assert destination == root / "package-4.18.42"
    assert (destination / "index.js").read_bytes() == b"synthetic official entry"
    with pytest.raises(ValueError, match="存在|already"):
        installer()(archive, root, metadata)


@pytest.mark.parametrize(
    "attack", ["traversal", "symlink", "extra-code", "file-hash", "archive-hash"]
)
def test_unsafe_or_tampered_archives_never_replace_private_or_external_files(tmp_path, attack):
    extra = None
    if attack == "traversal":
        extra = ("../external.txt", b"changed")
    elif attack == "symlink":
        link = zipfile.ZipInfo("napcat/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        extra = (link, b"/external")
    elif attack == "extra-code":
        extra = ("evil.js", b"untrusted code")
    archive, metadata = fixture_zip(tmp_path, extra)
    if attack == "file-hash":
        metadata["files"]["index.js"] = "0" * 64
    if attack == "archive-hash":
        metadata["asset"]["sha256"] = "0" * 64
    external = tmp_path / "external.txt"
    external.write_text("unchanged")
    root = tmp_path / "private/napcat"
    with pytest.raises(ValueError):
        installer()(archive, root, metadata)
    assert external.read_text() == "unchanged"
    assert not (root / "package-4.18.42").exists()


def test_installation_refuses_symlink_private_root(tmp_path):
    archive, metadata = fixture_zip(tmp_path)
    foreign = tmp_path / "official-QQ"
    foreign.mkdir()
    root = tmp_path / "private-root"
    root.symlink_to(foreign, target_is_directory=True)
    with pytest.raises(ValueError):
        installer()(archive, root, metadata)
    assert list(foreign.iterdir()) == []
