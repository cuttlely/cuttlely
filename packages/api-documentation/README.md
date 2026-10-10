# Cuttlely API docs

English | [中文](./README-ZH.md)

HTTP API docs for Cuttlely, including `POST /api/v1/prediction/:id`.

A harness prediction returns `text`, `harness`, `agents`, `sources`, and `artifacts`.

## Run

From the repository root, start Cuttlely, then this package:

```bash
bash scripts/start-cuttlely.sh
```

```bash
cd packages/api-documentation
pnpm start
```

In dev mode, from the repository root:

```bash
pnpm dev
```

Docs are served at `http://localhost:6655/api-docs`.

## License

Apache License 2.0. Copyright and license notices are in [LICENSE.md](../../LICENSE.md).
