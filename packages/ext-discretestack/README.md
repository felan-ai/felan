# DiscreteStack for Felan

This extension registers the DiscreteStack provider. It sends requests to the
OpenAI-compatible `/chat/completions` endpoint that matches the API key.

## Models

Prices are in USD per million tokens.

| Model | Input | Output | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| DiscreteStack Max (`discretestack-max`) | $0.07 | $0.18 | $0.002 | $0 |
| DiscreteStack Compact (`discretestack-compact`) | $0.05 | $0.20 | $0.015 | $0 |

Both models accept text and images. Their supported thinking levels are `off`,
`minimal`, `low`, `high`, and `max`. The gateway has no minimal effort, so
`minimal` sends no reasoning, the same as `off`.

The gateway rejects a request when its prompt plus `max_tokens` exceeds
1,048,576 tokens, and the personal-key endpoint rejects `max_tokens` above
64,000. Each model therefore reports a 64,000-token output limit and a
984,576-token context window, so sessions compact before a request can exceed
either limit.

## Configuration

Run `/login`, select **DiscreteStack**, and enter your API key. For environments
where interactive login is not available, set `DISCRETESTACK_API_KEY`. A saved
login takes precedence over the environment variable.

DiscreteStack issues two kinds of keys, each for its own endpoint:

| Key type | `DISCRETESTACK_KEY_TYPE` | Endpoint |
| --- | --- | --- |
| Personal key | `user` or unset | `https://api.discretestack.eu/v1` |
| Provider channel key, used for Felan-managed access | `provider` | `https://api.discretestack.eu/provider/v1` |

The key type is read from the same place as the key:

- A saved credential uses its own `env.DISCRETESTACK_KEY_TYPE`. `/login` saves
  personal keys, so it never sets this value. A provider channel credential is
  stored as
  `{ "type": "api_key", "key": "...", "env": { "DISCRETESTACK_KEY_TYPE": "provider" } }`.
- An environment key uses the `DISCRETESTACK_KEY_TYPE` environment variable.

A saved personal key therefore stays on the personal endpoint even when the
environment sets `DISCRETESTACK_KEY_TYPE=provider`. Any value other than `user`
or `provider` fails the request with an error that names the variable.

When retries are enabled, Pi retries HTTP 429 responses under load through its
normal session retry policy.

## Exports

`@felan-ai/ext-discretestack` exports the extension and
`createDiscreteStackProvider()`, the native Pi provider it registers.
`@felan-ai/ext-discretestack/provider` exports the provider id and name, the
model list, the endpoint URLs, and the environment variable names, with no
runtime imports.
