# Model Fusion

Fusion asks several models the same prompt, automatically compares their
answers, and lets you inspect the differences before asking a model to combine
them. It is a local interactive workflow; it does not run repository-reading
agents or edit files.

## Run and review

Use `/fusion <prompt>` in the local interactive TUI. On first use, a searchable
inline picker replaces the editor and lets you choose 2–8 authenticated
participant models and a comparison/fusion model from the active session's
allowed model scope. Search
matches provider/model references—including nested IDs—and model names. In
participant mode, Enter toggles a model; Tab switches to comparison/fusion
model mode, where Enter chooses one. The selected lineup stays visible beside
the search results (below them on narrow terminals). Ctrl+S saves the lineup;
Escape cancels. The selected references are saved to global Felan extension
settings. Before inference, Felan shows the current lineup and request count. Choose
Run with these models, Change models, or Cancel. Change models opens the
inline picker with the current selections preserved, then asks for approval again.

Run `/fusion-models` any time to search and change the saved lineup without
starting model requests or restarting Felan. Changes are saved only when you
confirm with Ctrl+S and apply to the next `/fusion` run. This is separate from
`/model`, which selects the model for the main chat. The `F` review action uses
the same searchable picker to choose a one-off synthesis model without
changing the saved lineup.

The participants receive the same entered prompt in fresh, tool-free requests.
Their original answers remain separately reviewable. Once at least two answers
succeed, a comparison request identifies agreements, disagreements, unique
contributions, and uncertainty. That comparison is an unverified model
assessment, not proof or a combined answer.

The review opens fullscreen on the comparison, like the Prewalk plan review. Switch answer pages
and the comparison with left/right arrows; scroll with the mouse wheel or
Page Up/Down. Use up/down and Enter to choose a numbered action, or press its number. `f` requests a
synthesis with the configured model. `F` lets you enter
an optional synthesis instruction and search for another allowed fusion model
within the same review. Escape from either option step returns to the
review. Confirming either synthesis action closes the review and shows the
result in chat when ready. Neither synthesis action occurs automatically.

Answers render as Markdown, preserving headings, lists, and code blocks. The
comparison requests short bullet lists grouped under Agreements, Key
differences, Partial coverage, Unique insights, and Blind spots. Page Up/Down
scroll by a page; Home/End jump to the beginning or end. Numbered Fuse, Fuse with options, retry, and Cancel / close actions stay below
the scrollable content. Available actions depend on the saved results.

`r` retries only failed participants and
then compares again; `c` retries only the comparison. Escape cancels active
requests and closes the view. `/fusion` reopens an unfinished review on the active session branch without
making requests. After synthesis completes, `/fusion` asks for a new prompt
and starts a new run with lineup confirmation. Canceling the prompt makes no
model requests.

For N participants, the comparison uses N participant requests plus one
comparison request. Explicit synthesis adds one more request. A retry adds the
requests it actually repeats. The review shows actual model provenance,
provider-reported token usage, catalog-based cost estimates when available, and
elapsed time. Cost estimates are not invoices; unknown pricing remains unknown.
Provider cancellation is best effort and may not prevent charges for requests
already received by a provider.

## Model scope and privacy

Fusion uses the existing Pi model registry and credentials. OpenRouter models
can be selected through their configured provider without another API key or
special server-tool request. This client-side flow does **not** invoke
OpenRouter's beta `openrouter:fusion` tool or `openrouter/fusion` alias.

Only the entered Fusion prompt is sent to participant models. Fusion does
not copy the active conversation, project files, instructions, tools, or coding
agent context. Bounded source answers and comparison output are persisted as a
custom entry in the current session branch so the review can be reopened. The
provider sees the user prompt and each corresponding request; use the flow only
when sharing that text with every selected provider is appropriate.

## Settings

Selections are stored in `$FELAN_AGENT_DIR/settings.json` under
`extensionConfig.fusion` and can be changed from `/settings`:

```json
{
  "builtinExtensions": { "fusion": true },
  "extensionConfig": {
    "fusion": {
      "participants": ["openrouter/anthropic/claude-sonnet-4", "openai/gpt-5"],
      "fusionModel": "openrouter/anthropic/claude-sonnet-4",
      "concurrency": 4,
      "timeoutSeconds": 120,
      "maxOutputChars": 12000,
      "thinking": "off"
    }
  }
}
```

Participant references must be distinct, available, authenticated, and inside
the current model scope. Nested provider/model IDs are supported. The default
participant list is empty, so Fusion never chooses several models or creates
unexpected spend without an explicit choice. Disable it with
`builtinExtensions.fusion: false`.

Headless and non-interactive sessions do not run Fusion inference. The feature
never uses tools or subagent execution and never makes a cost-savings claim.
