# @cuttlely/chat

The chat that visitors see when you share a Cuttlely chat link or embed a chat on a website. It is one small script with no dependencies, served by your own Cuttlely server, so it always matches the server's version and never loads code from a third-party CDN.

-   Two modes: a floating chat bubble, or a full-page chat.
-   Renders inside a shadow root, so the host page's CSS can't break it and its CSS can't leak out.
-   Light and dark (follows the visitor's system by default), mobile friendly, keyboard and screen-reader accessible.
-   Streams answers with a typing state, renders markdown (code blocks with copy, tables, images), source chips, charts, harness run cards, starter and follow-up prompts, image upload when the flow allows it, and thumbs feedback when it is on.

Size: `dist/chat.js` is about 60 KB minified, about 20 KB gzipped. `pnpm build` prints the exact numbers and writes them to `dist/size.json`.

## Embed it

Your Cuttlely server serves the script at `/embed/chat.js`. The script finds the server from its own address.

A chat bubble in the corner of any page:

```html
<script src="https://your-cuttlely.example/embed/chat.js" data-flow-id="FLOW_ID" defer></script>
```

A full-page chat where the tag is:

```html
<cuttlely-chat flow-id="FLOW_ID" mode="page" style="display:block;height:100vh"></cuttlely-chat>
<script src="https://your-cuttlely.example/embed/chat.js" defer></script>
```

| Attribute                    | Values                       | Default                 |
| ---------------------------- | ---------------------------- | ----------------------- |
| `flow-id` / `data-flow-id`   | the chatflow or agentflow id | required                |
| `mode` / `data-mode`         | `bubble`, `page`             | `bubble`                |
| `theme` / `data-theme`       | `auto`, `light`, `dark`      | `auto`                  |
| `api-host` / `data-api-host` | a Cuttlely server URL        | the script's own server |
| `open` / `data-open="true"`  | start with the bubble open   | closed                  |

From a script, `window.cuttlelyChat.mount(element, { flowId, mode, theme })` renders a chat into any element and returns a controller with `open()`, `close()`, `reset()` and `destroy()`.

The Cuttlely app itself imports the ES module build (`@cuttlely/chat`, `mount`) for the `/chatbot/:id` share page.

## Look and settings

The widget uses Cuttlely's type and colors: the Inter stack, Cuttlely violet with a blue highlight, and the C-wave mark as the default avatar. The flow's share settings still apply: title, avatar, welcome message, starter prompts, feedback, placeholder, font size, and the header, message, input and send-button colors. A saved color that equals the old stock default counts as unset, so those chats get the Cuttlely look instead.

## Security

-   Model output is never inserted as HTML. `src/markdown.js` escapes every character of text and writes only its own small set of tags; raw HTML in an answer shows as text. Links and images keep only `http`, `https`, `mailto` (links), paths on the Cuttlely server, and base64 PNG, JPEG, GIF or WebP images.
-   `src/scrub.js` then walks the parsed result and removes any tag or attribute the renderer would never write, as a second line of defense.
-   HTML artifacts render in an `iframe` with an empty `sandbox`: no scripts, no forms, no same-origin access.
-   Colors from share settings must be plain hex, `rgb()` or `hsl()` values before they reach a style.
-   Access rules are the server's, unchanged: a flow with an API key answers 401 and the widget shows "This chat is private or needs a key"; a site outside the flow's allowed origins gets 403 and "This chat is not available on this site". The widget never asks for or stores an API key.
-   The session is the server-issued chat id and session token. The widget keeps them, with the visible conversation, in the visitor's `localStorage` for this flow; "New chat" clears them. A flow set to start a new session each visit keeps nothing.

## Accessibility

-   The launcher is a labeled button with `aria-expanded`; the panel is a labeled dialog that closes on Escape and returns focus.
-   The message box has a label; Enter sends, Shift+Enter adds a line.
-   A polite status region announces "Answering", then the start of the answer, errors and copy or feedback results, without reading every streamed token.
-   Every text and background pair in both themes meets WCAG AA (4.5:1). `test/contrast.test.js` checks the theme colors.
-   Reduced-motion users get no animations.

## Server API used

Everything the widget does comes from reading Cuttlely's own server code:

| Need         | Endpoint and behavior                                                                                                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings     | `GET /api/v1/public-chatbotConfig/:id` returns the saved share settings plus `uploads` (allowed origins removed), or `"OK"` when nothing is saved.                                                                                                                                                       |
| Send         | `POST /api/v1/prediction/:id` with `question`, `chatId`, `sessionToken`, `uploads` (image data URLs), `humanInput` and `streaming: true`. Image uploads use the `uploads` list; full files go as multipart `files`.                                                                                      |
| Stream       | `text/event-stream`; each frame's `data:` line is `{ event, data }`. Used: `start`, `token`, `sourceDocuments`, `artifacts`, `action`, `metadata` (chat id, message id, session token, follow-up prompts), `error` (with `status`), `end`, and `harness.*` (route, specialist, handoff, partial, final). |
| Plain answer | A flow that can't stream answers with JSON: `text` or `json`, `chatId`, `sessionToken`, `chatMessageId`, `sourceDocuments`, `artifacts`, `followUpPrompts`.                                                                                                                                              |
| Charts       | Image artifacts are files saved for the chat: `GET /api/v1/get-upload-file?chatflowId&chatId&fileName`, read with the session cookie or the `x-cuttlely-session-token` header.                                                                                                                           |
| Feedback     | `POST /api/v1/feedback/:id` with `chatflowid`, `chatId`, `messageId` and `rating` (`THUMBS_UP` or `THUMBS_DOWN`), shown only when the flow's feedback setting is on.                                                                                                                                     |

## Develop

```bash
pnpm --dir packages/chat-widget build   # dist/chat.js and dist/index.mjs
pnpm --dir packages/chat-widget test    # node --test with jsdom
```

`pnpm verify` runs the tests (step `chat-widget`) and the build.
