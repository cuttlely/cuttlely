# Docs screenshots

One command retakes the pictures for server settings, sign-in, roles, a first run from source, and the import pages.

```bash
pnpm build
node scripts/docs-shots/capture.mjs
```

The script starts its own servers on empty data directories, in a headless browser at a fixed size, in the light theme. It signs in with a local owner account it creates itself. It does not sign in to any outside service. It does not read a model key. The AuthKit frames type an obviously fake key into a masked field and never print it.

Sample files for the import frames are `examples/imports/bakery-helper.json` and `examples/imports/bakery-greeter.json`.

This directory is listed in `.dockerignore`. It is not part of the runtime image, and it is not in any published npm package.
