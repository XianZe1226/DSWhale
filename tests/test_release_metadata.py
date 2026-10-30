import gzip
import io
import tarfile


def test_source_tar_removes_operator_metadata_without_changing_contents(tmp_path):
    from scripts.normalize_release import normalize_tar

    archive = tmp_path / "source.tar.gz"
    with tarfile.open(archive, "w:gz") as bundle:
        item = tarfile.TarInfo("project/main.py")
        item.uid, item.gid = 501, 20
        item.uname, item.gname = "private-operator", "private-group"
        item.pax_headers = {"atime": "1234.5", "ctime": "5678.5"}
        item.size = len(b"public source")
        bundle.addfile(item, io.BytesIO(b"public source"))
    normalize_tar(archive)
    with tarfile.open(archive) as bundle:
        item = bundle.getmembers()[0]
        assert (item.uid, item.gid, item.uname, item.gname) == (0, 0, "root", "root")
        assert item.pax_headers == {}
        assert bundle.extractfile(item).read() == b"public source"
    assert not archive.read_bytes()[3] & 8  # Gzip FNAME must not expose build paths.
    with gzip.open(archive) as decoded:
        assert b"private-operator" not in decoded.read()


def test_default_sdist_command_applies_metadata_normalization(tmp_path, monkeypatch):
    import runpy
    from pathlib import Path

    import setuptools
    from setuptools.command.sdist import sdist

    archive = tmp_path / "source.tar.gz"
    with tarfile.open(archive, "w:gz") as bundle:
        item = tarfile.TarInfo("project/main.py")
        item.uid, item.gid, item.uname, item.gname = 501, 20, "private-operator", "private-group"
        item.size = 1
        bundle.addfile(item, io.BytesIO(b"x"))
    captured = {}
    monkeypatch.setattr(setuptools, "setup", lambda **kwargs: captured.update(kwargs))
    monkeypatch.setattr(
        sdist, "make_distribution", lambda self: setattr(self, "archive_files", [str(archive)])
    )
    runpy.run_path(str(Path(__file__).resolve().parents[1] / "setup.py"))
    command = captured["cmdclass"]["sdist"](setuptools.Distribution())
    command.make_distribution()
    with tarfile.open(archive) as bundle:
        assert all(m.uid == m.gid == 0 and m.uname == m.gname == "root" for m in bundle)
