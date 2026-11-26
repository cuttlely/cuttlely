"""Record the exact files a clean gateway seeds, using the installed runtime's sync."""
import hashlib
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

root = Path(__file__).resolve().parents[1]
runtime = root / "hermes"
catalog = root / "packages/etl/bundled-skill-files.generated.json"
with TemporaryDirectory() as temp:
    home = Path(temp) / "runtime"
    os.environ.update(HOME=temp, HERMES_HOME=str(home), HERMES_BUNDLED_SKILLS=str(runtime / "skills"),
                      HERMES_OPTIONAL_SKILLS=str(runtime / "optional-skills"))
    sys.path.insert(0, str(runtime))
    from tools.skills_sync import sync_skills

    if not sync_skills(quiet=True)["total_bundled"]:
        raise RuntimeError("The installed runtime could not seed its bundled skills")
    entries = {}
    for file in sorted((home / "skills").rglob("*")):
        if file.is_file() and not file.is_symlink() and file.name != ".bundled_manifest":
            data = file.read_bytes()
            entries[file.relative_to(home).as_posix()] = [len(data), hashlib.sha256(data).hexdigest()]
    catalog.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")
