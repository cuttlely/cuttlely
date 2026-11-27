"""Provision the fixed document decoder during image build. Runtime tools install nothing."""

import hashlib
import io
import platform
import sys
import urllib.request
import zipfile
from pathlib import Path

WHEELS = {
    "x86_64": (
        "https://files.pythonhosted.org/packages/fc/16/feeca9705bfdb237f1cb69ede0b373b144c0d51df4297e595a74b815557e/firecrawl_anydoc-0.2.4-cp310-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
        "0e5aed01bf6d4e5c588d3363888293f2ceeb9feb00449a32e0ba993797cf0bd3",
    ),
    "aarch64": (
        "https://files.pythonhosted.org/packages/77/b5/5784fc514f58ca19328faee701d2cc2e25961389c2d4908b2a51a1071ee4/firecrawl_anydoc-0.2.4-cp310-abi3-manylinux_2_17_aarch64.manylinux2014_aarch64.whl",
        "17720ba093820654162891d7995fd2dbae948b16fe1c174ba799bddfc0b92ad6",
    ),
}


def install(destination):
    url, digest = WHEELS[platform.machine()]
    with urllib.request.urlopen(url, timeout=60) as response:
        payload = response.read(32 * 1024**2)
    if hashlib.sha256(payload).hexdigest() != digest:
        raise ValueError("Native document decoder checksum mismatch")
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        for name in archive.namelist():
            if name.startswith("anydoc/") and not name.endswith("/"):
                relative = Path(name)
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("Unexpected wheel path")
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))
            elif ".dist-info/licenses/" in name and not name.endswith("/"):
                target = destination / "licenses" / Path(name).name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))


if __name__ == "__main__":
    install(Path(sys.argv[1]))
