# Application architecture

High-level structure of **Simple GraphDB**: a single Go binary serving an embedded SPA, with JSON file persistence and a REST API.

## Overview diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         GraphDB (single Go binary)                        │
│                                                                          │
│   main.go  ──►  net/http server  ──►  :8080 (localhost default)          │
│                    │                                                     │
│         ┌──────────┴──────────┐                                          │
│         ▼                     ▼                                          │
│   embed.FS static/      REST API  /api/*                                  │
│   (index.html,          (JSON in / out)                                  │
│    app.js, style.css)                                                    │
└─────────┬───────────────────────┬────────────────────────────────────────┘
          │                       │
          │  static files         │  CRUD + list
          ▼                       ▼
┌─────────────────────┐   ┌───────────────────────────────────────────────┐
│  Browser (SPA UI)   │   │  Store (in-memory + disk)                     │
│                     │   │                                               │
│  Toolbar            │   │  graphs map[name]*Graph                       │
│   New ▾ / Save      │◄──┤    mutex-protected                            │
│   Export ▾          │   │                                               │
│   Search            │   │  Persistence: graphs/<name>.json              │
│                     │   │    load on startup · save on write            │
│  ┌─────────┬──────┐ │   └───────────────────────────────────────────────┘
│  │ Graph   │Props │ │
│  │ pane    │pane  │ │
│  │ (SVG)   │(CRUD)│ │
│  └────┬────┴──┬───┘ │
│       │       │     │
│  pan/zoom     │     │
│  select/drag  │     │
│  multi-select │     │
└───────┼───────┼─────┘
        │       │
        │  fetch / PATCH / POST / DELETE
        ▼       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         HTTP API surface                                 │
│                                                                         │
│  GET    /api/graphs                      list names                     │
│  POST   /api/graphs                      create empty graph             │
│  GET    /api/graphs/{name}               load graph                     │
│  PUT    /api/graphs/{name}               save full graph                │
│  DELETE /api/graphs/{name}               delete graph                   │
│                                                                         │
│  POST   /api/graphs/{name}/nodes         create node                    │
│  PUT    /api/graphs/{name}/nodes/{id}    update node                    │
│  DELETE /api/graphs/{name}/nodes/{id}    delete node                    │
│                                                                         │
│  POST   /api/graphs/{name}/edges         create relationship            │
│  PUT    /api/graphs/{name}/edges/{id}    update relationship            │
│  DELETE /api/graphs/{name}/edges/{id}    delete relationship            │
│                                                                         │
│  POST   /api/graphs/{name}/groups        create group                   │
│  PUT    /api/graphs/{name}/groups/{id}   update group                   │
│  DELETE /api/graphs/{name}/groups/{id}   delete group                   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Data model

```
                    Graph
                   /  |  \
              Nodes  Edges  Groups
                │      │       │
           label,note  from/to  member nodeIds
           attributes  label    attributes
           position    note     note
           visibleAttrs attrs   visibleAttrs
           attrOrder            attrOrder
```

- **Nodes** — entities with position, optional note, key/value attributes, visibility flags, and attribute order.
- **Edges** — directed relationships between node or group endpoints.
- **Groups** — named sets of member node IDs with their own attributes and notes; visualized as bounding boxes.

## Typical request flow (edit a node)

```
  User edits properties pane
           │
           ▼
  app.js ──PATCH──► /api/graphs/{name}/nodes/{id}
           │
           ▼
  Server validates · updates in-memory Graph · writes JSON file
           │
           ▼
  JSON response ──► app.js updates local state · re-renders SVG
```

## Client-only flows

These run in the browser without a dedicated export API:

| Action | Behavior |
|--------|----------|
| **Export PNG** | Clone SVG → canvas → download `.png` |
| **Export HTML** | Embed SVG + graph JSON + viewer JS → download self-contained `.html` |
| **Export JSON** | Serialize current graph → download `.json` |
| **Import JSON** | Validate schema → create/load graph via API |
| **Search panel** | Filter in-memory nodes/edges/groups → results table / select-in-graph |

## UI interaction model

```
  Graph pane (left)              Properties pane (right)
  ─────────────────              ───────────────────────
  SVG layers:                    Selected node | edge | group
    groups (boxes)               · label, note
    edges (ortho / fork)         · attributes (+ visibility / order)
    nodes (ERD cards)            · relationships (from / to wording)
  pan, zoom, Fit                 · members (groups)
  multi-select + group move      · inherited group attrs (nodes)
  snap-to-grid
```

## Layer summary

| Layer | Role |
|-------|------|
| **Go server** | Single binary; serves embedded UI; REST API; file-backed store |
| **Store** | In-memory map of graphs + `graphs/*.json` on disk |
| **Static UI** | Vanilla HTML/CSS/JS; no frontend framework |
| **SVG renderer** | ERD-style graph: nodes, orthogonal/fork edges, nested groups |
| **Export** | PNG / self-contained HTML viewer / JSON — generated in the browser |

## Design constraints

- **No external Go modules** beyond the standard library (`net/http`, `embed`, etc.).
- **No SPA framework** — one `app.js` drives state, SVG, and API calls.
- **Persistence** is plain JSON files, not a database engine.

## Source layout

```
graphdb-app/
├── main.go           # server, models, store, API handlers
├── go.mod
├── README.md
├── architecture.md   # this document
└── static/
    ├── index.html
    ├── app.js
    └── style.css
```
