# Product video closing cards: measured latency

-   Run: 10/12/2026, 3:51:29 PM CT (2026-10-12T20:51:29.449Z)
-   Server: a fresh Cuttlely server at commit 7e7fc6ab934ba2fde624481df333a6aa2cf6f26d. The server and the client were on the same machine. The model provider was reached over the public internet.
-   Model: gpt-4.1-mini (OpenAI reported gpt-4.1-mini-2025-04-14), temperature 0.2
-   Method: 3 warm-up rounds, then 20 measured rounds; fresh chat session per round (the follow-up and the order question share the session of the turn before them, as in the videos). Times are seconds from request sent to the first non-blank streamed token (first words) or to the stream closing (full answer), taken in the client.
-   Caveat: Time to first words includes the model provider's own latency (queueing, prompt processing and the network round trip) as well as every model call before the answer starts: the tool agent's calculator call in the chatflow and the Classify Message call in the agentflow.
-   Stats: median = mean of the 10th and 11th of 20; p90 = nearest rank (18th of 20). "Correct" counts runs whose answer passed the content check (right total, right branch, a four-row table). The tiles use the median, rounded to one decimal, and do not round a half down.

Questions: chatflow "Two country sourdough loaves and three butter croissants. What is the total?" then "Add a baguette to that."; agentflow "I received a stale loaf, can I get a replacement?" then "How much are two butter croissants and a baguette?"; shared link "What breads do you have and how much are they?"; embed "Are you open on Sunday? Show the week as a table.".

## Chatflows (canvas test chat, internal prediction stream)

The home page no longer shows this card. The testing card replaced it and does not state these figures.

| Metric                                 | Median s | p90 s | Min s | Max s | Correct  |
| -------------------------------------- | -------- | ----- | ----- | ----- | -------- |
| First question: time to first words    | 1.05     | 1.17  | 0.93  | 1.24  | 20 of 20 |
| First question: full answer            | 1.25     | 1.41  | 1.09  | 1.45  | 20 of 20 |
| Follow-up: full answer                 | 1.28     | 1.42  | 1.14  | 1.51  | 20 of 20 |
| Follow-up: time to first words (extra) | 1.05     | 1.18  | 0.96  | 1.22  | 20 of 20 |

Measured for the former chatflow card: 1.1 s, 1.3 s, 1.3 s.

## Agentflows (equivalent flow, same branches and questions, not the recorded canvas)

| Metric                                             | Median s | p90 s | Min s | Max s | Correct  |
| -------------------------------------------------- | -------- | ----- | ----- | ----- | -------- |
| Complaint (care branch): time to first words       | 0.89     | 0.96  | 0.79  | 1.03  | 20 of 20 |
| Complaint (care branch): full answer               | 1.21     | 1.43  | 1.07  | 1.49  | 20 of 20 |
| Price question (order branch): time to first words | 0.84     | 0.95  | 0.72  | 1.06  | 20 of 20 |
| Price question (order branch): full answer (extra) | 1.24     | 1.39  | 1.13  | 1.43  | 20 of 20 |

Shown on the card: 0.9 s, 1.2 s, 0.8 s. These medians are from an equivalent flow with the same branches and questions, not the recorded canvas.

## Share and embed (public prediction stream, no session)

| Metric                                          | Median s | p90 s | Min s | Max s | Correct  |
| ----------------------------------------------- | -------- | ----- | ----- | ----- | -------- |
| Shared link: time to first words                | 0.35     | 0.40  | 0.30  | 0.52  | 20 of 20 |
| Shared link: full table                         | 0.84     | 1.07  | 0.75  | 1.23  | 20 of 20 |
| Embed on a website: time to first words (extra) | 0.35     | 0.46  | 0.30  | 0.53  | 20 of 20 |
| Embed on a website: full table (extra)          | 1.13     | 1.29  | 1.02  | 1.33  | 20 of 20 |

Shown on the card: 0.4 s, 0.8 s, 0.4 s.

## Reference: direct model call, no Cuttlely

| Metric                                                     | Median s | p90 s | Min s | Max s | Correct  |
| ---------------------------------------------------------- | -------- | ----- | ----- | ----- | -------- |
| Direct model call, shared-link prompt: time to first words | 0.42     | 0.50  | 0.37  | 0.60  | 20 of 20 |
| Direct model call, shared-link prompt: full answer         | 0.96     | 1.07  | 0.83  | 1.36  | 20 of 20 |

## Canvases

-   Chatflows: the recorded canvas. The nodes and system prompt match the video (gpt-4.1-mini, Tool Agent, Buffer Memory, Calculator).
-   Share and embed: the recorded canvas. The nodes, prompt and share settings match the video (gpt-4.1-mini, Conversation Chain, Buffer Memory; title, welcome, starters, allowed origins), made public as the video does.
-   Agentflows: the recorded canvas was not kept. The medians are from an equivalent flow with the same branches and questions, not the recorded canvas. The flow has the same four cards (Start, Classify Message, Order Agent, Care Agent) and the same two branches. Its prompts are not the video's prompts.
-   The questions are the videos' exact turns.

## Notes

-   A new chat sends no chatId and uses the one the server returns, as the clients do.
-   The shared link's first words arrive slightly sooner than the direct model-call reference. The reference opens a new connection each round, while the server may reuse its connection, so the reference is not a strict lower bound.
-   The chatflow's first words come after two model calls and the calculator (the tool agent picks the tool, then answers), and the agentflow's after the Classify Message call.
