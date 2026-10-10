/**
 * Shared helpers for working with Anthropic Claude models across providers
 * (direct Anthropic API, AWS Bedrock, Google Vertex AI, etc.).
 *
 * Different providers expose Claude with different name conventions:
 *   - Anthropic API:   "claude-opus-4-7"
 *   - AWS Bedrock:     "anthropic.claude-opus-4-7-v1", "us.anthropic.claude-opus-4-7-..."
 *   - Vertex AI:       "claude-opus-4-7", "claude-opus-4-7@20251015"
 *
 * The regex patterns below intentionally match only the version-bearing
 * portion of the name so they work across all of the above.
 */

/**
 * Model name patterns that do not accept sampling parameters
 * (`temperature`, `top_p`, `top_k`). Anthropic returns an error for these on
 * every model from Claude Opus 4.7 on: Opus 4.7 to 4.9, and all Opus, Sonnet,
 * Haiku, Fable and Mythos models with a major version of 5 or more.
 * Extend this list when new model families adopt the same restriction.
 */
export const MODELS_WITHOUT_SAMPLING_PARAMS: RegExp[] = [
    // Opus 4.7, 4.8, 4.9
    /opus-4-[7-9](?:\b|-)/,
    // Opus, Sonnet and Haiku 5.x and later ("claude-sonnet-5", "claude-haiku-5-5", "anthropic.claude-opus-5-5",
    // "claude-sonnet-5@...", OpenRouter's "claude-sonnet-5.5"). Two-digit majors are allowed, dated snapshots
    // such as "claude-3-5-haiku-20241022" are not.
    /(?:opus|sonnet|haiku)-(?:[5-9]|[1-9]\d)(?!\d)/,
    // Fable and Mythos started at 5
    /(?:fable|mythos)-\d/
]

/**
 * Returns false when the given model name matches any pattern in
 * `MODELS_WITHOUT_SAMPLING_PARAMS`. Callers should skip setting
 * `temperature`, `topP`, and `topK` when this returns false.
 */
export const supportsSamplingParams = (modelName?: string): boolean => {
    if (!modelName) return true
    return !MODELS_WITHOUT_SAMPLING_PARAMS.some((pattern) => pattern.test(modelName))
}
