# Image and file libraries in the agent runtime

The agent runtime's Python (`hermes/.venv`) has libraries for charts, diagrams and office files, so a specialist that runs Python can make a PNG chart, a PDF report, a Word document, a spreadsheet or a slide deck.

## What is installed

`scripts/setup-hermes.sh` installs `scripts/hermes-assets/requirements.txt` after the runtime's own locked packages. That file pins every package and its dependencies with hashes. Packages the runtime also uses, such as Pillow, keep the version in `hermes/uv.lock`. The pins are for Python 3.14, the runtime's locked version; with another Python the script skips them and says so. Set `CUTTLELY_HERMES_ASSETS=0` when you run the script to leave them out.

| Package     | Version | Use                                         | License                        |
| ----------- | ------- | ------------------------------------------- | ------------------------------ |
| matplotlib  | 3.11.2  | Charts as PNG, SVG or PDF                   | Matplotlib License (PSF-based) |
| seaborn     | 0.13.2  | Statistical chart themes on matplotlib      | BSD-3-Clause                   |
| plotly      | 7.1.0   | Interactive charts                          | MIT                            |
| kaleido     | 1.5.0   | Plotly static export (PNG) through Chromium | MIT                            |
| numpy       | 2.5.4   | Arrays                                      | BSD-3-Clause                   |
| pandas      | 3.0.6   | Tables and CSV                              | BSD-3-Clause                   |
| networkx    | 3.7     | Graphs                                      | BSD-3-Clause                   |
| graphviz    | 0.20.3  | Python interface to Graphviz `dot`          | MIT                            |
| diagrams    | 0.25.1  | Architecture diagrams (uses Graphviz)       | MIT                            |
| reportlab   | 5.0.1   | PDF                                         | BSD-3-Clause                   |
| python-docx | 1.2.0   | Word (.docx)                                | MIT                            |
| openpyxl    | 3.1.5   | Excel (.xlsx) read and write                | MIT                            |
| xlsxwriter  | 3.2.9   | Excel (.xlsx) with charts                   | BSD-2-Clause                   |
| python-pptx | 1.0.2   | PowerPoint (.pptx)                          | MIT                            |

Their dependencies are MIT, BSD, PSF-2.0, Apache-2.0 or MIT-CMU licensed (simplejson is MIT or AFL-2.1).

The Docker image also installs these Debian packages in the runtime stage:

| Package           | Use                                          | License                          |
| ----------------- | -------------------------------------------- | -------------------------------- |
| graphviz          | The `dot` program, run as a separate process | EPL-1.0                          |
| fontconfig        | Font lookup                                  | MIT-style                        |
| fonts-inter       | Inter                                        | SIL OFL 1.1                      |
| fonts-noto-core   | Noto Sans and Noto Serif                     | SIL OFL 1.1                      |
| fonts-dejavu-core | DejaVu                                       | Bitstream Vera and public domain |

Plotly static export drives the image's Chromium through `BROWSER_PATH` (`/usr/local/bin/cuttlely-chromium`). An image built with `INCLUDE_BROWSER=0` has no Chromium, so only that export fails. Matplotlib PNG output does not need it.

## Left out

| Package    | Why                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| cairosvg   | LGPL-3.0, not Apache-2.0 compatible. Use matplotlib or Graphviz to write PNG directly.                      |
| weasyprint | BSD-3-Clause, but it needs Pango and its libraries in the runtime image. reportlab covers PDF without them. |

## Check an image

```bash
docker run --rm --entrypoint bash -e HERMES_ASSETS_REQUIRE_SYSTEM=1 cuttlely \
    -c 'hermes/.venv/bin/python scripts/hermes-assets/smoke.py /tmp/hermes-assets-smoke'
```

The smoke test imports every library and renders a PNG, a PDF, a DOCX, two XLSX files and a PPTX from made-up data, then checks each file's signature. With `HERMES_ASSETS_REQUIRE_SYSTEM=1` it also fails when `dot`, `fc-list` or one of the Inter, Noto Sans and DejaVu Sans fonts is missing, and when Plotly cannot find Chromium in an image not built with `INCLUDE_BROWSER=0`. The Docker build workflow runs it on every image it builds.

## Change a pin

Edit `scripts/hermes-assets/requirements.in`, then run `bash scripts/setup-hermes.sh --compile-assets` (needs `uv`). It recompiles `requirements.txt` against `hermes/uv.lock`, with the uv settings in `hermes/pyproject.toml` (such as its 14-day `exclude-newer` window), so a release newer than that window cannot be pinned yet, except for the packages `hermes/pyproject.toml` exempts under `exclude-newer-package` (such as NumPy, Pillow and packaging). Check the license of every new package before you add it.
