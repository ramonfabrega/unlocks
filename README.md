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

| type     | meaning                        | blocks? | ordered? |
| -------- | ------------------------------ | ------- | -------- |
| `grants` | doing X is where Y comes from  | yes     | yes      |
| `hard`   | the game will not let you      | yes     | yes      |
| `soft`   | you'd rather have X first      | no      | yes      |
| `boosts` | X makes Y better               | no      | **no**   |

Soft edges are most of what you track, and they're the part no wiki can give
you — they're your judgment about your account.

## Why `boosts` is not an edge like the others

Three types made every true observation get filed as a plan. Ancestral robes
drop in Chambers of Xeric and make the Slayer grind nicer — but the only way to
write that down was `ancestral --soft--> slayer grind`, which asserts you want
ancestral *before* you slay. You don't. You slay from day one. And it parks the
Slayer grind behind a raid, which then drags everything gated on Slayer levels
along with it.

So the relationship went unrecorded. That's the real cost: the model was quietly
teaching you to leave out things you knew, because the only way to say them was
to say something false.

A `boosts` edge makes no claim about order. It never blocks, never downgrades a
status, never earns leverage, never takes a layout column, and is **exempt from
the acyclic rule** — ancestral improving the Slayer grind while the Slayer grind
funds the gear that gets you into the raid is a fact about the game, not a
contradiction. It's a note stuck to two nodes.

Because it makes no ordering claim, it also can't be drawn as one: annotation
edges appear only when you select one of their endpoints, as a dotted teal bow
with no arrowhead. Everything else about the picture stays exactly as it was.

**Write these down freely.** They're the cheapest edges in the model, and they
are the ones that answer "what would make this less painful".

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
| link two nodes | select it, then drag the `◦` handle onto the target (defaults to `soft`) | same |
| change an edge type | the dropdown in **needs** / **unlocks** | same |
| tick a node | double-click, or `space` when selected | select it → **mark done** |
| trace what connects | select → **trace**, or `f` | select → **trace** |
| find something | `/`, then `enter` to jump between matches (`shift+enter` back) | type in `☰` |
| undo / redo | `ctrl+Z` / `ctrl+shift+Z` — works inside text fields too | — |
| pan | drag the canvas | one-finger drag |
| zoom | scroll | two-finger pinch |
| reposition | drag it — that pins it; **unpin all** restores auto-layout | same |
| deselect / clear trace | `escape` | `×` on the sheet |
| declutter | **hide done**, and the lane chips | same, via `☰` |

**trace** lights both directions at once — everything you must get through to
reach the node, and everything it opens up. Ancestors alone answered "what do I
need", which is only half of why you point at something.

**Undo covers every edit**, including a delete and its edges, which is why
`delete node` has no confirmation dialog. It keeps 80 steps and does not survive
a reload — for anything older, the graph is in git.

**Where you were looking is remembered** across reloads: camera, selection, lane
filters, **hide done**. None of it is graph data, so it lives in `localStorage`
and never reaches the server. Selecting a node also puts it in the URL, so
`…/#zulrah` opens the graph focused on Zulrah — that's how you point someone at
one.

**hide done** removes completed nodes from the picture and recompacts the
layout around what's left. Status and leverage keep being computed from the
whole graph, so hiding a finished prerequisite never makes its dependents look
locked again — Zulrah stays `ready` even with the crystal grind hidden.

## The lens

The whole graph is about 4000px wide and 640px tall — a shape no screen
matches, so the map is a poster you pan across rather than something you read.
But almost every question you actually have is local: what does this need, what
does it open up, what else is near it.

**Show** bounds how far around the selected node the picture reaches. Layout
runs on the result, so the drawing genuinely recompacts — it isn't the big
picture with parts hidden. Measured, growing outward from one node:

|                    | 1 hop | 2 hops | 3 hops |
| ------------------ | ----- | ------ | ------ |
| Corrupted Gauntlet |     3 |      7 |     16 |
| Zulrah             |     4 |     11 |     23 |
| Slayer grind       |    10 |     19 |     30 |

Two hops is the readable range, so that's the default. Clicking a node in the
lens re-centres the lens on it, which is how you walk the graph.

It keys off the **selection** and nothing else — with nothing selected you get
the whole map. Seeding from the frontier instead ("show everything I could
start, plus context") sounds better and isn't: 14 seeds reach 39 nodes at one
hop and 47 at two, which is the whole map with extra steps. The sidebar answers
"what can I do" better than fourteen disconnected boxes would.

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

A new node is **not** pinned — it drops into the auto-layout like everything
else and the camera goes to it. `+ node` used to pin it wherever the viewport
happened to be, which is the failure mode this whole section warns about.

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
| `src/audit.ts`    | the modelling checker behind `bun run audit` |
| `src/log.ts`      | commit messages, diffed from the previous graph |
| `src/server.ts`   | Bun server, file writes, git commits |
| `web/`            | the UI (bundled by Bun's HTML import — no build step) |

```
bun test           # derived semantics, layout invariants, log, audit
bun run typecheck
bun run check      # biome
bun run audit      # "did I mean that" — see below
bun run dev        # hot reload + Bun's error overlay
```

The server binds every interface so a phone on the same wifi can reach it, and
there is no auth — anyone on your network can edit the graph. `HOST=127.0.0.1`
closes that when you're only on the laptop. The banner tells you which you got.

## Did I mean that?

`bun run audit` asks the questions the schema can't. Not "is this valid" — that
is already enforced — but "does this edge type match the kinds of node at either
end", which is the mistake you actually make when filling the graph in from
memory at 1am.

```
? grants points at an activity
    grants means the target is a thing you receive. If doing the first
    unlocks the second, that is `hard`.

      Slayer grind --grants--> Kraken
```

It also finds items nothing drops, nodes wired to nothing, blocking edges that a
longer path already implies, and whatever is still flagged `verify`.

Every finding is a **question, not an error**, and some will be deliberate — it
never fails a build. The bar it holds itself to is precision: on the seed graph
it raises two things to check out of 62 edges. A checker that fires on half your
graph gets ignored in a week, so each rule is tested both ways — that it catches
the mistake, and that it stays quiet on the correct modelling it resembles.
