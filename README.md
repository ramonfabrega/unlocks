# unlocks

An ironman progression graph. What unlocks what, what's worth doing next, and
why the notepad version kept feeling wrong.

```
bun install
bun run graph      # -> http://localhost:5173
```

## Why this exists

The notepad version was an outline:

```
- cg (armor seed)
    - muspah (venator)
    - zulrah (blowpipe)
```

Outlines are trees. Progression is a **DAG**. The moment a node has two parents
— blowpipe wants Zulrah *and* enables Leviathan; the Slayer grind feeds four
different level gates — an outline has to duplicate the node or pick a favorite
parent. That's the "feels off".

Two changes fix it.

**Items are nodes, not parentheses.** CG is not a prerequisite for Muspah —
*bowfa* is, and CG is merely where bowfa comes from. Once items exist in their
own right, a thing that unlocks two things just has two out-edges.

**Edges carry the distinction you were already making by hand.** "92 Slayer for
Araxxor" and "oathplate would be nice before Duke" are not the same claim:

| type     | meaning                        | blocks? |
| -------- | ------------------------------ | ------- |
| `grants` | doing X is where Y comes from  | yes     |
| `hard`   | the game will not let you      | yes     |
| `soft`   | you'd rather have X first      | no      |

Soft edges are most of what you track, and they're the part no wiki can give
you — they're your judgment about your account.

## Status is derived

The only thing you maintain is which nodes are ticked. Everything else falls
out of the graph:

- **done** — ticked
- **ready** — every prerequisite met, including the ones you merely wanted
- **possible** — the game allows it, your gear plan doesn't
- **locked** — a hard requirement is missing

`possible` is the state the outline could never express. Muspah sits there on a
fresh graph: killable today, but you said you'd rather have bowfa. Tick CG and
bowfa and it promotes itself to `ready`.

**Do now** lists everything not hard-locked, sorted by *leverage* — how much of
the graph is still sitting behind it. On the seed data CG scores 17, well ahead
of anything else, which is the thing the notepad couldn't tell you.

## Cycles

Slayer wants to close a loop: Cerberus is a Slayer task and gives Slayer xp. The
data model breaks it by making levels **milestones fed by the grind**, never by
the bosses gated behind them. The server refuses to save a graph with a cycle,
and a test pins it.

## Editing

Everything is in the UI — you never open `graph.json` by hand.

| | |
| --- | --- |
| add a node | `+ node`, or drag the `◦` handle off an existing one |
| link two nodes | drag the `◦` handle onto the target (defaults to `soft`) |
| change an edge type | the dropdown next to it in **needs** / **unlocks** |
| tick a node | double-click it, or `space` with it selected |
| trace a path | select a node → **show path**, or `f` |
| reposition | drag it — that pins it; **unpin all** returns to auto-layout |
| deselect / clear path | `escape` |

Layout is automatic (layered, longest-path, barycenter-ordered). Hand-placing a
DAG feels good for ten minutes and then you dread editing it.

## The file

`graph.json` is storage, not a chore. It stays in git for three reasons:

1. **Bulk edits.** "Add every Slayer-gated boss with its level and drop" is one
   pass in an editor and forty clicks in a UI.
2. **Progression log.** Every save commits, with a message derived by diffing
   against the committed version — `done: Corrupted Gauntlet, Bow of Faerdhinen`.
   `git log` becomes a record of the account.
3. **It outlives the tool.**

Commits are debounced 15s and flushed when the tab closes. `UNLOCKS_NO_GIT=1`
turns them off.

## Seed data

Transcribed from the original notepad, with the implied item and level nodes
made explicit. Nodes and edges marked `verify` (`?` badge) are game facts
written from memory that haven't been checked — the sidebar counts them. Clear
the flag once you've confirmed one.

`Salvaging (?)` is a placeholder: it was nested under herb sack in the notes and
couldn't be placed. Rename it or delete it.

## Layout of the code

| path              | |
| ----------------- | --- |
| `graph.json`      | the data |
| `src/schema.ts`   | zod boundary + structural validation (cycles, dangling edges) |
| `src/derive.ts`   | status, leverage, ancestry, layout — all pure, shared with the browser |
| `src/server.ts`   | Bun server, file writes, git commits |
| `web/`            | the UI (bundled by Bun's HTML import — no build step) |

```
bun test           # derived semantics + the acyclic invariant
bun run typecheck
bun run check      # biome
bun run dev        # hot reload + Bun's error overlay
```
