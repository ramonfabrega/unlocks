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

| | desktop | touch |
| --- | --- | --- |
| add a node | `+ node` | `☰` → `+ node` |
| link two nodes | drag the `◦` handle onto the target (defaults to `soft`) | same, drag the handle |
| change an edge type | the dropdown in **needs** / **unlocks** | same |
| tick a node | double-click, or `space` when selected | select it → **mark done** |
| trace a path | select → **show path**, or `f` | select → **show path** |
| pan | drag the canvas | one-finger drag |
| zoom | scroll | two-finger pinch |
| reposition | drag it — that pins it; **unpin all** restores auto-layout | same |
| deselect / clear path | `escape` | `×` on the sheet |
| declutter | **hide done**, and the lane chips | same, via `☰` |

**hide done** removes completed nodes from the picture and recompacts the
layout around what's left. Status and leverage keep being computed from the
whole graph, so hiding a finished prerequisite never makes its dependents look
locked again — Zulrah stays `ready` even with the crystal grind hidden.

## Layout

Automatic, in four passes: longest-path layering picks the column, dummy chains
give multi-layer edges their own channels, barycenter sweeps order each column,
and median alignment plus chain anchoring set the y coordinates. That third step
is the one that matters visually — without it an edge like `DT2 → Duke` slices
diagonally through all seven columns in between.

On the seed graph three of the four routed edges come out exactly straight. The
fourth can't: `DT2 → Leviathan` shares all seven columns with `DT2 → Duke`, and
two chains leaving one node for different targets have to diverge somewhere.

**Positions are not remembered** — the picture rebuilds itself from the graph
every render. The one exception is pinning:

- **mouse**: dragging a node pins it there, and that pin *is* saved. A pinned
  node shows a small dot in its top-left corner and gets an **unpin** button in
  its panel. **unpin all** clears every one.
- **touch**: dragging a node pans the canvas instead. Accidental pins were the
  worst failure mode on the phone — four of them silently wrecked the layout
  before the cause was obvious.

If a node is somewhere strange, look for the pin dot first.

## On a phone

Below 900px the sidebar collapses into a `☰` drawer, node details become a
bottom sheet, and `⤢` refits the graph when you get lost. Input goes through
pointer events rather than mouse events, so one-finger pan, two-finger
pinch-zoom, drag-to-pin and drag-to-link all work under a finger.

Taps carry a 6px slop radius before they count as a drag — without it every tap
on a node would pin it out of the auto-layout, because a finger never holds
still.

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

Some steps that are really one grind are modelled as one node rather than a
chain of ceremony: **Corrupted Gauntlet** covers normal Gauntlet, **Full crystal
+ bowfa** covers the weapon seed and the armour seeds, and **Rigour** covers the
dexterous prayer scroll. Split any of them back apart if the intermediate step
ever becomes worth tracking on its own.

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
