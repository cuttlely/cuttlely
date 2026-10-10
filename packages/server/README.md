# Cuttlely server

English | [中文](./README-ZH.md)

Node server for Cuttlely. It serves chat flows, harnesses, and `POST /api/v1/prediction/:id`.

Start Cuttlely and Hermes together from the repository root:

```bash
bash scripts/start-cuttlely.sh
```

Open [http://localhost:43117](http://localhost:43117). The start script sets `PORT=43117` unless `PORT` is already set; started on its own, the server defaults to `3000`.

Environment variables are documented in [CONTRIBUTING.md](../../CONTRIBUTING.md). The package binary is still named `flowise`.

## Tests

```bash
cd packages/server
pnpm test
```

## License

Apache License 2.0. The commercial enterprise tree is not in this package. See [LICENSE.md](../../LICENSE.md).
