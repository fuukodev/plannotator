# @plannotator/review-editor

The React code-review application. It draws diffs, file previews, annotations, review guides and Ask AI conversations.

`apps/review` builds this package. The Inbox also consumes its review surfaces. The application receives review state and actions from Plannotator's server.

## Build and validation

Install dependencies from the repository root with `bun install --frozen-lockfile`. Use the Bun version required by the repository.

From the repository root:

```sh
bun run typecheck
bun run build:review
```

Follow [the development guide](../../docs/agent-guides/project-and-development.md) to build and run the CLI. Build review before hook and OpenCode so they receive current assets.

## Diagrams in previews and chat

Markdown previews and Ask AI answers use `ReviewDiagramFence`. The review server advertises separate engine and runtime URLs. A complete Mermaid answer fence loads the engine on demand. Without an advert, the answer keeps its source as code.

The review entry must not bundle Mermaid or Graphviz. Keep the shared chat layer independent of the UI diagram adapter. See [the code-review guide](../../docs/agent-guides/code-review.md#mermaid-in-ask-ai-answers) and `tests/entry-assets.test.ts`.

Ask AI follows the latest question within its file group, including when an asynchronous diagram changes the answer height. Scrolling away pauses following. Returning within 24px resumes following. Explicit history navigation pauses following before the scroll starts.

Source fallbacks retain ordinary code styling and horizontal scrolling while an engine loads or fails.

Copying or saving an answer preserves the original Markdown. This package does not implement an AI provider.
