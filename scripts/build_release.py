"""Build the AstrBot plugin ZIP; python -m build produces wheel and full source archive."""

import hashlib
import json
import stat
import tarfile
import tempfile
import zipfile
from pathlib import Path

from dswhale import __version__
from dswhale.install import install_plugin
from scripts.normalize_release import normalize_tar, release_epoch

root = Path(__file__).resolve().parents[1]
dist = root / "dist"
dist.mkdir(exist_ok=True)
output = dist / f"astrbot_plugin_dswhale-{__version__}.zip"
with tempfile.TemporaryDirectory() as directory:
    plugin = install_plugin(Path(directory))
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(plugin.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(plugin.parent).as_posix())
# A full source ZIP is easier to unpack in Windows Explorer than the sdist tarball.
source_tar = dist / f"dswhale-{__version__}.tar.gz"
if source_tar.is_file():
    normalize_tar(source_tar, epoch=release_epoch(root))
    with (
        tarfile.open(source_tar) as source,
        zipfile.ZipFile(
            dist / f"DSWhale-{__version__}-source.zip", "w", zipfile.ZIP_DEFLATED
        ) as archive,
    ):
        for entry in source.getmembers():
            if entry.isfile():
                with source.extractfile(entry) as stream:
                    info = zipfile.ZipInfo(entry.name)
                    info.create_system = 3
                    info.external_attr = (stat.S_IFREG | entry.mode) << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, stream.read())
checksums = {}
for path in sorted(dist.iterdir()):
    if path.suffix in {".zip", ".whl", ".gz"}:
        with path.open("rb") as stream:
            checksums[path.name] = hashlib.file_digest(stream, "sha256").hexdigest()
(dist / "SHA256SUMS.json").write_text(json.dumps(checksums, indent=2) + "\n")
print(output)
