"""Older name for the assets style kit. `import asset_kit` and `from asset_kit import use_dir` keep working.

New code imports cuttlely_assets. The harness copies this file next to cuttlely_assets.py and cuttlely_fetch.py.
"""

from cuttlely_assets import *  # noqa: F401,F403
from cuttlely_assets import FetchError, fetch, fetch_asset, use_dir  # noqa: F401
