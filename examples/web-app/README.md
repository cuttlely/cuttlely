# Bakery helper: a web app on the Cuttlely API

A plain HTML and JavaScript page, and a small Node server with no dependencies. The page asks the server; the server adds the Cuttlely API key, asks the flow with streaming on, and passes the answer through as it arrives. The key and Cuttlely's session token stay on the server.

```bash
CUTTLELY_URL=http://localhost:3000 CUTTLELY_FLOW_ID=<flow id> CUTTLELY_API_KEY=<key> node server.mjs
```

Then open http://localhost:8080 (set `PORT` to change it). Node 18 or newer.

-   `server.mjs`: serves the page and `POST /api/ask`.
-   `public/index.html`, `public/app.js`: the page, which reads the streamed answer with `fetch`.
-   `server.test.mjs`: tests against a stub Cuttlely server, no model key needed: `node --test server.test.mjs`.

The walkthrough, with the API calls behind it, is in [Use the Cuttlely API in your own web app](../../docs/api.md).
