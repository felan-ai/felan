# DiscreteStack for Felan

This extension registers the Felan-managed DiscreteStack provider channel. It
sends requests to the provider's OpenAI-compatible `/chat/completions` endpoint.

## Models

Prices are in USD per million tokens.

| Model | Input | Output | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| DiscreteStack Max (`deepseek-v4.1-flash-1017`) | $0.07 | $0.18 | $0.002 | $0 |
| DiscreteStack Compact (`glm-5.3-flash`) | $0.05 | $0.20 | $0.015 | $0 |

Both models accept text and images. Their supported thinking levels are `off`,
`minimal`, `low`, `high`, and `max`. The gateway has no minimal effort, so
`minimal` sends no reasoning, the same as `off`.

The gateway rejects a request when its prompt plus `max_tokens` exceeds
1,048,576 tokens. Each model therefore reports a 131,072-token output limit and
a 917,504-token context window, so sessions compact before a request can exceed
the gateway limit.

## Configuration

Run `/login`, select **DiscreteStack**, and enter your API key. For environments
where interactive login is not available, set `DISCRETESTACK_API_KEY`. A saved
login takes precedence over the environment variable.

When retries are enabled, Pi retries HTTP 429 responses under load through its
normal session retry policy.
