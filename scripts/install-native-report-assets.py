"""Install the fixed report worker's binary-only subset of the release asset lock."""

import re
import subprocess
import sys
import tempfile
from pathlib import Path


def install(destination):
    packages = {"reportlab", "python-docx", "openpyxl", "pillow", "charset-normalizer", "lxml", "typing-extensions", "et-xmlfile"}
    source = (Path(__file__).parent / "hermes-assets" / "requirements.txt").read_text()
    pinned = {}
    for name, entry in re.findall(r"^([\w.-]+)(==[^\n]+(?:\n[ \t]+--hash=sha256:[0-9a-f]+[^\n]*)*)", source, re.M):
        if name in packages:
            if name in pinned or "--hash=sha256:" not in entry:
                raise ValueError(f"Invalid asset dependency lock for {name}")
            pinned[name] = name + entry
    if pinned.keys() != packages:
        raise ValueError("Incomplete fixed report dependency lock.")
    with tempfile.NamedTemporaryFile("w", suffix=".txt") as lock:
        lock.write("\n".join(pinned.values()) + "\n")
        lock.flush()
        subprocess.run(
            [sys.executable, "-Im", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-input",
             "--no-cache-dir", "--no-compile", "--require-hashes", "--only-binary=:all:", "--ignore-installed",
             "--target", str(destination), "-r", lock.name],
            check=True,
        )


if __name__ == "__main__":
    install(Path(sys.argv[1]))
