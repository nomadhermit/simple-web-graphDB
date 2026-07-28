# Simple GraphDB

A lightweight local graph database with a visual ERD-inspired UI, written in pure Go (standard library only) + vanilla HTML/CSS/JS.

**Architecture:** see [architecture.md](architecture.md) for a flow diagram of the application layers, API, data model, and request paths.

!! for local use only, not for internet facing scenarios without proper security enhancements and review !!

!! vibe coded with Grok as experiment !!

## Features

- Local web server on `http://localhost:8080` (configurable)
- Create / load / save / delete named graphs (JSON files on disk)
- Nodes, relationships, and groups with attributes, visibility, notes, and custom attribute order
- Split-pane UI: graph canvas (left) + properties inspector (right), resizable
- Pan / zoom, multi-select move, snap-to-grid
- Group ↔ node relationships, inherited group attributes in the properties pane
- Report queries with filters; export PNG / JSON / CSV
- Download and upload graph JSON (validated on import)

## Quick start

```bash
cd graphdb-app
go run .
```

Open **http://localhost:8080** in your browser.

| Variable      | Default  | Description                    |
|---------------|----------|--------------------------------|
| `ADDR`        | `:8080`  | Listen address                 |
| `GRAPHDB_DIR` | `graphs` | Directory for JSON graph files |

---

## Step-by-step usage guide

### 1. Create or open a graph

1. Click **New** in the toolbar.
2. Enter a name (e.g. `orders`) and confirm.
3. Or choose an existing graph from the **Graph** dropdown.
4. Click **Save** anytime to write the current graph to disk (edits also persist through the API as you change objects).

### 2. Add and edit nodes

1. Click **+ Node**. A new entity appears near the center of the current view.
2. Click the node to select it. The **right pane** shows its properties.
3. Change **Label** and press Enter / leave the field to save.
4. Under **Attributes**:
   - Type a key and value, click **+** to add.
   - Edit key/value in place; changes save on blur.
   - Use the **checkbox** to show or hide that attribute on the graph box.
   - Use **▲ / ▼** to set display order (properties pane and graph).
   - Click **×** to delete an attribute.
5. Use **Note** for free-form text (properties only; not drawn on the graph).
6. **Delete Node** removes the node and its incident relationships.

### 3. Create relationships

1. Select a **source** node **or group**.
2. Click **+ Rel** (button becomes **Cancel Rel**; source is highlighted).
3. Click the **target** node or group.
4. Enter a relationship type (e.g. `HAS_ITEM`) when prompted.
5. Press **Esc** or **Cancel Rel** to abort linking mode.
6. Select a relationship (click its line or label) to edit type, attributes, and note in the right pane.
7. Double-click a relationship label on the canvas to rename it quickly.

**Line styles**

- **One-to-one** (single edge of that type from a source): straight line.
- **One-to-many** (same type from one source to several targets): orthogonal fork with corners.

Endpoints can be nodes or groups.

### 4. Multi-select, move, and group

1. **Shift+click** or **Ctrl/Cmd+click** nodes to multi-select (highlights update).
2. **Drag any selected node** to move the whole selection together.
3. With one or more nodes selected, click **Group**, enter a name.
4. The group is drawn as a dashed **bounding box** that tracks member positions.
5. Click the group box to select it. In the properties pane you can:
   - Edit label, note, and attributes (with visibility and order).
   - See **Members** and remove nodes from the group.
   - See **Relationships** involving the group or its members.
6. **Ungroup / Delete** removes the group only (nodes stay).

Nodes that belong to a group show **Inherited from groups** in their properties pane (read-only; not drawn on the node).

### 5. Navigate the canvas

| Action | How |
|--------|-----|
| **Pan** | Drag empty background (or middle-mouse drag) |
| **Zoom** | Mouse wheel toward cursor, or **+** / **−** |
| **Reset zoom** | **100%** button |
| **Resize panes** | Drag the vertical splitter between graph and properties |

### 6. Snap to grid

1. Enable **Snap** in the bottom-right controls. A light grid overlay appears.
2. While dragging, node positions snap to a **20×20** grid (multi-select included).
3. Click **Snap All** to align every node to the grid and save positions.

### 7. Reports (structured queries)

1. Click **Report**.
2. Set filters:
   - **Object type**: All / Nodes / Relationships / Groups
   - **Label contains**: optional text
   - **Attribute key**: optional (suggestions from the graph)
   - **Attribute value**: `contains`, `equals`, or `key exists`
3. Click **Run query** (or press Enter).
4. Results show type, label, id, attributes, and note.
5. Click **↗** on a row to select that object in the graph.
6. **Export CSV** or **Export JSON** for the current result set.

### 8. Export and import

| Action | Steps |
|--------|--------|
| **Export PNG** | **Export PNG** — full graph content as a PNG image |
| **Download JSON** | **Download JSON** — current graph as `{name}.json` |
| **Upload JSON** | **Upload JSON** → choose a file → validation runs → confirm name / overwrite |

**JSON validation** (on upload) checks:

- Root object with a `nodes` map
- Optional `edges` and `groups` maps
- Node positions, edge `from`/`to` endpoints, group `nodeIds`, attribute types
- Errors block import; warnings can be accepted after confirmation

### 9. Delete objects and graphs

- Select a node, relationship, or group → **Delete** in the toolbar or the danger button in the properties pane.
- Multi-selected nodes can be deleted together (confirm prompt).
- **Delete** next to the graph selector removes the entire graph file (confirm prompt).

### 10. Keyboard and mouse tips

- **Esc** — cancel relationship linking mode; close Report modal
- **Shift / Ctrl / Cmd + click** — multi-select nodes
- Click empty canvas — clear selection / cancel link mode
- Drag background — pan; drag node(s) — move

---

## Data model (JSON)

```json
{
  "name": "orders",
  "nodes": {
    "n1": {
      "id": "n1",
      "label": "Order",
      "note": "",
      "attributes": { "status": "open" },
      "visibleAttributes": { "status": true },
      "attributeOrder": ["status"],
      "position": { "x": 40, "y": 40 }
    }
  },
  "edges": {
    "e1": {
      "id": "e1",
      "from": "n1",
      "to": "n2",
      "label": "HAS_ITEM",
      "note": "",
      "attributes": {}
    }
  },
  "groups": {
    "g1": {
      "id": "g1",
      "label": "Checkout",
      "note": "",
      "nodeIds": ["n1", "n2"],
      "attributes": {},
      "visibleAttributes": {},
      "attributeOrder": []
    }
  }
}
```

Edge `from` / `to` may reference a **node id** or a **group id**.

---

## Project layout

```
graphdb-app/
  main.go           # HTTP server, models, JSON persistence
  go.mod
  static/
    index.html
    style.css
    app.js
  graphs/           # created at runtime (GRAPHDB_DIR)
```

No external Go or JS dependencies. Static assets are embedded in the binary when built with `go build`.
