# Simple GraphDB

A lightweight local graph database with a visual ERD-inspired UI, written in pure Go (standard library only) + vanilla HTML/CSS/JS.

## Features

- **Local web server** on `http://localhost:8080` (configurable)
- **Create / Load / Save / Delete** named graph databases (persisted as JSON files)
- **Nodes**: create, read, update, delete; editable label + key-value attributes
- **Relationships (edges)**: create, update, delete; typed relationships with attributes
- **Groups**: Shift+click to multi-select nodes, then **Group** — drawn as a dashed bounding box with a label that tracks member positions
- **Split-pane UI**:
  - **Left**: interactive graph canvas (SVG) styled like an ER diagram — entity boxes, relationship lines, group bounding boxes
  - **Right**: properties inspector for the selected node, relationship, or group
  - Resizable panes
- Drag nodes to rearrange; positions and group bounds update live
- Double-click a relationship label to rename it quickly

## Quick Start

```bash
cd graphdb-app
go run .
```

Then open **http://localhost:8080** in your browser.

### Environment variables

| Variable       | Default   | Description                    |
|----------------|-----------|--------------------------------|
| `ADDR`         | `:8080`   | Listen address                 |
| `GRAPHDB_DIR`  | `graphs`  | Directory for JSON graph files |

## Usage

1. Click **New** and give the graph a name (e.g. `orders`).
2. Click **+ Node** to add entities. Edit the label and attributes in the right pane.
3. Select a node, click **+ Rel**, then click the target node to create a relationship.
4. **Shift+click** multiple nodes, then click **Group** to wrap them in a bounding box.
5. Click any node, relationship, or group box to inspect and edit it on the right.
6. Click **Save** (or rely on auto-save after most mutations) — graphs live under the `graphs/` folder as `name.json`.

## Data Model

```json
{
  "name": "example",
  "nodes": {
    "n123": {
      "id": "n123",
      "label": "Customer",
      "attributes": { "email": "a@b.com", "tier": "gold" },
      "position": { "x": 120, "y": 80 }
    }
  },
  "edges": {
    "e456": {
      "id": "e456",
      "from": "n123",
      "to": "n789",
      "label": "places",
      "attributes": { "since": "2024" }
    }
  },
  "groups": {
    "g1": {
      "id": "g1",
      "label": "Customers",
      "nodeIds": ["n123", "n789"]
    }
  }
}
```

## Architecture

- Single binary, no external dependencies
- `net/http` with Go 1.22+ pattern routing
- Static UI embedded via `//go:embed`
- In-memory store with JSON file persistence
- Thread-safe with `sync.RWMutex`

## License

MIT — do whatever you want with it.
