# @plannotator/inbox

The React Inbox application and its reusable thread surfaces. It includes thread navigation, replies, Ask AI, review readers and Shape boards.

`apps/inbox` builds the application. Plannotator's CLI serves the built pages and supplies their backend. This package does not start a server.

## Build and validation

Install dependencies from the repository root with `bun install --frozen-lockfile`. Use the Bun version required by the repository.

The hook build also builds the Inbox pages. Follow [the development guide](../../docs/agent-guides/project-and-development.md) for the required review, hook and OpenCode build order.

From the repository root:

```sh
bun run typecheck
bunx tsc --noEmit -p packages/inbox/tsconfig.json
```

Run `plannotator inbox` with a built CLI to open the Inbox. Its configuration belongs to the CLI, as described in [the Inbox guide](../../docs/agent-guides/inbox.md).

## Ask AI diagrams

`ask/AskChat.tsx` passes the UI Mermaid renderer to `ChatTranscript`. `shape/ShapeBoard.tsx` passes the same renderer to the Shape Ask panel. Both use the existing read-only diagram viewer.

Only complete assistant Mermaid fences render as diagrams. User messages and ordinary code remain text. The transcript retains its existing sanitizer, streaming limits and rich-Markdown policy. The server stores the original answer, including its Markdown fences.

Tests must use temporary data directories and the repository's fake agent and Inbox helpers. Never connect a test to the user's Inbox.
