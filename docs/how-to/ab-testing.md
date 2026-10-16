# A/B test a change with Compare

Test with up to 100 question-and-answer pairs, with more on the roadmap.

A change on a chatflow, agentflow, or harness canvas saves to a draft. Live keeps serving the API, embeds, and shared links until you publish. Compare, in the Publish dialog, asks the same questions on Live and on your draft and shows the two answers side by side, so you see what the change does before anyone else does. A passing test set can then hold Publish until the draft passes.

[![The testing video title card: the Cuttlely mascot holds a clipboard and a magnifying glass beside the Cuttlely logo, the word Testing, and the line Compare, score, then publish. Narrated run of a draft compared with Live, scored on a test set, and published after it passes, 56 seconds with captions.](../images/evaluations/testing-video-poster.png)](https://cuttlely.com/media/products/testing.mp4)

[Watch the testing run (56 seconds, sound on)](https://cuttlely.com/media/products/testing.mp4)

## Compare Live and your draft

1. Edit the flow on its canvas and save. The save is a draft.
2. Select **Publish**. Under **Check recent questions**, choose how many **Past questions** to ask. With the default cap the choices are 4, 10, 25, 50, and 100, and 4 is selected first. The check uses the newest questions people asked this flow, from the API, embeds, shared links, and the canvas test chat.
3. Select **Run check**. Each question runs once on Live and once on your draft.
4. Read the label on each row.

| Label     | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| `Same`    | Both answers have the same words, ignoring capitals and spacing.      |
| `Changed` | The words differ. Read both: the meaning may still be the same.       |
| `Error`   | One side could not answer, for example because it took over a minute. |

![The check results for Bakery helper: 1 of 4 answered differently, 3 of 4 answered the same. Tokens are Live 235 and draft 235. Typical time is 0.1 s on both sides. Estimated cost is no price. What time do you open on Saturday? is marked Changed: Live says We open at 8 AM on Saturdays, and Draft says We open at 7 AM on Saturdays. Do you have gluten-free bread today? is marked Same: Live and Draft both say No, we bake gluten-free bread only on Tuesdays.](../images/versioning/publish-check-results.png)

A model can word an answer a little differently between runs with no change, so `Changed` means "look at this one", not "something broke". The check never changes Live or your draft and leaves nothing in chat history. **Publish** works with or without it, unless the flow requires a passing test set.

To pick the questions yourself, select **Choose questions**. To ask a saved test set instead, choose **A dataset** under **Questions from** and tick the evaluators that score each answer. Each side then gets a pass rate. The full options are in [Check recent questions before you publish](./versioning.md#check-recent-questions-before-you-publish).

## Make Publish wait for a passing test set

On a chatflow, or an agentflow that starts from chat, open the flow's configuration and select **Passing test set**. Choose the dataset, tick the evaluators, set **Pass at** (100 by default), and turn on **Require a passing test set before Publish**. From then on, **Publish** stays disabled until the latest dataset check passed for the current draft and these settings.

![Publish dialog for Bakery helper with the passing test set on. The notice says Publish needs a passing test set at 100%. The last result was 75% and failed. The draft pass rate is 75% (3 passed, 1 failed, 0 errored) and failed at a threshold of 100%. Publish is disabled. Do you have rye loaves today? is marked Same, with the expected answer Yes, rye is baked every morning.](../images/evaluations/publish-dataset.png)

The gate covers Publish of the current draft only. Roll back, Promote, and `PUT /api/v1/chatflows/:id` can still change Live. A harness can score a dataset for one run, and that result is not stored as a pass. The details are in [Require a passing test set before you publish](./versioning.md#require-a-passing-test-set-before-you-publish).

## Next

-   [Turn real answers into tests](./tests-from-answers.md) builds a test set from rated answers in the message viewer.
-   [Evaluations](./evaluations.md) covers datasets, evaluators, and the pass mark.
-   [Fail a build when answers change](./ci-gate.md) runs the same check from CI with `cuttlely check`, including `--gate`.
