# Version files

The history repo is a plain Git repo. Each version is one commit. Each flow is one folder of small text files, written the same way every time, so a one-word prompt edit is a one-line diff. Where the repo is: [History settings](./versioning-settings.md). A [copy in GitHub](../how-to/versioning.md#keep-a-copy-in-github) has the same files. How to use history: [Version history](../how-to/versioning.md).

Do not edit the repo while Cuttlely is running. Cuttlely writes it and reads it back.

## Repo layout

```text
versions/
  README.md
  flows/
    bakery-helper--1f2e3d4c/
      flow.json
      edges.json
      layout.json
      nodes/
        chatOpenAI_0.json
        chatOpenAI_0.definition.json
        conversationChain_0.json
        conversationChain_0.definition.json
      prompts/
        conversationChain_0.systemMessagePrompt.md
```

The branch is `main`. Cuttlely adds no remote.

A flow's folder is named `<slug>--<first 8 characters of the flow id, without dashes>`. The slug is the flow's name in lowercase, with each run of other characters replaced by `-`, up to 40 characters, or `flow` when nothing is left. If another flow already has that folder, the folder uses the whole flow id. Cuttlely finds a flow's folder by the `id` in its `flow.json`, so renaming a flow renames its folder and keeps its history.

## Files

All JSON is written with sorted keys, a two-space indent, and a final newline.

| File                              | Contents                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flow.json`                       | `formatVersion` (`1`), the flow's `id`, `name`, `type`, and `category`, the node list in canvas order (`id` and `file`), the `credentials` it names, the chat `models` it uses (`node`, `component`, `model`), `hidden` when secret-looking text was hidden ([Markers](#markers)), and `extra` for any other top-level keys of the flow. |
| `nodes/<node id>.json`            | One node without its position, size, or selection state. Its `data` keeps only `id`, `name`, `label`, `version`, `type`, `category`, `inputs`, `outputs`, and `credential`.                                                                                                                                                              |
| `nodes/<node id>.definition.json` | The rest of the node's `data`: the input and output definitions the canvas draws from. Written when there is any.                                                                                                                                                                                                                        |
| `prompts/<node id>.<input>.md`    | A multi-line text input, such as a prompt or instructions, as plain text.                                                                                                                                                                                                                                                                |
| `edges.json`                      | The connections, sorted by `id`.                                                                                                                                                                                                                                                                                                         |
| `layout.json`                     | Each node's `position`, `positionAbsolute`, `width`, and `height`, and the canvas `viewport`.                                                                                                                                                                                                                                            |

Selection and drag state is not written.

## Markers

Some values in a node file are written as a one-key object:

| Marker                                                                        | Meaning                                                                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `{ "$text": "prompts/<node id>.<input>.md" }`                                 | The text is in that file.                                                                                                            |
| `{ "$credential": { "name": "OpenAI main", "credentialName": "openAIApi" } }` | A credential, by its name and type. `{ "$credential": null }` is a credential Cuttlely could not name, such as one that was deleted. |
| `{ "$secret": true }`                                                         | A value that looked secret and was not written. It comes back from the flow as it is now.                                            |
| `{ "$json": … }`                                                              | JSON text that held a credential or a secret. The text is written as JSON with those values marked.                                  |
| `{ "$literal": … }`                                                           | A value of your own that looked like one of these markers, kept as it was.                                                           |

Inputs that are never written at all: password, file, and folder fields, and known fields that hold a path on the server's disk. On read, each of those comes back from the node with the same id in the flow as it is now. What counts as secret is in [What is stored, and what is not](../how-to/versioning.md#what-is-stored-and-what-is-not).

Text in `prompts/` and other text values are written as typed, except secret-looking values, which are replaced with `[secret hidden]`. What counts is in [Keys typed into text fields](../how-to/versioning.md#keys-typed-into-text-fields). On read and restore the placeholder stays. A value that already holds the placeholder, such as a restored version that still has one, counts as hidden again.

When anything was hidden, `flow.json` has a `hidden` list, one entry per input:

```json
"hidden": [
  {
    "count": 1,
    "input": "systemMessagePrompt",
    "inputLabel": "System Message",
    "label": "Conversation Chain",
    "node": "conversationChain_0"
  }
]
```

`count` is how many values were hidden in that input. A `flow.json` without `hidden` has nothing hidden.

Before each commit, Cuttlely also scans the files for key-shaped text: `sk-` and `xai-` keys, GitHub tokens, AWS access key ids, Postgres URLs with a password, and private keys. This catches text that is not an input, such as the flow's name. A hit stops that commit. The message names the file and the pattern, never the text.

## Commits

```text
Changed System Message on Conversation Chain

Version-Flow: 4b6f0c2e-…
Version-Kind: save
Version-Name: Bakery helper
```

-   The subject is the version name, at most 72 characters.
-   The body has more lines about the change when there are any.
-   The trailers are `Version-Flow` (the flow id), `Version-Kind` (`create`, `save`, `restore`, `publish`, `rollback`, `promote`, or `delete`), and `Version-Name` (the flow's name). A `promote` version also has `Version-From`, the full id of the previous environment's version. On the saved Dev and Prod pair that version is Dev's. `Version-Hidden` is how many secret-looking values the version holds as `[secret hidden]`, written only when there are any; the body then says so, for example `1 secret-looking value was hidden from history`.
-   The author is the person who saved it: their display name and `<user id>@users.versions.local`. An API key or system save is `Cuttlely <system@versions.local>`.
-   The committer is always `Cuttlely <system@versions.local>`.

A delete commit removes the flow's folder. Earlier commits still have it.

Cuttlely runs the system `git` with its own settings. It does not read your global or system Git config, signs nothing, and skips hooks.

## Format version

`flow.json` carries `formatVersion`. This Cuttlely writes and reads version `1`. A file with another version is not read: `flow.json has format version <n>. This Cuttlely reads version 1.`
