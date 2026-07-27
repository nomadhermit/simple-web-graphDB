(() => {
  // --- State ---
  let currentGraph = null; // { name, nodes: {}, edges: {}, groups: {} }
  let selectedId = null;   // node / edge / group id
  let selectedType = null; // 'node' | 'edge' | 'group'
  let selectedNodeIds = new Set(); // multi-select for grouping
  let dragState = null;    // { id, startX, startY, origX, origY }
  let linkFromId = null;   // when set, next node click creates a relationship from this id

  // viewport transform (world → screen)
  let viewScale = 1;
  let viewX = 0;
  let viewY = 0;
  let panState = null; // { startClientX, startClientY, origX, origY }
  let snapToGrid = false;
  const GRID_SIZE = 20;

  const NODE_W = 160;
  const NODE_H_BASE = 36;
  const ATTR_H = 16;
  const PADDING = 8;
  const GROUP_PAD = 24;

  // --- DOM refs ---
  const graphSelect = document.getElementById('graphSelect');
  const btnNew = document.getElementById('btnNew');
  const btnSave = document.getElementById('btnSave');
  const btnExportPng = document.getElementById('btnExportPng');
  const btnReport = document.getElementById('btnReport');
  const btnDownloadJson = document.getElementById('btnDownloadJson');
  const btnUploadJson = document.getElementById('btnUploadJson');
  const jsonFileInput = document.getElementById('jsonFileInput');
  const btnDeleteGraph = document.getElementById('btnDeleteGraph');
  const btnAddNode = document.getElementById('btnAddNode');
  const btnAddEdge = document.getElementById('btnAddEdge');
  const btnGroup = document.getElementById('btnGroup');
  const btnDeleteSelected = document.getElementById('btnDeleteSelected');
  const graphSvg = document.getElementById('graphSvg');
  const viewport = document.getElementById('viewport');
  const groupsLayer = document.getElementById('groupsLayer');
  const edgesLayer = document.getElementById('edgesLayer');
  const nodesLayer = document.getElementById('nodesLayer');
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnZoomReset = document.getElementById('btnZoomReset');
  const zoomLabel = document.getElementById('zoomLabel');
  const chkSnapGrid = document.getElementById('chkSnapGrid');
  const btnSnapAll = document.getElementById('btnSnapAll');
  const emptyState = document.getElementById('emptyState');
  const propsContent = document.getElementById('propsContent');
  const propsPane = document.getElementById('propsPane');
  const paneResizer = document.getElementById('paneResizer');
  const modal = document.getElementById('modal');
  const modalTitle = document.getElementById('modalTitle');
  const modalInput = document.getElementById('modalInput');
  const modalCancel = document.getElementById('modalCancel');
  const modalConfirm = document.getElementById('modalConfirm');

  // --- API helpers ---
  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || res.statusText);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // --- Graph management ---
  async function refreshGraphList() {
    const names = await api('GET', '/api/graphs');
    const current = currentGraph?.name;
    graphSelect.innerHTML = '';
    const optEmpty = document.createElement('option');
    optEmpty.value = '';
    optEmpty.textContent = '— select —';
    graphSelect.appendChild(optEmpty);
    names.sort().forEach(n => {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      if (n === current) opt.selected = true;
      graphSelect.appendChild(opt);
    });
  }

  function normalizeGraph(g) {
    if (!g) return g;
    if (!g.nodes || typeof g.nodes !== 'object') g.nodes = {};
    if (!g.edges || typeof g.edges !== 'object') g.edges = {};
    if (!g.groups || typeof g.groups !== 'object') g.groups = {};
    return g;
  }

  function cancelLinkMode() {
    linkFromId = null;
    document.body.classList.remove('linking');
    if (btnAddEdge) {
      btnAddEdge.textContent = '+ Rel';
      btnAddEdge.classList.remove('primary');
    }
  }

  function clearSelection() {
    selectedId = null;
    selectedType = null;
    selectedNodeIds = new Set();
  }

  async function loadGraph(name) {
    cancelLinkMode();
    if (!name) {
      currentGraph = null;
      clearSelection();
      render();
      return;
    }
    try {
      currentGraph = normalizeGraph(await api('GET', `/api/graphs/${encodeURIComponent(name)}`));
      clearSelection();
      render();
    } catch (e) {
      alert('Failed to load: ' + e.message);
    }
  }

  async function createGraph(name) {
    cancelLinkMode();
    try {
      currentGraph = normalizeGraph(await api('POST', '/api/graphs', { name }));
      await refreshGraphList();
      graphSelect.value = currentGraph.name;
      clearSelection();
      render();
    } catch (e) {
      alert('Failed to create: ' + e.message);
    }
  }

  async function saveGraph() {
    if (!currentGraph) return;
    try {
      await api('PUT', `/api/graphs/${encodeURIComponent(currentGraph.name)}`, currentGraph);
      // visual feedback
      btnSave.textContent = 'Saved ✓';
      setTimeout(() => { btnSave.textContent = 'Save'; }, 1200);
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
  }

  async function deleteGraph() {
    if (!currentGraph) return;
    if (!confirm(`Delete graph "${currentGraph.name}" permanently?`)) return;
    try {
      await api('DELETE', `/api/graphs/${encodeURIComponent(currentGraph.name)}`);
      currentGraph = null;
      clearSelection();
      await refreshGraphList();
      graphSelect.value = '';
      render();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  // --- Viewport (pan / zoom) ---
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 3;

  function applyViewport() {
    if (viewport) {
      viewport.setAttribute('transform', `translate(${viewX}, ${viewY}) scale(${viewScale})`);
    }
    if (zoomLabel) zoomLabel.textContent = Math.round(viewScale * 100) + '%';
    try {
      localStorage.setItem('graphdb-view', JSON.stringify({ x: viewX, y: viewY, s: viewScale }));
    } catch (_) {}
  }

  function setZoom(newScale, centerClientX, centerClientY) {
    const svgRect = graphSvg.getBoundingClientRect();
    const cx = centerClientX != null ? centerClientX - svgRect.left : svgRect.width / 2;
    const cy = centerClientY != null ? centerClientY - svgRect.top : svgRect.height / 2;
    // world point under cursor before zoom
    const wx = (cx - viewX) / viewScale;
    const wy = (cy - viewY) / viewScale;
    viewScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newScale));
    // keep that world point under cursor
    viewX = cx - wx * viewScale;
    viewY = cy - wy * viewScale;
    applyViewport();
  }

  function screenToWorld(clientX, clientY) {
    const svgRect = graphSvg.getBoundingClientRect();
    return {
      x: (clientX - svgRect.left - viewX) / viewScale,
      y: (clientY - svgRect.top - viewY) / viewScale
    };
  }

  try {
    const saved = JSON.parse(localStorage.getItem('graphdb-view') || 'null');
    if (saved && typeof saved.s === 'number') {
      viewScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, saved.s));
      viewX = saved.x || 0;
      viewY = saved.y || 0;
    }
  } catch (_) {}

  // --- Node / Edge operations (optimistic + persist) ---
  async function addNode() {
    if (!currentGraph) {
      alert('Select or create a graph first');
      return;
    }
    // place near center of current view (world coords)
    const svgRect = graphSvg.getBoundingClientRect();
    const world = screenToWorld(
      svgRect.left + svgRect.width / 2,
      svgRect.top + svgRect.height / 2
    );
    const cx = world.x + (Math.random() - 0.5) * 100;
    const cy = world.y + (Math.random() - 0.5) * 80;
    try {
      const node = await api('POST', `/api/graphs/${encodeURIComponent(currentGraph.name)}/nodes`, {
        label: 'Entity',
        attributes: {},
        position: { x: cx - NODE_W / 2, y: cy - 40 }
      });
      currentGraph.nodes[node.id] = node;
      selectedId = node.id;
      selectedType = 'node';
      render();
    } catch (e) {
      alert('Failed to add node: ' + e.message);
    }
  }

  async function updateNode(id, patch) {
    if (!currentGraph) return;
    try {
      const node = await api('PUT', `/api/graphs/${encodeURIComponent(currentGraph.name)}/nodes/${id}`, patch);
      currentGraph.nodes[id] = node;
      render();
    } catch (e) {
      alert('Update failed: ' + e.message);
    }
  }

  async function deleteNode(id) {
    if (!currentGraph) return;
    try {
      await api('DELETE', `/api/graphs/${encodeURIComponent(currentGraph.name)}/nodes/${id}`);
      delete currentGraph.nodes[id];
      // clean local edges
      for (const eid of Object.keys(currentGraph.edges)) {
        const e = currentGraph.edges[eid];
        if (e.from === id || e.to === id) delete currentGraph.edges[eid];
      }
      // clean local groups
      for (const gid of Object.keys(currentGraph.groups || {})) {
        const grp = currentGraph.groups[gid];
        grp.nodeIds = (grp.nodeIds || []).filter(nid => nid !== id);
        if (grp.nodeIds.length === 0) delete currentGraph.groups[gid];
      }
      selectedNodeIds.delete(id);
      if (selectedId === id) {
        selectedId = selectedNodeIds.size ? [...selectedNodeIds][0] : null;
        if (!selectedId) selectedType = null;
      }
      render();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  async function addEdge(fromId, toId, label = 'relates') {
    if (!currentGraph) return;
    try {
      const edge = await api('POST', `/api/graphs/${encodeURIComponent(currentGraph.name)}/edges`, {
        from: fromId,
        to: toId,
        label,
        attributes: {}
      });
      currentGraph.edges[edge.id] = edge;
      selectedId = edge.id;
      selectedType = 'edge';
      render();
    } catch (e) {
      alert('Failed to add relationship: ' + e.message);
    }
  }

  async function updateEdge(id, patch) {
    if (!currentGraph) return;
    try {
      const edge = await api('PUT', `/api/graphs/${encodeURIComponent(currentGraph.name)}/edges/${id}`, patch);
      currentGraph.edges[id] = edge;
      render();
    } catch (e) {
      alert('Update failed: ' + e.message);
    }
  }

  async function deleteEdge(id) {
    if (!currentGraph) return;
    try {
      await api('DELETE', `/api/graphs/${encodeURIComponent(currentGraph.name)}/edges/${id}`);
      delete currentGraph.edges[id];
      if (selectedId === id) {
        selectedId = null;
        selectedType = null;
      }
      render();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  // --- Group operations ---
  async function addGroup(nodeIds, label = 'Group') {
    if (!currentGraph) return;
    try {
      const grp = await api('POST', `/api/graphs/${encodeURIComponent(currentGraph.name)}/groups`, {
        label,
        nodeIds
      });
      currentGraph.groups[grp.id] = grp;
      selectedType = 'group';
      selectedId = grp.id;
      selectedNodeIds = new Set();
      render();
    } catch (e) {
      alert('Failed to create group: ' + e.message);
    }
  }

  async function updateGroup(id, patch) {
    if (!currentGraph) return;
    try {
      const grp = await api('PUT', `/api/graphs/${encodeURIComponent(currentGraph.name)}/groups/${id}`, patch);
      currentGraph.groups[id] = grp;
      render();
    } catch (e) {
      alert('Update failed: ' + e.message);
    }
  }

  async function deleteGroup(id) {
    if (!currentGraph) return;
    try {
      await api('DELETE', `/api/graphs/${encodeURIComponent(currentGraph.name)}/groups/${id}`);
      delete currentGraph.groups[id];
      for (const eid of Object.keys(currentGraph.edges || {})) {
        const e = currentGraph.edges[eid];
        if (e.from === id || e.to === id) delete currentGraph.edges[eid];
      }
      if (selectedId === id) clearSelection();
      render();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  function groupBounds(grp) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let count = 0;
    for (const nid of grp.nodeIds || []) {
      const node = currentGraph.nodes[nid];
      if (!node) continue;
      count++;
      const h = nodeHeight(node);
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + NODE_W);
      maxY = Math.max(maxY, node.position.y + h);
    }
    if (count === 0) return null;
    const attrCount = groupVisibleAttrLines(grp).length;
    const topExtra = 18 + (attrCount > 0 ? attrCount * 12 + 4 : 0);
    return {
      x: minX - GROUP_PAD,
      y: minY - GROUP_PAD - topExtra,
      w: (maxX - minX) + GROUP_PAD * 2,
      h: (maxY - minY) + GROUP_PAD * 2 + topExtra
    };
  }

  // --- Rendering ---
  const TEXT_MAX_W = NODE_W - 20; // padding left+right inside node
  const TITLE_CHAR_W = 7.2;       // approx px per char at 13px bold
  const ATTR_CHAR_W = 6.2;        // approx px per char at 11px
  const TITLE_LINE_H = 15;
  const HEADER_BASE = 28;

  /** Word-wrap text into lines that fit maxWidth (char-width estimate). */
  function wrapText(text, maxWidth, charW) {
    const s = String(text ?? '');
    if (!s) return [''];
    const maxChars = Math.max(4, Math.floor(maxWidth / charW));
    const words = s.split(/(\s+)/); // keep whitespace tokens
    const lines = [];
    let line = '';
    for (const w of words) {
      if (!w) continue;
      // hard-break very long tokens
      if (w.length > maxChars && !/^\s+$/.test(w)) {
        if (line.trim()) {
          lines.push(line.trimEnd());
          line = '';
        }
        for (let i = 0; i < w.length; i += maxChars) {
          const chunk = w.slice(i, i + maxChars);
          if (i + maxChars < w.length) lines.push(chunk);
          else line = chunk;
        }
        continue;
      }
      if ((line + w).length > maxChars && line.trim()) {
        lines.push(line.trimEnd());
        line = /^\s+$/.test(w) ? '' : w;
      } else {
        line += w;
      }
    }
    if (line.trim() || lines.length === 0) lines.push(line.trimEnd() || '');
    return lines;
  }

  function titleLines(node) {
    return wrapText(node.label || 'Entity', TEXT_MAX_W, TITLE_CHAR_W);
  }

  function isAttrVisible(obj, key) {
    const vis = obj && obj.visibleAttributes;
    if (!vis || typeof vis !== 'object') return true; // default: show all
    if (Object.prototype.hasOwnProperty.call(vis, key)) return !!vis[key];
    return true;
  }

  /** Ordered attribute keys for a node or group (custom order + any missing keys). */
  function orderedAttrKeys(obj) {
    const attrs = obj.attributes || {};
    const order = Array.isArray(obj.attributeOrder) ? obj.attributeOrder.slice() : [];
    const seen = new Set();
    const keys = [];
    for (const k of order) {
      if (Object.prototype.hasOwnProperty.call(attrs, k) && !seen.has(k)) {
        keys.push(k);
        seen.add(k);
      }
    }
    for (const k of Object.keys(attrs)) {
      if (!seen.has(k)) keys.push(k);
    }
    return keys;
  }

  function moveAttrKey(order, key, dir) {
    const keys = order.slice();
    const i = keys.indexOf(key);
    if (i < 0) return keys;
    const j = i + dir;
    if (j < 0 || j >= keys.length) return keys;
    const tmp = keys[i];
    keys[i] = keys[j];
    keys[j] = tmp;
    return keys;
  }

  function groupVisibleAttrLines(grp) {
    const out = [];
    for (const k of orderedAttrKeys(grp)) {
      if (!isAttrVisible(grp, k)) continue;
      out.push(`${k}: ${grp.attributes[k]}`);
    }
    return out;
  }

  function attrLines(node) {
    const out = [];
    for (const k of orderedAttrKeys(node)) {
      if (!isAttrVisible(node, k)) continue;
      const lines = wrapText(`${k}: ${node.attributes[k]}`, TEXT_MAX_W, ATTR_CHAR_W);
      out.push(...lines);
    }
    return out;
  }

  function nodeHeight(node) {
    const tLines = titleLines(node);
    const aLines = attrLines(node);
    const headerH = Math.max(HEADER_BASE, 10 + tLines.length * TITLE_LINE_H);
    const bodyH = aLines.length > 0 ? aLines.length * ATTR_H + 10 : 8;
    return headerH + bodyH + PADDING;
  }

  function render() {
    groupsLayer.innerHTML = '';
    edgesLayer.innerHTML = '';
    nodesLayer.innerHTML = '';

    if (!currentGraph) {
      emptyState.classList.remove('hidden');
      renderProps();
      return;
    }
    emptyState.classList.add('hidden');

    // groups behind everything
    for (const grp of Object.values(currentGraph.groups || {})) {
      drawGroup(grp);
    }

    // edges (under nodes) — fork style for same-type one-to-many
    drawAllEdges();

    // nodes
    for (const node of Object.values(currentGraph.nodes)) {
      drawNode(node);
    }

    renderProps();
  }

  function drawGroup(grp) {
    const b = groupBounds(grp);
    if (!b) return;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.classList.add('group-shape');
    g.dataset.id = grp.id;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.classList.add('group-box');
    if (selectedType === 'group' && selectedId === grp.id) rect.classList.add('selected');
    if (linkFromId === grp.id) rect.classList.add('link-source');
    rect.setAttribute('x', b.x);
    rect.setAttribute('y', b.y);
    rect.setAttribute('width', b.w);
    rect.setAttribute('height', b.h);
    if (grp.color) {
      rect.style.stroke = grp.color;
      rect.style.fill = grp.color.replace(')', ', 0.1)').replace('rgb', 'rgba').replace('#', '');
      // simple opacity fill via attribute if hex
      if (grp.color.startsWith('#')) {
        rect.setAttribute('fill', grp.color + '18');
        rect.setAttribute('stroke', grp.color);
      }
    }
    g.appendChild(rect);

    const labelText = grp.label || 'Group';
    const attrLinesList = groupVisibleAttrLines(grp);
    const labelH = 18 + (attrLinesList.length > 0 ? attrLinesList.length * 12 + 4 : 0);
    let maxLineW = Math.max(40, labelText.length * 7 + 12);
    for (const line of attrLinesList) {
      maxLineW = Math.max(maxLineW, line.length * 6 + 12);
    }
    const lx = b.x + 10;
    const ly = b.y + 4;

    const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    labelBg.classList.add('group-label-bg');
    labelBg.setAttribute('x', lx);
    labelBg.setAttribute('y', ly);
    labelBg.setAttribute('width', Math.min(maxLineW, Math.max(60, b.w - 20)));
    labelBg.setAttribute('height', labelH);
    g.appendChild(labelBg);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.classList.add('group-label');
    label.setAttribute('x', lx + 6);
    label.setAttribute('y', ly + 13);
    label.textContent = labelText;
    g.appendChild(label);

    let ay = ly + 26;
    for (const line of attrLinesList) {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.classList.add('group-attr');
      t.setAttribute('x', lx + 6);
      t.setAttribute('y', ay);
      t.textContent = line;
      g.appendChild(t);
      ay += 12;
    }

    g.addEventListener('click', (e) => {
      e.stopPropagation();
      if (linkFromId) {
        if (grp.id === linkFromId) {
          cancelLinkMode();
          render();
          return;
        }
        const fromId = linkFromId;
        cancelLinkMode();
        const label = prompt('Relationship type:', 'relates');
        if (label === null) {
          select('group', grp.id);
          return;
        }
        addEdge(fromId, grp.id, label.trim() || 'relates');
        return;
      }
      select('group', grp.id);
    });

    groupsLayer.appendChild(g);
  }

  function drawNode(node) {
    const tLines = titleLines(node);
    const aLines = attrLines(node);
    const headerH = Math.max(HEADER_BASE, 10 + tLines.length * TITLE_LINE_H);
    const h = nodeHeight(node);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.classList.add('node-group');
    g.dataset.id = node.id;
    if (selectedType === 'node' && (selectedId === node.id || selectedNodeIds.has(node.id))) {
      g.classList.add('selected');
    }
    if (linkFromId === node.id) g.classList.add('link-source');
    g.setAttribute('transform', `translate(${node.position.x}, ${node.position.y})`);

    // body
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.classList.add('node-rect');
    rect.setAttribute('width', NODE_W);
    rect.setAttribute('height', h);
    g.appendChild(rect);

    // header bar (grows with wrapped title)
    const header = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    header.classList.add('node-header');
    header.setAttribute('width', NODE_W);
    header.setAttribute('height', headerH);
    header.setAttribute('rx', 6);
    g.appendChild(header);
    // cover bottom corners of header so only top is rounded
    if (headerH > 12) {
      const headerFix = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      headerFix.setAttribute('y', headerH - 8);
      headerFix.setAttribute('width', NODE_W);
      headerFix.setAttribute('height', 8);
      headerFix.setAttribute('fill', 'var(--node-header)');
      g.appendChild(headerFix);
    }

    // title (word-wrapped)
    let ty = 16;
    for (const line of tLines) {
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      title.classList.add('node-title');
      title.setAttribute('x', 10);
      title.setAttribute('y', ty);
      title.textContent = line;
      g.appendChild(title);
      ty += TITLE_LINE_H;
    }

    // attributes (word-wrapped)
    let y = headerH + 14;
    for (const line of aLines) {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.classList.add('node-attr');
      t.setAttribute('x', 10);
      t.setAttribute('y', y);
      t.textContent = line;
      g.appendChild(t);
      y += ATTR_H;
    }

    // events
    g.addEventListener('mousedown', onNodeMouseDown);
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      if (linkFromId) {
        if (node.id === linkFromId) {
          cancelLinkMode();
          render();
          return;
        }
        const fromId = linkFromId;
        cancelLinkMode();
        const label = prompt('Relationship type:', 'relates');
        if (label === null) {
          select('node', node.id);
          return;
        }
        addEdge(fromId, node.id, label.trim() || 'relates');
        return;
      }
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        // multi-select toggle
        if (selectedType !== 'node') {
          selectedNodeIds = new Set();
          selectedType = 'node';
        }
        if (selectedNodeIds.has(node.id)) {
          selectedNodeIds.delete(node.id);
          if (selectedId === node.id) {
            selectedId = selectedNodeIds.size ? [...selectedNodeIds][0] : null;
            if (!selectedId) selectedType = null;
          }
        } else {
          selectedNodeIds.add(node.id);
          selectedId = node.id;
          selectedType = 'node';
        }
        render();
        return;
      }
      select('node', node.id);
    });

    nodesLayer.appendChild(g);
  }

  function nodeCenter(node) {
    const h = nodeHeight(node);
    return {
      x: node.position.x + NODE_W / 2,
      y: node.position.y + h / 2,
      hw: NODE_W / 2,
      hh: h / 2
    };
  }

  /** Center box for a node or group endpoint (for edge routing). */
  function endpointCenter(id) {
    const node = currentGraph.nodes[id];
    if (node) return nodeCenter(node);
    const grp = currentGraph.groups[id];
    if (grp) {
      const b = groupBounds(grp);
      if (!b) return null;
      return {
        x: b.x + b.w / 2,
        y: b.y + b.h / 2,
        hw: b.w / 2,
        hh: b.h / 2
      };
    }
    return null;
  }

  function endpointLabel(id) {
    const node = currentGraph.nodes[id];
    if (node) return node.label || id;
    const grp = currentGraph.groups[id];
    if (grp) return (grp.label || 'Group') + ' (group)';
    return id;
  }

  /** Point on the border of a node box in direction (ux, uy) from center. */
  function borderPoint(center, ux, uy, extra = 4) {
    // intersect ray with axis-aligned box
    const tx = Math.abs(ux) > 1e-6 ? center.hw / Math.abs(ux) : Infinity;
    const ty = Math.abs(uy) > 1e-6 ? center.hh / Math.abs(uy) : Infinity;
    const t = Math.min(tx, ty) + extra;
    return { x: center.x + ux * t, y: center.y + uy * t };
  }

  function unit(dx, dy) {
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    return { ux: dx / d, uy: dy / d, dist: d };
  }

  function appendEdgePath(d, edgeId, selected, opts = {}) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add(opts.stem ? 'edge-path-stem' : 'edge-path');
    if (selected) path.classList.add('selected');
    path.setAttribute('d', d);
    path.dataset.id = edgeId;

    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.classList.add('edge-hit');
    hit.setAttribute('d', d);
    hit.dataset.id = edgeId;
    hit.addEventListener('click', (e) => {
      e.stopPropagation();
      select('edge', edgeId);
    });

    edgesLayer.appendChild(hit);
    edgesLayer.appendChild(path);
    return path;
  }

  function appendEdgeLabel(x, y, text, onClick, onDblClick) {
    const labelGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    labelBg.classList.add('edge-label-bg');
    const labelText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    labelText.classList.add('edge-label');
    labelText.setAttribute('x', x);
    labelText.setAttribute('y', y - 4);
    labelText.setAttribute('text-anchor', 'middle');
    labelText.textContent = text || '';
    const approxW = Math.max(24, (text || '').length * 6.5 + 8);
    labelBg.setAttribute('x', x - approxW / 2);
    labelBg.setAttribute('y', y - 16);
    labelBg.setAttribute('width', approxW);
    labelBg.setAttribute('height', 16);
    labelBg.setAttribute('rx', 3);
    labelGroup.appendChild(labelBg);
    labelGroup.appendChild(labelText);
    labelGroup.style.cursor = 'pointer';
    if (onClick) labelGroup.addEventListener('click', onClick);
    if (onDblClick) labelGroup.addEventListener('dblclick', onDblClick);
    edgesLayer.appendChild(labelGroup);
  }

  /** Orthogonal (right-angle) path between two points: horizontal then vertical, or vice versa. */
  function orthoPath(x1, y1, x2, y2, preferHorizontalFirst) {
    if (Math.abs(x1 - x2) < 1) return `M ${x1} ${y1} L ${x2} ${y2}`;
    if (Math.abs(y1 - y2) < 1) return `M ${x1} ${y1} L ${x2} ${y2}`;
    const horizFirst = preferHorizontalFirst !== undefined
      ? preferHorizontalFirst
      : Math.abs(x2 - x1) >= Math.abs(y2 - y1);
    if (horizFirst) {
      return `M ${x1} ${y1} L ${x2} ${y1} L ${x2} ${y2}`;
    }
    return `M ${x1} ${y1} L ${x1} ${y2} L ${x2} ${y2}`;
  }

  function sideExit(center, towardX, towardY) {
    // pick dominant axis exit from the box (cardinal side)
    const dx = towardX - center.x;
    const dy = towardY - center.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const ux = dx >= 0 ? 1 : -1;
      return {
        pt: { x: center.x + ux * (center.hw + 4), y: center.y },
        dir: { ux, uy: 0 },
        horizontal: true
      };
    }
    const uy = dy >= 0 ? 1 : -1;
    return {
      pt: { x: center.x, y: center.y + uy * (center.hh + 4) },
      dir: { ux: 0, uy },
      horizontal: false
    };
  }

  function sideEntry(center, fromX, fromY) {
    const dx = center.x - fromX;
    const dy = center.y - fromY;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const ux = dx >= 0 ? 1 : -1;
      return {
        pt: { x: center.x - ux * (center.hw + 10), y: center.y },
        horizontal: true
      };
    }
    const uy = dy >= 0 ? 1 : -1;
    return {
      pt: { x: center.x, y: center.y - uy * (center.hh + 10) },
      horizontal: false
    };
  }

  function drawSingleEdge(edge) {
    const fc = endpointCenter(edge.from);
    const tc = endpointCenter(edge.to);
    if (!fc || !tc) return;
    // 1:1 — straight line from source side to target side
    const exit = sideExit(fc, tc.x, tc.y);
    const entry = sideEntry(tc, fc.x, fc.y);
    const start = exit.pt;
    const end = entry.pt;

    const d = `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
    const selected = selectedType === 'edge' && selectedId === edge.id;
    appendEdgePath(d, edge.id, selected);

    // label near midpoint of the path
    const labelX = (start.x + end.x) / 2;
    const labelY = (start.y + end.y) / 2;
    appendEdgeLabel(labelX, labelY, edge.label, (e) => {
      e.stopPropagation();
      select('edge', edge.id);
    }, (e) => {
      e.stopPropagation();
      const newLabel = prompt('Relationship type:', edge.label);
      if (newLabel !== null && newLabel !== edge.label) {
        updateEdge(edge.id, { label: newLabel, note: edge.note || '' });
      }
    });
  }

  /**
   * Fork-style for one source → many targets with the same relationship label.
   * Orthogonal stem + shared spine, then right-angle branches to each target.
   */
  function drawForkEdges(fromId, edges) {
    if (!edges.length) return;
    if (edges.length === 1) {
      drawSingleEdge(edges[0]);
      return;
    }

    const fc = endpointCenter(fromId);
    if (!fc) return;
    const targets = [];
    for (const edge of edges) {
      const tc = endpointCenter(edge.to);
      if (!tc) continue;
      targets.push({ edge, tc });
    }
    if (targets.length === 0) return;
    if (targets.length === 1) {
      drawSingleEdge(targets[0].edge);
      return;
    }

    // centroid of targets
    let cx = 0, cy = 0;
    for (const t of targets) { cx += t.tc.x; cy += t.tc.y; }
    cx /= targets.length;
    cy /= targets.length;

    // exit source toward centroid on a cardinal side
    const exit = sideExit(fc, cx, cy);
    const start = exit.pt;

    // spine is axis-aligned through a bus offset from the source
    const busOffset = 48;
    let spineHorizontal; // true = spine runs left-right (branches go vertical)
    let juncX, juncY;
    if (exit.horizontal) {
      // left/right exit → stem goes horizontal, spine is vertical
      spineHorizontal = false;
      juncX = start.x + exit.dir.ux * busOffset;
      juncY = start.y;
    } else {
      // top/bottom exit → stem goes vertical, spine is horizontal
      spineHorizontal = true;
      juncX = start.x;
      juncY = start.y + exit.dir.uy * busOffset;
    }

    // expand spine to cover all target projections on the spine axis
    let spineMin, spineMax;
    if (spineHorizontal) {
      spineMin = Math.min(juncX, ...targets.map(t => t.tc.x));
      spineMax = Math.max(juncX, ...targets.map(t => t.tc.x));
    } else {
      spineMin = Math.min(juncY, ...targets.map(t => t.tc.y));
      spineMax = Math.max(juncY, ...targets.map(t => t.tc.y));
    }

    const anySelected = targets.some(t => selectedType === 'edge' && selectedId === t.edge.id);

    // stem source → junction (no arrow)
    const stemD = `M ${start.x} ${start.y} L ${juncX} ${juncY}`;
    appendEdgePath(stemD, targets[0].edge.id, anySelected, { stem: true });

    // shared spine along the bus
    let spineD;
    if (spineHorizontal) {
      spineD = `M ${spineMin} ${juncY} L ${spineMax} ${juncY}`;
    } else {
      spineD = `M ${juncX} ${spineMin} L ${juncX} ${spineMax}`;
    }
    appendEdgePath(spineD, targets[0].edge.id, anySelected, { stem: true });

    // junction dots at spine ends optional — single marker at stem join
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.classList.add('fork-junction');
    if (anySelected) dot.classList.add('selected');
    dot.setAttribute('cx', juncX);
    dot.setAttribute('cy', juncY);
    dot.setAttribute('r', 3.5);
    edgesLayer.appendChild(dot);

    // label on stem
    const labelX = (start.x + juncX) / 2;
    const labelY = (start.y + juncY) / 2;
    const label = edges[0].label || '';
    appendEdgeLabel(labelX, labelY, label, (e) => {
      e.stopPropagation();
      select('edge', targets[0].edge.id);
    }, async (e) => {
      e.stopPropagation();
      const newLabel = prompt('Relationship type (applies to all in fork):', label);
      if (newLabel === null || newLabel === label) return;
      for (const t of targets) {
        await updateEdge(t.edge.id, { label: newLabel.trim() || 'relates', note: t.edge.note || '' });
      }
    });

    // orthogonal branches from spine to each target
    for (const t of targets) {
      let branchStartX, branchStartY;
      if (spineHorizontal) {
        branchStartX = t.tc.x;
        branchStartY = juncY;
      } else {
        branchStartX = juncX;
        branchStartY = t.tc.y;
      }
      const entry = sideEntry(t.tc, branchStartX, branchStartY);
      const end = entry.pt;
      // corner path: along spine projection → into target
      const branchD = orthoPath(branchStartX, branchStartY, end.x, end.y, spineHorizontal);
      const selected = selectedType === 'edge' && selectedId === t.edge.id;
      appendEdgePath(branchD, t.edge.id, selected);
    }
  }

  function drawAllEdges() {
    const edges = Object.values(currentGraph.edges || {});
    // group by (from, label) for outbound one-to-many of same type
    const byKey = new Map();
    for (const edge of edges) {
      const key = edge.from + '\0' + (edge.label || '');
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(edge);
    }
    for (const group of byKey.values()) {
      const fromId = group[0].from;
      if (!endpointCenter(fromId)) continue;
      const targets = new Set(group.map(e => e.to));
      if (targets.size >= 2) {
        drawForkEdges(fromId, group);
      } else {
        for (const edge of group) {
          if (endpointCenter(edge.to)) drawSingleEdge(edge);
        }
      }
    }
  }

  // --- Selection & Props panel ---
  function select(type, id) {
    selectedType = type;
    selectedId = id;
    if (type === 'node') {
      selectedNodeIds = new Set([id]);
    } else {
      selectedNodeIds = new Set();
    }
    render();
  }

  function renderProps() {
    if (currentGraph && selectedType === 'node' && selectedNodeIds.size > 1) {
      propsContent.innerHTML = `
        <div class="props-section">
          <h3>Multi-select</h3>
          <p style="color:var(--muted);font-size:0.85rem;margin-bottom:12px">${selectedNodeIds.size} nodes selected</p>
          <div class="props-actions">
            <button class="primary" id="btnGroupFromProps">Create Group</button>
          </div>
        </div>`;
      document.getElementById('btnGroupFromProps').addEventListener('click', () => {
        const label = prompt('Group name:', 'Group');
        if (label === null) return;
        addGroup([...selectedNodeIds], label.trim() || 'Group');
      });
      return;
    }

    if (!currentGraph || !selectedId) {
      propsContent.innerHTML = '<div class="props-empty">Select a node, relationship, or group</div>';
      return;
    }

    if (selectedType === 'node') {
      const node = currentGraph.nodes[selectedId];
      if (!node) {
        propsContent.innerHTML = '<div class="props-empty">Node not found</div>';
        return;
      }
      let html = `
        <div class="props-section">
          <h3>Node</h3>
          <div class="props-row">
            <span class="props-label">ID</span>
            <input type="text" value="${escapeAttr(node.id)}" readonly />
          </div>
          <div class="props-row">
            <span class="props-label">Label</span>
            <input type="text" id="propLabel" value="${escapeAttr(node.label)}" />
          </div>
          <div class="props-row props-row-stack">
            <span class="props-label">Note</span>
            <textarea id="propNote" rows="3" placeholder="Miscellaneous notes…">${escapeHtml(node.note || '')}</textarea>
          </div>
        </div>
        <div class="props-section">
          <h3>Attributes <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">(☐ = hide on graph)</span></h3>
          <div class="attr-list" id="attrList"></div>
          <div class="props-row" style="margin-top:8px">
            <input type="text" id="newAttrKey" placeholder="key" style="flex:1" />
            <input type="text" id="newAttrVal" placeholder="value" style="flex:1" />
            <button id="btnAddAttr">+</button>
          </div>
        </div>
        <div class="props-section" id="inheritedSection">
          <h3>Inherited from groups</h3>
          <div class="attr-list" id="inheritedAttrList"></div>
        </div>
        <div class="props-section">
          <h3>Relationships</h3>
          <div class="rel-list" id="relList"></div>
        </div>
        <div class="props-actions">
          <button class="danger" id="btnDelNode">Delete Node</button>
        </div>
      `;
      propsContent.innerHTML = html;

      const patchNode = (extra) => {
        updateNode(node.id, {
          label: node.label,
          note: node.note || '',
          attributes: node.attributes,
          visibleAttributes: node.visibleAttributes || {},
          attributeOrder: orderedAttrKeys(node),
          position: node.position,
          ...extra
        });
      };

      // inherited group + group attributes (properties pane only — not drawn on node)
      const inheritedList = document.getElementById('inheritedAttrList');
      const inheritedSection = document.getElementById('inheritedSection');
      let inheritedCount = 0;
      for (const grp of Object.values(currentGraph.groups || {})) {
        if (!(grp.nodeIds || []).includes(node.id)) continue;
        // group membership row
        const mem = document.createElement('div');
        mem.className = 'attr-item inherited-item';
        mem.innerHTML = `
          <span class="inherited-badge">group</span>
          <span style="flex:1"><strong>${escapeHtml(grp.label || 'Group')}</strong></span>
          <button type="button" class="btn-icon inherited-goto" data-gid="${escapeAttr(grp.id)}" title="Select group">↗</button>
        `;
        inheritedList.appendChild(mem);
        inheritedCount++;

        for (const k of orderedAttrKeys(grp)) {
          const v = grp.attributes[k];
          const item = document.createElement('div');
          item.className = 'attr-item inherited-item';
          item.innerHTML = `
            <span class="inherited-badge">via ${escapeHtml(grp.label || 'Group')}</span>
            <span class="inherited-key">${escapeHtml(k)}</span>
            <span>:</span>
            <span class="inherited-val" style="flex:1">${escapeHtml(v)}</span>
          `;
          inheritedList.appendChild(item);
          inheritedCount++;
        }
      }
      if (inheritedCount === 0) {
        inheritedSection.style.display = 'none';
      } else {
        inheritedList.querySelectorAll('.inherited-goto').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            select('group', btn.dataset.gid);
          });
        });
      }

      // fill attributes with visibility checkbox + order controls
      const attrList = document.getElementById('attrList');
      const nodeAttrKeys = orderedAttrKeys(node);
      nodeAttrKeys.forEach((k, idx) => {
        const v = node.attributes[k];
        const visible = isAttrVisible(node, k);
        const item = document.createElement('div');
        item.className = 'attr-item';
        item.innerHTML = `
          <span class="attr-order">
            <button type="button" class="btn-icon attr-up" data-key="${escapeAttr(k)}" title="Move up" ${idx === 0 ? 'disabled' : ''}>▲</button>
            <button type="button" class="btn-icon attr-down" data-key="${escapeAttr(k)}" title="Move down" ${idx === nodeAttrKeys.length - 1 ? 'disabled' : ''}>▼</button>
          </span>
          <label class="attr-vis" title="Show on graph node">
            <input type="checkbox" class="attr-visible" ${visible ? 'checked' : ''} data-key="${escapeAttr(k)}" />
          </label>
          <input type="text" class="attr-key" value="${escapeAttr(k)}" data-old="${escapeAttr(k)}" />
          <span>:</span>
          <input type="text" class="attr-val" value="${escapeAttr(v)}" />
          <button class="btn-icon attr-del" data-key="${escapeAttr(k)}">×</button>
        `;
        attrList.appendChild(item);
      });

      // fill relationships
      const relList = document.getElementById('relList');
      for (const edge of Object.values(currentGraph.edges)) {
        if (edge.from !== node.id && edge.to !== node.id) continue;
        const otherId = edge.from === node.id ? edge.to : edge.from;
        const dir = edge.from === node.id ? '→' : '←';
        const item = document.createElement('div');
        item.className = 'rel-item';
        item.innerHTML = `
          <div class="rel-line">
            <span class="rel-dir">${dir}</span>
            <strong>${escapeHtml(edge.label)}</strong>
            <span style="color:var(--muted)">to</span>
            <span>${escapeHtml(endpointLabel(otherId))}</span>
            <button class="btn-icon" data-edge="${edge.id}" style="margin-left:auto">×</button>
          </div>
        `;
        item.addEventListener('click', (e) => {
          if (e.target.classList.contains('btn-icon')) return;
          select('edge', edge.id);
        });
        relList.appendChild(item);
      }
      if (relList.children.length === 0) {
        relList.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">No relationships</div>';
      }

      // events
      document.getElementById('propLabel').addEventListener('change', (e) => {
        patchNode({ label: e.target.value });
      });
      const propNote = document.getElementById('propNote');
      if (propNote) propNote.addEventListener('change', (e) => {
        patchNode({ note: e.target.value });
      });

      document.getElementById('btnAddAttr').addEventListener('click', () => {
        const key = document.getElementById('newAttrKey').value.trim();
        const val = document.getElementById('newAttrVal').value;
        if (!key) return;
        const attrs = { ...(node.attributes || {}), [key]: val };
        const vis = { ...(node.visibleAttributes || {}), [key]: true };
        const order = orderedAttrKeys(node);
        if (!order.includes(key)) order.push(key);
        patchNode({ attributes: attrs, visibleAttributes: vis, attributeOrder: order });
      });

      attrList.querySelectorAll('.attr-del').forEach(btn => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.key;
          const attrs = { ...(node.attributes || {}) };
          delete attrs[key];
          const vis = { ...(node.visibleAttributes || {}) };
          delete vis[key];
          const order = orderedAttrKeys(node).filter(k => k !== key);
          patchNode({ attributes: attrs, visibleAttributes: vis, attributeOrder: order });
        });
      });

      attrList.querySelectorAll('.attr-up').forEach(btn => {
        btn.addEventListener('click', () => {
          const order = moveAttrKey(orderedAttrKeys(node), btn.dataset.key, -1);
          patchNode({ attributeOrder: order });
        });
      });
      attrList.querySelectorAll('.attr-down').forEach(btn => {
        btn.addEventListener('click', () => {
          const order = moveAttrKey(orderedAttrKeys(node), btn.dataset.key, 1);
          patchNode({ attributeOrder: order });
        });
      });

      attrList.querySelectorAll('.attr-visible').forEach(cb => {
        cb.addEventListener('change', () => {
          const key = cb.dataset.key;
          const vis = { ...(node.visibleAttributes || {}) };
          for (const ak of Object.keys(node.attributes || {})) {
            if (!Object.prototype.hasOwnProperty.call(vis, ak)) vis[ak] = true;
          }
          vis[key] = cb.checked;
          patchNode({ visibleAttributes: vis });
        });
      });

      // live edit of existing attrs on change
      attrList.querySelectorAll('.attr-item').forEach(item => {
        const keyInput = item.querySelector('.attr-key');
        const valInput = item.querySelector('.attr-val');
        if (!keyInput || !valInput) return;
        const oldKey = keyInput.dataset.old;
        const commit = () => {
          const newKey = keyInput.value.trim();
          const newVal = valInput.value;
          if (!newKey) return;
          const attrs = { ...(node.attributes || {}) };
          const vis = { ...(node.visibleAttributes || {}) };
          let order = orderedAttrKeys(node);
          if (newKey !== oldKey) {
            delete attrs[oldKey];
            if (Object.prototype.hasOwnProperty.call(vis, oldKey)) {
              vis[newKey] = vis[oldKey];
              delete vis[oldKey];
            }
            order = order.map(k => (k === oldKey ? newKey : k));
            if (!order.includes(newKey)) order.push(newKey);
          }
          attrs[newKey] = newVal;
          patchNode({ attributes: attrs, visibleAttributes: vis, attributeOrder: order });
        };
        keyInput.addEventListener('change', commit);
        valInput.addEventListener('change', commit);
      });

      relList.querySelectorAll('.btn-icon').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteEdge(btn.dataset.edge);
        });
      });

      document.getElementById('btnDelNode').addEventListener('click', () => {
        if (confirm('Delete this node and its relationships?')) {
          deleteNode(node.id);
        }
      });

    } else if (selectedType === 'edge') {
      const edge = currentGraph.edges[selectedId];
      if (!edge) {
        propsContent.innerHTML = '<div class="props-empty">Relationship not found</div>';
        return;
      }
      let html = `
        <div class="props-section">
          <h3>Relationship</h3>
          <div class="props-row">
            <span class="props-label">ID</span>
            <input type="text" value="${escapeAttr(edge.id)}" readonly />
          </div>
          <div class="props-row">
            <span class="props-label">Type</span>
            <input type="text" id="propEdgeLabel" value="${escapeAttr(edge.label)}" />
          </div>
          <div class="props-row">
            <span class="props-label">From</span>
            <input type="text" value="${escapeAttr(endpointLabel(edge.from))}" readonly />
          </div>
          <div class="props-row">
            <span class="props-label">To</span>
            <input type="text" value="${escapeAttr(endpointLabel(edge.to))}" readonly />
          </div>
          <div class="props-row props-row-stack">
            <span class="props-label">Note</span>
            <textarea id="propEdgeNote" rows="3" placeholder="Miscellaneous notes…">${escapeHtml(edge.note || '')}</textarea>
          </div>
        </div>
        <div class="props-section">
          <h3>Attributes</h3>
          <div class="attr-list" id="edgeAttrList"></div>
          <div class="props-row" style="margin-top:8px">
            <input type="text" id="newEdgeAttrKey" placeholder="key" style="flex:1" />
            <input type="text" id="newEdgeAttrVal" placeholder="value" style="flex:1" />
            <button id="btnAddEdgeAttr">+</button>
          </div>
        </div>
        <div class="props-actions">
          <button class="danger" id="btnDelEdge">Delete Relationship</button>
        </div>
      `;
      propsContent.innerHTML = html;

      const attrList = document.getElementById('edgeAttrList');
      for (const [k, v] of Object.entries(edge.attributes || {})) {
        const item = document.createElement('div');
        item.className = 'attr-item';
        item.innerHTML = `
          <input type="text" class="attr-key" value="${escapeAttr(k)}" data-old="${escapeAttr(k)}" />
          <span>:</span>
          <input type="text" class="attr-val" value="${escapeAttr(v)}" />
          <button class="btn-icon" data-key="${escapeAttr(k)}">×</button>
        `;
        attrList.appendChild(item);
      }

      document.getElementById('propEdgeLabel').addEventListener('change', (e) => {
        updateEdge(edge.id, { label: e.target.value, note: edge.note || '', attributes: edge.attributes });
      });
      const propEdgeNote = document.getElementById('propEdgeNote');
      if (propEdgeNote) propEdgeNote.addEventListener('change', (e) => {
        updateEdge(edge.id, { label: edge.label, note: e.target.value, attributes: edge.attributes });
      });

      document.getElementById('btnAddEdgeAttr').addEventListener('click', () => {
        const key = document.getElementById('newEdgeAttrKey').value.trim();
        const val = document.getElementById('newEdgeAttrVal').value;
        if (!key) return;
        const attrs = { ...(edge.attributes || {}), [key]: val };
        updateEdge(edge.id, { label: edge.label, note: edge.note || '', attributes: attrs });
      });

      attrList.querySelectorAll('.btn-icon').forEach(btn => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.key;
          const attrs = { ...(edge.attributes || {}) };
          delete attrs[key];
          updateEdge(edge.id, { label: edge.label, note: edge.note || '', attributes: attrs });
        });
      });

      attrList.querySelectorAll('.attr-item').forEach(item => {
        const keyInput = item.querySelector('.attr-key');
        const valInput = item.querySelector('.attr-val');
        const oldKey = keyInput.dataset.old;
        const commit = () => {
          const newKey = keyInput.value.trim();
          const newVal = valInput.value;
          if (!newKey) return;
          const attrs = { ...(edge.attributes || {}) };
          if (newKey !== oldKey) delete attrs[oldKey];
          attrs[newKey] = newVal;
          updateEdge(edge.id, { label: edge.label, note: edge.note || '', attributes: attrs });
        };
        keyInput.addEventListener('change', commit);
        valInput.addEventListener('change', commit);
      });

      document.getElementById('btnDelEdge').addEventListener('click', () => {
        if (confirm('Delete this relationship?')) {
          deleteEdge(edge.id);
        }
      });
    } else if (selectedType === 'group') {
      const grp = currentGraph.groups[selectedId];
      if (!grp) {
        propsContent.innerHTML = '<div class="props-empty">Group not found</div>';
        return;
      }
      if (!grp.attributes) grp.attributes = {};
      if (!grp.visibleAttributes) grp.visibleAttributes = {};

      let html = `
        <div class="props-section">
          <h3>Group</h3>
          <div class="props-row">
            <span class="props-label">ID</span>
            <input type="text" value="${escapeAttr(grp.id)}" readonly />
          </div>
          <div class="props-row">
            <span class="props-label">Label</span>
            <input type="text" id="propGroupLabel" value="${escapeAttr(grp.label)}" />
          </div>
          <div class="props-row props-row-stack">
            <span class="props-label">Note</span>
            <textarea id="propGroupNote" rows="3" placeholder="Miscellaneous notes…">${escapeHtml(grp.note || '')}</textarea>
          </div>
        </div>
        <div class="props-section">
          <h3>Attributes <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">(☐ = hide on graph)</span></h3>
          <div class="attr-list" id="groupAttrList"></div>
          <div class="props-row" style="margin-top:8px">
            <input type="text" id="newGroupAttrKey" placeholder="key" style="flex:1" />
            <input type="text" id="newGroupAttrVal" placeholder="value" style="flex:1" />
            <button id="btnAddGroupAttr">+</button>
          </div>
        </div>
        <div class="props-section">
          <h3>Members (${(grp.nodeIds || []).length})</h3>
          <div class="rel-list" id="groupMemberList"></div>
        </div>
        <div class="props-section">
          <h3>Relationships</h3>
          <div class="rel-list" id="groupRelList"></div>
        </div>
        <div class="props-actions">
          <button class="danger" id="btnDelGroup">Ungroup / Delete</button>
        </div>
      `;
      propsContent.innerHTML = html;

      const patchGroup = (extra) => {
        updateGroup(grp.id, {
          label: grp.label,
          note: grp.note || '',
          nodeIds: grp.nodeIds,
          attributes: grp.attributes || {},
          visibleAttributes: grp.visibleAttributes || {},
          attributeOrder: orderedAttrKeys(grp),
          color: grp.color,
          ...extra
        });
      };

      const attrList = document.getElementById('groupAttrList');
      const grpAttrKeys = orderedAttrKeys(grp);
      grpAttrKeys.forEach((k, idx) => {
        const v = grp.attributes[k];
        const visible = isAttrVisible(grp, k);
        const item = document.createElement('div');
        item.className = 'attr-item';
        item.innerHTML = `
          <span class="attr-order">
            <button type="button" class="btn-icon attr-up" data-key="${escapeAttr(k)}" title="Move up" ${idx === 0 ? 'disabled' : ''}>▲</button>
            <button type="button" class="btn-icon attr-down" data-key="${escapeAttr(k)}" title="Move down" ${idx === grpAttrKeys.length - 1 ? 'disabled' : ''}>▼</button>
          </span>
          <label class="attr-vis" title="Show on group box">
            <input type="checkbox" class="attr-visible" ${visible ? 'checked' : ''} data-key="${escapeAttr(k)}" />
          </label>
          <input type="text" class="attr-key" value="${escapeAttr(k)}" data-old="${escapeAttr(k)}" />
          <span>:</span>
          <input type="text" class="attr-val" value="${escapeAttr(v)}" />
          <button class="btn-icon attr-del" data-key="${escapeAttr(k)}">×</button>
        `;
        attrList.appendChild(item);
      });

      document.getElementById('btnAddGroupAttr').addEventListener('click', () => {
        const key = document.getElementById('newGroupAttrKey').value.trim();
        const val = document.getElementById('newGroupAttrVal').value;
        if (!key) return;
        const attrs = { ...(grp.attributes || {}), [key]: val };
        const vis = { ...(grp.visibleAttributes || {}), [key]: true };
        const order = orderedAttrKeys(grp);
        if (!order.includes(key)) order.push(key);
        patchGroup({ attributes: attrs, visibleAttributes: vis, attributeOrder: order });
      });

      attrList.querySelectorAll('.attr-del').forEach(btn => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.key;
          const attrs = { ...(grp.attributes || {}) };
          delete attrs[key];
          const vis = { ...(grp.visibleAttributes || {}) };
          delete vis[key];
          const order = orderedAttrKeys(grp).filter(k => k !== key);
          patchGroup({ attributes: attrs, visibleAttributes: vis, attributeOrder: order });
        });
      });

      attrList.querySelectorAll('.attr-up').forEach(btn => {
        btn.addEventListener('click', () => {
          const order = moveAttrKey(orderedAttrKeys(grp), btn.dataset.key, -1);
          patchGroup({ attributeOrder: order });
        });
      });
      attrList.querySelectorAll('.attr-down').forEach(btn => {
        btn.addEventListener('click', () => {
          const order = moveAttrKey(orderedAttrKeys(grp), btn.dataset.key, 1);
          patchGroup({ attributeOrder: order });
        });
      });

      attrList.querySelectorAll('.attr-visible').forEach(cb => {
        cb.addEventListener('change', () => {
          const key = cb.dataset.key;
          const vis = { ...(grp.visibleAttributes || {}) };
          for (const ak of Object.keys(grp.attributes || {})) {
            if (!Object.prototype.hasOwnProperty.call(vis, ak)) vis[ak] = true;
          }
          vis[key] = cb.checked;
          patchGroup({ visibleAttributes: vis });
        });
      });

      attrList.querySelectorAll('.attr-item').forEach(item => {
        const keyInput = item.querySelector('.attr-key');
        const valInput = item.querySelector('.attr-val');
        if (!keyInput || !valInput) return;
        const oldKey = keyInput.dataset.old;
        const commit = () => {
          const newKey = keyInput.value.trim();
          const newVal = valInput.value;
          if (!newKey) return;
          const attrs = { ...(grp.attributes || {}) };
          const vis = { ...(grp.visibleAttributes || {}) };
          let order = orderedAttrKeys(grp);
          if (newKey !== oldKey) {
            delete attrs[oldKey];
            if (Object.prototype.hasOwnProperty.call(vis, oldKey)) {
              vis[newKey] = vis[oldKey];
              delete vis[oldKey];
            }
            order = order.map(k => (k === oldKey ? newKey : k));
            if (!order.includes(newKey)) order.push(newKey);
          }
          attrs[newKey] = newVal;
          patchGroup({ attributes: attrs, visibleAttributes: vis, attributeOrder: order });
        };
        keyInput.addEventListener('change', commit);
        valInput.addEventListener('change', commit);
      });

      const list = document.getElementById('groupMemberList');
      for (const nid of grp.nodeIds || []) {
        const node = currentGraph.nodes[nid];
        const item = document.createElement('div');
        item.className = 'attr-item';
        item.innerHTML = `
          <span style="flex:1">${escapeHtml(node ? node.label : nid)}</span>
          <button class="btn-icon" data-nid="${escapeAttr(nid)}" title="Remove from group">×</button>
        `;
        list.appendChild(item);
      }
      if (!(grp.nodeIds || []).length) {
        list.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">No members</div>';
      }

      document.getElementById('propGroupLabel').addEventListener('change', (e) => {
        patchGroup({ label: e.target.value });
      });
      const propGroupNote = document.getElementById('propGroupNote');
      if (propGroupNote) propGroupNote.addEventListener('change', (e) => {
        patchGroup({ note: e.target.value });
      });

      list.querySelectorAll('.btn-icon').forEach(btn => {
        btn.addEventListener('click', () => {
          const nid = btn.dataset.nid;
          const remaining = (grp.nodeIds || []).filter(id => id !== nid);
          if (remaining.length === 0) {
            deleteGroup(grp.id);
          } else {
            patchGroup({ nodeIds: remaining });
          }
        });
      });

      // Relationships involving this group or its member nodes
      const memberSet = new Set(grp.nodeIds || []);
      const groupRelList = document.getElementById('groupRelList');
      let relCount = 0;
      for (const edge of Object.values(currentGraph.edges || {})) {
        const fromIsGroup = edge.from === grp.id;
        const toIsGroup = edge.to === grp.id;
        const fromIsMember = memberSet.has(edge.from);
        const toIsMember = memberSet.has(edge.to);
        if (!fromIsGroup && !toIsGroup && !fromIsMember && !toIsMember) continue;

        let scope;
        if (fromIsGroup || toIsGroup) scope = 'group';
        else scope = 'member';

        const outbound = fromIsGroup || fromIsMember;
        const dir = outbound ? '→' : '←';
        const otherId = outbound ? edge.to : edge.from;
        // For member edges, show which member; never show the group label
        let memberHint = '';
        if (scope === 'member') {
          const memberId = fromIsMember ? edge.from : edge.to;
          memberHint = `<span style="color:var(--muted)">${escapeHtml(endpointLabel(memberId))}</span>`;
        }

        const item = document.createElement('div');
        item.className = 'rel-item';
        item.innerHTML = `
          <div class="rel-line">
            <span class="inherited-badge">${scope}</span>
            <span class="rel-dir">${dir}</span>
            <strong>${escapeHtml(edge.label)}</strong>
            ${memberHint}
            <span style="color:var(--muted)">to</span>
            <span>${escapeHtml(endpointLabel(otherId))}</span>
            <button class="btn-icon" data-edge="${edge.id}" style="margin-left:auto" title="Delete relationship">×</button>
          </div>
        `;
        item.addEventListener('click', (e) => {
          if (e.target.classList.contains('btn-icon')) return;
          select('edge', edge.id);
        });
        groupRelList.appendChild(item);
        relCount++;
      }
      if (relCount === 0) {
        groupRelList.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">No relationships</div>';
      } else {
        groupRelList.querySelectorAll('.btn-icon').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteEdge(btn.dataset.edge);
          });
        });
      }

      document.getElementById('btnDelGroup').addEventListener('click', () => {
        if (confirm('Delete this group? (nodes are kept)')) {
          deleteGroup(grp.id);
        }
      });
    }
  }

  // --- Dragging ---
  function onNodeMouseDown(e) {
    if (e.button !== 0) return;
    e.stopPropagation();
    // while linking, let the click handler create the edge — don't drag/re-render
    if (linkFromId) return;
    // shift+click is multi-select only (handled on click)
    if (e.shiftKey) return;

    const g = e.currentTarget;
    const id = g.dataset.id;
    const node = currentGraph.nodes[id];
    if (!node) return;

    // keep multi-select if this node is already part of it; otherwise select only this node
    if (!(selectedType === 'node' && selectedNodeIds.has(id) && selectedNodeIds.size > 1)) {
      select('node', id);
    }

    // Drag all currently selected nodes as a group
    const moveIds = (selectedType === 'node' && selectedNodeIds.size > 1 && selectedNodeIds.has(id))
      ? [...selectedNodeIds]
      : [id];

    const origins = {};
    for (const mid of moveIds) {
      const n = currentGraph.nodes[mid];
      if (!n) continue;
      origins[mid] = { x: n.position.x, y: n.position.y };
    }

    dragState = {
      id,
      ids: moveIds,
      origins,
      startX: e.clientX,
      startY: e.clientY
    };
    for (const mid of moveIds) {
      const el = nodesLayer.querySelector(`[data-id="${mid}"]`);
      if (el) el.classList.add('dragging');
    }
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }

  function snapCoord(v) {
    return Math.round(v / GRID_SIZE) * GRID_SIZE;
  }

  function snapPosition(pos) {
    return { x: snapCoord(pos.x), y: snapCoord(pos.y) };
  }

  function onDragMove(e) {
    if (!dragState) return;
    // convert screen delta to world delta
    let dx = (e.clientX - dragState.startX) / viewScale;
    let dy = (e.clientY - dragState.startY) / viewScale;
    for (const mid of dragState.ids) {
      const node = currentGraph.nodes[mid];
      const orig = dragState.origins[mid];
      if (!node || !orig) continue;
      let x = orig.x + dx;
      let y = orig.y + dy;
      if (snapToGrid) {
        x = snapCoord(x);
        y = snapCoord(y);
      }
      node.position.x = x;
      node.position.y = y;
      const el = nodesLayer.querySelector(`[data-id="${mid}"]`);
      if (el) el.setAttribute('transform', `translate(${node.position.x}, ${node.position.y})`);
    }
    // redraw edges and group bounds for the whole selection
    redrawEdgesForNode(dragState.id);
    redrawGroups();
  }

  function redrawGroups() {
    groupsLayer.innerHTML = '';
    for (const grp of Object.values(currentGraph.groups || {})) {
      drawGroup(grp);
    }
  }

  async function onDragEnd() {
    if (!dragState) return;
    const ids = dragState.ids.slice();
    for (const mid of ids) {
      const el = nodesLayer.querySelector(`[data-id="${mid}"]`);
      if (el) el.classList.remove('dragging');
    }
    if (snapToGrid) {
      for (const mid of ids) {
        const node = currentGraph.nodes[mid];
        if (!node) continue;
        node.position = snapPosition(node.position);
        const el = nodesLayer.querySelector(`[data-id="${mid}"]`);
        if (el) el.setAttribute('transform', `translate(${node.position.x}, ${node.position.y})`);
      }
      redrawEdgesForNode(ids[0]);
      redrawGroups();
    }
    const toSave = ids.map(mid => currentGraph.nodes[mid]).filter(Boolean);
    dragState = null;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    // persist all moved nodes
    for (const node of toSave) {
      await updateNode(node.id, {
        label: node.label,
        note: node.note || '',
        attributes: node.attributes,
        visibleAttributes: node.visibleAttributes || {},
        attributeOrder: node.attributeOrder || orderedAttrKeys(node),
        position: node.position
      });
    }
  }

  function redrawEdgesForNode(nodeId) {
    edgesLayer.innerHTML = '';
    drawAllEdges();
  }

  // --- Modal ---
  let modalCallback = null;
  function showModal(title, placeholder, callback) {
    modalTitle.textContent = title;
    modalInput.value = '';
    modalInput.placeholder = placeholder || '';
    modalCallback = callback;
    modal.classList.remove('hidden');
    modalInput.focus();
  }
  function hideModal() {
    modal.classList.add('hidden');
    modalCallback = null;
  }

  // --- Event wiring ---
  graphSelect.addEventListener('change', () => {
    loadGraph(graphSelect.value);
  });

  btnNew.addEventListener('click', () => {
    showModal('New Graph', 'e.g. customers, schema, ...', (name) => {
      if (name) createGraph(name);
    });
  });

  btnSave.addEventListener('click', saveGraph);
  btnDeleteGraph.addEventListener('click', deleteGraph);
  btnAddNode.addEventListener('click', addNode);
  if (btnExportPng) btnExportPng.addEventListener('click', exportGraphPng);
  if (btnDownloadJson) btnDownloadJson.addEventListener('click', downloadGraphJson);
  if (btnUploadJson) btnUploadJson.addEventListener('click', () => {
    if (jsonFileInput) jsonFileInput.click();
  });
  if (jsonFileInput) jsonFileInput.addEventListener('change', uploadGraphJson);

  function downloadGraphJson() {
    if (!currentGraph) {
      alert('No graph loaded');
      return;
    }
    const payload = {
      name: currentGraph.name,
      nodes: currentGraph.nodes || {},
      edges: currentGraph.edges || {},
      groups: currentGraph.groups || {}
    };
    const text = JSON.stringify(payload, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (currentGraph.name || 'graph') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * Validate graph JSON before import. Returns { ok, errors, warnings, graph }.
   * Expected shape matches GraphDB export:
   * {
   *   name?: string,
   *   nodes: { [id]: { id, label, attributes?, visibleAttributes?, attributeOrder?, position: {x,y} } },
   *   edges: { [id]: { id, from, to, label, attributes? } },
   *   groups: { [id]: { id, label, nodeIds, attributes?, ... } }
   * }
   */
  function validateGraphJson(data) {
    const errors = [];
    const warnings = [];

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, errors: ['Root value must be a JSON object'], warnings, graph: null };
    }

    if (data.name != null && typeof data.name !== 'string') {
      errors.push('"name" must be a string when present');
    }

    // Require at least nodes (allow empty graph)
    if (data.nodes == null) {
      errors.push('Missing required "nodes" object');
    } else if (typeof data.nodes !== 'object' || Array.isArray(data.nodes)) {
      errors.push('"nodes" must be an object map of id → node');
    }

    if (data.edges != null && (typeof data.edges !== 'object' || Array.isArray(data.edges))) {
      errors.push('"edges" must be an object map of id → edge');
    }
    if (data.groups != null && (typeof data.groups !== 'object' || Array.isArray(data.groups))) {
      errors.push('"groups" must be an object map of id → group');
    }

    if (errors.length) {
      return { ok: false, errors, warnings, graph: null };
    }

    const nodes = data.nodes || {};
    const edges = data.edges || {};
    const groups = data.groups || {};
    const nodeIds = new Set(Object.keys(nodes));
    const groupIds = new Set(Object.keys(groups));

    // --- Nodes ---
    for (const [key, node] of Object.entries(nodes)) {
      const path = `nodes["${key}"]`;
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        errors.push(`${path} must be an object`);
        continue;
      }
      if (node.id != null && node.id !== key) {
        warnings.push(`${path}.id ("${node.id}") differs from map key; key will be used`);
      }
      if (node.label != null && typeof node.label !== 'string') {
        errors.push(`${path}.label must be a string`);
      }
      if (node.note != null && typeof node.note !== 'string') {
        errors.push(`${path}.note must be a string`);
      }
      if (node.attributes != null) {
        if (typeof node.attributes !== 'object' || Array.isArray(node.attributes)) {
          errors.push(`${path}.attributes must be an object of string→string`);
        } else {
          for (const [ak, av] of Object.entries(node.attributes)) {
            if (typeof av !== 'string' && typeof av !== 'number' && typeof av !== 'boolean') {
              errors.push(`${path}.attributes["${ak}"] must be a string, number, or boolean`);
            }
          }
        }
      }
      if (node.visibleAttributes != null) {
        if (typeof node.visibleAttributes !== 'object' || Array.isArray(node.visibleAttributes)) {
          errors.push(`${path}.visibleAttributes must be an object of string→boolean`);
        }
      }
      if (node.attributeOrder != null) {
        if (!Array.isArray(node.attributeOrder) || node.attributeOrder.some(x => typeof x !== 'string')) {
          errors.push(`${path}.attributeOrder must be an array of strings`);
        }
      }
      if (node.position == null) {
        warnings.push(`${path} has no position; defaulting to {x:0,y:0}`);
      } else if (typeof node.position !== 'object' || Array.isArray(node.position)) {
        errors.push(`${path}.position must be an object {x, y}`);
      } else {
        if (typeof node.position.x !== 'number' || typeof node.position.y !== 'number') {
          errors.push(`${path}.position.x and position.y must be numbers`);
        }
      }
    }

    // --- Edges ---
    for (const [key, edge] of Object.entries(edges)) {
      const path = `edges["${key}"]`;
      if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
        errors.push(`${path} must be an object`);
        continue;
      }
      if (typeof edge.from !== 'string' || !edge.from) {
        errors.push(`${path}.from must be a non-empty string`);
      }
      if (typeof edge.to !== 'string' || !edge.to) {
        errors.push(`${path}.to must be a non-empty string`);
      }
      if (edge.label != null && typeof edge.label !== 'string') {
        errors.push(`${path}.label must be a string`);
      }
      if (edge.note != null && typeof edge.note !== 'string') {
        errors.push(`${path}.note must be a string`);
      }
      if (edge.attributes != null && (typeof edge.attributes !== 'object' || Array.isArray(edge.attributes))) {
        errors.push(`${path}.attributes must be an object`);
      }
      // endpoints must be a node or group
      if (typeof edge.from === 'string' && edge.from) {
        if (!nodeIds.has(edge.from) && !groupIds.has(edge.from)) {
          errors.push(`${path}.from "${edge.from}" is not a node or group id`);
        }
      }
      if (typeof edge.to === 'string' && edge.to) {
        if (!nodeIds.has(edge.to) && !groupIds.has(edge.to)) {
          errors.push(`${path}.to "${edge.to}" is not a node or group id`);
        }
      }
    }

    // --- Groups ---
    for (const [key, grp] of Object.entries(groups)) {
      const path = `groups["${key}"]`;
      if (!grp || typeof grp !== 'object' || Array.isArray(grp)) {
        errors.push(`${path} must be an object`);
        continue;
      }
      if (grp.label != null && typeof grp.label !== 'string') {
        errors.push(`${path}.label must be a string`);
      }
      if (grp.note != null && typeof grp.note !== 'string') {
        errors.push(`${path}.note must be a string`);
      }
      if (grp.nodeIds == null) {
        errors.push(`${path}.nodeIds is required (array of node ids)`);
      } else if (!Array.isArray(grp.nodeIds)) {
        errors.push(`${path}.nodeIds must be an array`);
      } else {
        for (let i = 0; i < grp.nodeIds.length; i++) {
          const nid = grp.nodeIds[i];
          if (typeof nid !== 'string') {
            errors.push(`${path}.nodeIds[${i}] must be a string`);
          } else if (!nodeIds.has(nid)) {
            errors.push(`${path}.nodeIds[${i}] "${nid}" is not a known node id`);
          }
        }
      }
      if (grp.attributes != null && (typeof grp.attributes !== 'object' || Array.isArray(grp.attributes))) {
        errors.push(`${path}.attributes must be an object`);
      }
      if (grp.attributeOrder != null) {
        if (!Array.isArray(grp.attributeOrder) || grp.attributeOrder.some(x => typeof x !== 'string')) {
          errors.push(`${path}.attributeOrder must be an array of strings`);
        }
      }
    }

    if (errors.length) {
      return { ok: false, errors, warnings, graph: null };
    }

    // Normalize for import (ensure ids on objects, stringify attr values, default position)
    const normNodes = {};
    for (const [key, node] of Object.entries(nodes)) {
      const attrs = {};
      if (node.attributes) {
        for (const [ak, av] of Object.entries(node.attributes)) {
          attrs[ak] = String(av);
        }
      }
      normNodes[key] = {
        id: key,
        label: node.label != null ? String(node.label) : 'Entity',
        note: node.note != null ? String(node.note) : '',
        attributes: attrs,
        visibleAttributes: node.visibleAttributes || {},
        attributeOrder: Array.isArray(node.attributeOrder) ? node.attributeOrder.slice() : Object.keys(attrs),
        position: {
          x: node.position && typeof node.position.x === 'number' ? node.position.x : 0,
          y: node.position && typeof node.position.y === 'number' ? node.position.y : 0
        }
      };
    }
    const normEdges = {};
    for (const [key, edge] of Object.entries(edges)) {
      const attrs = {};
      if (edge.attributes) {
        for (const [ak, av] of Object.entries(edge.attributes)) {
          attrs[ak] = String(av);
        }
      }
      normEdges[key] = {
        id: key,
        from: edge.from,
        to: edge.to,
        label: edge.label != null ? String(edge.label) : 'relates',
        note: edge.note != null ? String(edge.note) : '',
        attributes: attrs
      };
    }
    const normGroups = {};
    for (const [key, grp] of Object.entries(groups)) {
      const attrs = {};
      if (grp.attributes) {
        for (const [ak, av] of Object.entries(grp.attributes)) {
          attrs[ak] = String(av);
        }
      }
      normGroups[key] = {
        id: key,
        label: grp.label != null ? String(grp.label) : 'Group',
        note: grp.note != null ? String(grp.note) : '',
        nodeIds: (grp.nodeIds || []).slice(),
        attributes: attrs,
        visibleAttributes: grp.visibleAttributes || {},
        attributeOrder: Array.isArray(grp.attributeOrder) ? grp.attributeOrder.slice() : Object.keys(attrs),
        color: grp.color || ''
      };
    }

    return {
      ok: true,
      errors: [],
      warnings,
      graph: {
        name: typeof data.name === 'string' ? data.name : '',
        nodes: normNodes,
        edges: normEdges,
        groups: normGroups
      }
    };
  }

  async function uploadGraphJson(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = ''; // allow re-uploading same file
    if (!file) return;
    let data;
    try {
      const text = await file.text();
      data = JSON.parse(text);
    } catch (e) {
      alert('Invalid JSON syntax:\n' + e.message);
      return;
    }

    const result = validateGraphJson(data);
    if (!result.ok) {
      const msg = 'Graph JSON validation failed:\n\n• ' + result.errors.slice(0, 15).join('\n• ')
        + (result.errors.length > 15 ? `\n…and ${result.errors.length - 15} more` : '');
      alert(msg);
      return;
    }
    if (result.warnings.length) {
      const wmsg = 'Warnings:\n\n• ' + result.warnings.slice(0, 8).join('\n• ')
        + (result.warnings.length > 8 ? `\n…and ${result.warnings.length - 8} more` : '')
        + '\n\nContinue import?';
      if (!confirm(wmsg)) return;
    }

    const { nodes, edges, groups } = result.graph;
    let name = (result.graph.name || file.name.replace(/\.json$/i, '') || 'imported').trim();
    name = prompt('Import as graph name:', name);
    if (name === null) return;
    name = name.trim();
    if (!name) {
      alert('Name required');
      return;
    }

    try {
      const list = await api('GET', '/api/graphs');
      if (!list.includes(name)) {
        await api('POST', '/api/graphs', { name });
      } else {
        if (!confirm(`Graph "${name}" already exists. Overwrite?`)) return;
      }
      await api('PUT', `/api/graphs/${encodeURIComponent(name)}`, {
        name,
        nodes,
        edges,
        groups
      });
      await refreshGraphList();
      graphSelect.value = name;
      await loadGraph(name);
      alert('Graph imported: ' + name);
    } catch (e) {
      alert('Import failed: ' + e.message);
    }
  }
  async function exportGraphPng() {
    if (!currentGraph) {
      alert('No graph loaded');
      return;
    }

    // Content bounds in world coordinates
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasContent = false;
    for (const node of Object.values(currentGraph.nodes || {})) {
      hasContent = true;
      const h = nodeHeight(node);
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + NODE_W);
      maxY = Math.max(maxY, node.position.y + h);
    }
    for (const grp of Object.values(currentGraph.groups || {})) {
      const b = groupBounds(grp);
      if (!b) continue;
      hasContent = true;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    if (!hasContent) {
      alert('Graph is empty');
      return;
    }

    const pad = 40;
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
    const width = Math.max(100, maxX - minX);
    const height = Math.max(100, maxY - minY);

    // Clone SVG and strip viewport pan/zoom for a full-content export
    const clone = graphSvg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(Math.ceil(width)));
    clone.setAttribute('height', String(Math.ceil(height)));
    clone.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
    clone.style.background = '#0b1220';

    const vp = clone.querySelector('#viewport');
    if (vp) vp.removeAttribute('transform');

    // Inline styles so the PNG doesn't depend on external CSS
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `
      .node-rect { fill: #1e293b; stroke: #475569; stroke-width: 1.5; }
      .node-header { fill: #334155; }
      .node-title { fill: #e2e8f0; font-size: 13px; font-weight: 600; font-family: Segoe UI, system-ui, sans-serif; }
      .node-attr { fill: #94a3b8; font-size: 11px; font-family: Segoe UI, system-ui, sans-serif; }
      .node-id { fill: #64748b; font-size: 9px; font-family: Segoe UI, system-ui, sans-serif; }
      .node-group.selected .node-rect { stroke: #3b82f6; stroke-width: 2.5; }
      .edge-path { fill: none; stroke: #64748b; stroke-width: 1.5; marker-end: url(#arrowhead); }
      .edge-path-stem { fill: none; stroke: #64748b; stroke-width: 1.5; }
      .edge-label { fill: #94a3b8; font-size: 11px; font-family: Segoe UI, system-ui, sans-serif; }
      .edge-label-bg { fill: #0b1220; }
      .edge-hit { fill: none; stroke: transparent; }
      .fork-junction { fill: #64748b; stroke: #0b1220; stroke-width: 1; }
      .group-box { fill: rgba(59,130,246,0.08); stroke: #3b82f6; stroke-width: 1.5; stroke-dasharray: 6 4; }
      .group-box.selected { fill: rgba(59,130,246,0.16); stroke: #60a5fa; stroke-width: 2.5; stroke-dasharray: none; }
      .group-label { fill: #93c5fd; font-size: 12px; font-weight: 600; font-family: Segoe UI, system-ui, sans-serif; }
      .group-attr { fill: #94a3b8; font-size: 10px; font-family: Segoe UI, system-ui, sans-serif; }
      .group-label-bg { fill: #0b1220; opacity: 0.85; }
    `;
    clone.insertBefore(style, clone.firstChild);

    // Background rect behind content
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', String(minX));
    bg.setAttribute('y', String(minY));
    bg.setAttribute('width', String(width));
    bg.setAttribute('height', String(height));
    bg.setAttribute('fill', '#0b1220');
    const firstG = clone.querySelector('#viewport') || clone.querySelector('g');
    if (firstG) clone.insertBefore(bg, firstG);
    else clone.appendChild(bg);

    const serializer = new XMLSerializer();
    const svgText = serializer.serializeToString(clone);
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });

      const scale = 2; // retina-ish
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0b1220';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);

      const pngUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = pngUrl;
      a.download = (currentGraph.name || 'graph') + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      alert('Export failed: ' + (err && err.message ? err.message : err));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  btnAddEdge.addEventListener('click', () => {
    if (!currentGraph) {
      alert('Select a graph first');
      return;
    }
    // toggle off if already linking
    if (linkFromId) {
      cancelLinkMode();
      render();
      return;
    }
    if (!selectedId || (selectedType !== 'node' && selectedType !== 'group')) {
      alert('Select a source node or group first, then click + Rel, then click the target node or group.');
      return;
    }
    linkFromId = selectedId;
    document.body.classList.add('linking');
    btnAddEdge.textContent = 'Cancel Rel';
    btnAddEdge.classList.add('primary');
    render();
  });

  btnGroup.addEventListener('click', () => {
    if (!currentGraph) {
      alert('Select a graph first');
      return;
    }
    const ids = selectedNodeIds.size
      ? [...selectedNodeIds]
      : (selectedType === 'node' && selectedId ? [selectedId] : []);
    if (ids.length < 1) {
      alert('Select one or more nodes first (Shift+click to multi-select), then click Group.');
      return;
    }
    const label = prompt('Group name:', 'Group');
    if (label === null) return;
    addGroup(ids, label.trim() || 'Group');
  });

  // Escape cancels link mode
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && linkFromId) {
      cancelLinkMode();
      render();
    }
  });

  btnDeleteSelected.addEventListener('click', () => {
    if (selectedType === 'group' && selectedId) {
      if (confirm('Delete this group? (nodes are kept)')) deleteGroup(selectedId);
      return;
    }
    if (selectedType === 'node' && selectedNodeIds.size > 1) {
      if (confirm(`Delete ${selectedNodeIds.size} selected nodes?`)) {
        const ids = [...selectedNodeIds];
        (async () => {
          for (const id of ids) await deleteNode(id);
        })();
      }
      return;
    }
    if (!selectedId) return;
    if (selectedType === 'node') {
      if (confirm('Delete selected node and its relationships?')) deleteNode(selectedId);
    } else if (selectedType === 'edge') {
      if (confirm('Delete selected relationship?')) deleteEdge(selectedId);
    }
  });

  // click on empty canvas deselects / cancels link mode
  graphSvg.addEventListener('click', (e) => {
    if (panState && panState.moved) return; // ignore click after pan
    if (e.target === graphSvg || e.target.id === 'viewport' || e.target.id === 'edgesLayer' || e.target.id === 'nodesLayer' || e.target.id === 'groupsLayer') {
      if (linkFromId) {
        cancelLinkMode();
      }
      clearSelection();
      render();
    }
  });

  // Pan: drag on empty background (or middle mouse / space held)
  graphSvg.addEventListener('mousedown', (e) => {
    if (linkFromId) return;
    const onBackground = e.target === graphSvg || e.target.id === 'viewport' || e.target.id === 'edgesLayer' || e.target.id === 'groupsLayer' || e.target.id === 'nodesLayer';
    const middle = e.button === 1;
    const leftOnBg = e.button === 0 && onBackground;
    if (!middle && !leftOnBg) return;
    e.preventDefault();
    panState = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: viewX,
      origY: viewY,
      moved: false
    };
    graphSvg.classList.add('panning');
    document.addEventListener('mousemove', onPanMove);
    document.addEventListener('mouseup', onPanEnd);
  });

  function onPanMove(e) {
    if (!panState) return;
    const dx = e.clientX - panState.startClientX;
    const dy = e.clientY - panState.startClientY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panState.moved = true;
    viewX = panState.origX + dx;
    viewY = panState.origY + dy;
    applyViewport();
  }

  function onPanEnd() {
    graphSvg.classList.remove('panning');
    document.removeEventListener('mousemove', onPanMove);
    document.removeEventListener('mouseup', onPanEnd);
    // keep panState briefly so click handler can see .moved
    setTimeout(() => { panState = null; }, 0);
  }

  // Wheel zoom (toward cursor)
  graphSvg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom(viewScale * factor, e.clientX, e.clientY);
  }, { passive: false });

  if (btnZoomIn) btnZoomIn.addEventListener('click', () => setZoom(viewScale * 1.2));
  if (btnZoomOut) btnZoomOut.addEventListener('click', () => setZoom(viewScale / 1.2));

  try {
    snapToGrid = localStorage.getItem('graphdb-snap') === '1';
  } catch (_) {}
  if (chkSnapGrid) {
    chkSnapGrid.checked = snapToGrid;
    chkSnapGrid.addEventListener('change', () => {
      snapToGrid = chkSnapGrid.checked;
      try { localStorage.setItem('graphdb-snap', snapToGrid ? '1' : '0'); } catch (_) {}
      const pane = document.getElementById('graphPane');
      if (pane) pane.classList.toggle('snap-grid', snapToGrid);
    });
    const pane = document.getElementById('graphPane');
    if (snapToGrid && pane) pane.classList.add('snap-grid');
  }
  if (btnSnapAll) {
    btnSnapAll.addEventListener('click', async () => {
      if (!currentGraph) return;
      const nodes = Object.values(currentGraph.nodes || {});
      if (!nodes.length) return;
      btnSnapAll.disabled = true;
      try {
        for (const node of nodes) {
          node.position = snapPosition(node.position);
        }
        render();
        for (const node of nodes) {
          await updateNode(node.id, {
            label: node.label,
            note: node.note || '',
            attributes: node.attributes,
            visibleAttributes: node.visibleAttributes || {},
            attributeOrder: node.attributeOrder || orderedAttrKeys(node),
            position: node.position
          });
        }
      } finally {
        btnSnapAll.disabled = false;
      }
    });
  }
  if (btnZoomReset) btnZoomReset.addEventListener('click', () => {
    viewScale = 1;
    viewX = 0;
    viewY = 0;
    applyViewport();
  });

  // apply saved viewport on load
  applyViewport();

  modalCancel.addEventListener('click', hideModal);
  modalConfirm.addEventListener('click', () => {
    const val = modalInput.value.trim();
    if (modalCallback) modalCallback(val);
    hideModal();
  });
  modalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') modalConfirm.click();
    if (e.key === 'Escape') hideModal();
  });

  // --- Pane resizer ---
  const MIN_RIGHT = 200;
  const MIN_LEFT = 200;

  function applyPaneWidth(px) {
    const max = window.innerWidth - MIN_LEFT - 5;
    const w = Math.max(MIN_RIGHT, Math.min(max, px));
    propsPane.style.width = w + 'px';
    try { localStorage.setItem('graphdb-props-width', String(w)); } catch (_) {}
  }

  // restore saved width
  try {
    const saved = parseInt(localStorage.getItem('graphdb-props-width'), 10);
    if (saved && saved >= MIN_RIGHT) applyPaneWidth(saved);
  } catch (_) {}

  let resizeState = null;
  paneResizer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizeState = {
      startX: e.clientX,
      startWidth: propsPane.getBoundingClientRect().width
    };
    paneResizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeEnd);
  });

  function onResizeMove(e) {
    if (!resizeState) return;
    // dragging left increases right pane width (resizer is on the left of the right pane)
    const dx = resizeState.startX - e.clientX;
    applyPaneWidth(resizeState.startWidth + dx);
  }

  function onResizeEnd() {
    resizeState = null;
    paneResizer.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeEnd);
  }

  // --- Utils ---
  function escapeAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }


  // --- Report / structured query ---
  let lastReportRows = [];

  function openReportModal() {
    if (!currentGraph) {
      alert('Select or create a graph first');
      return;
    }
    const modal = document.getElementById('reportModal');
    if (!modal) return;
    // populate attribute key suggestions
    const keys = new Set();
    for (const n of Object.values(currentGraph.nodes || {})) {
      Object.keys(n.attributes || {}).forEach(k => keys.add(k));
    }
    for (const e of Object.values(currentGraph.edges || {})) {
      Object.keys(e.attributes || {}).forEach(k => keys.add(k));
    }
    for (const g of Object.values(currentGraph.groups || {})) {
      Object.keys(g.attributes || {}).forEach(k => keys.add(k));
    }
    const dl = document.getElementById('reportAttrKeyList');
    if (dl) {
      dl.innerHTML = '';
      [...keys].sort().forEach(k => {
        const opt = document.createElement('option');
        opt.value = k;
        dl.appendChild(opt);
      });
    }
    modal.classList.remove('hidden');
    // Show everything by default when opening
    runReportQuery();
  }

  function closeReportModal() {
    const modal = document.getElementById('reportModal');
    if (modal) modal.classList.add('hidden');
  }

  function attrMatch(attrs, key, val, mode) {
    attrs = attrs || {};
    const k = (key || '').trim();
    if (!k) {
      // no attr filter
      return true;
    }
    if (mode === 'exists') {
      return Object.prototype.hasOwnProperty.call(attrs, k);
    }
    if (!Object.prototype.hasOwnProperty.call(attrs, k)) return false;
    const av = String(attrs[k] ?? '');
    const needle = String(val ?? '');
    if (mode === 'equals') return av === needle;
    // contains (default)
    if (!needle) return true; // key exists, any value
    return av.toLowerCase().includes(needle.toLowerCase());
  }

  function labelMatch(label, filter) {
    const f = (filter || '').trim().toLowerCase();
    if (!f) return true;
    return String(label || '').toLowerCase().includes(f);
  }

  function formatAttrs(attrs) {
    const a = attrs || {};
    const keys = Object.keys(a);
    if (!keys.length) return '';
    return keys.map(k => k + ': ' + a[k]).join('\n');
  }

  function runReportQuery() {
    if (!currentGraph) {
      alert('No graph loaded');
      return;
    }
    const type = (document.getElementById('reportType') || {}).value || 'all';
    const labelF = (document.getElementById('reportLabel') || {}).value || '';
    const attrKey = (document.getElementById('reportAttrKey') || {}).value || '';
    const attrVal = (document.getElementById('reportAttrVal') || {}).value || '';
    const attrMode = (document.getElementById('reportAttrMatch') || {}).value || 'contains';

    const rows = [];

    if (type === 'all' || type === 'node') {
      for (const n of Object.values(currentGraph.nodes || {})) {
        if (!labelMatch(n.label, labelF)) continue;
        if (!attrMatch(n.attributes, attrKey, attrVal, attrMode)) continue;
        rows.push({
          type: 'node',
          id: n.id,
          label: n.label || '',
          attributes: { ...(n.attributes || {}) },
          note: n.note || '',
          extra: ''
        });
      }
    }
    if (type === 'all' || type === 'edge') {
      for (const e of Object.values(currentGraph.edges || {})) {
        if (!labelMatch(e.label, labelF)) continue;
        if (!attrMatch(e.attributes, attrKey, attrVal, attrMode)) continue;
        rows.push({
          type: 'edge',
          id: e.id,
          label: e.label || '',
          attributes: { ...(e.attributes || {}) },
          note: e.note || '',
          extra: endpointLabel(e.from) + ' → ' + endpointLabel(e.to)
        });
      }
    }
    if (type === 'all' || type === 'group') {
      for (const g of Object.values(currentGraph.groups || {})) {
        if (!labelMatch(g.label, labelF)) continue;
        if (!attrMatch(g.attributes, attrKey, attrVal, attrMode)) continue;
        rows.push({
          type: 'group',
          id: g.id,
          label: g.label || '',
          attributes: { ...(g.attributes || {}) },
          note: g.note || '',
          extra: ((g.nodeIds || []).length) + ' members'
        });
      }
    }

    // stable sort: type then label
    rows.sort((a, b) => (a.type + a.label).localeCompare(b.type + b.label));
    lastReportRows = rows;
    renderReportTable(rows);
  }

  function renderReportTable(rows) {
    const body = document.getElementById('reportBody');
    const count = document.getElementById('reportCount');
    if (count) count.textContent = rows.length + ' result' + (rows.length === 1 ? '' : 's');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" class="report-empty">No matches</td></tr>';
      return;
    }
    body.innerHTML = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="report-type-badge ${row.type}">${row.type}</span></td>
        <td>
          <strong>${escapeHtml(row.label)}</strong>
          ${row.extra ? '<div style="color:var(--muted);font-size:0.75rem;margin-top:2px">' + escapeHtml(row.extra) + '</div>' : ''}
        </td>
        <td style="color:var(--muted);font-size:0.75rem;max-width:100px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(row.id)}</td>
        <td class="report-attrs">${escapeHtml(formatAttrs(row.attributes))}</td>
        <td style="max-width:160px;white-space:pre-wrap;word-break:break-word">${escapeHtml(row.note)}</td>
        <td><button type="button" class="btn-icon report-goto" data-type="${row.type}" data-id="${escapeAttr(row.id)}" title="Select in graph">↗</button></td>
      `;
      body.appendChild(tr);
    }
    body.querySelectorAll('.report-goto').forEach(btn => {
      btn.addEventListener('click', () => {
        const typ = btn.dataset.type;
        const id = btn.dataset.id;
        closeReportModal();
        select(typ, id);
        render();
      });
    });
  }

  function exportReportCsv() {
    if (!lastReportRows.length) {
      alert('Run a query first');
      return;
    }
    const esc = (v) => {
      const s = String(v ?? '');
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const lines = ['type,label,id,attributes,note,extra'];
    for (const r of lastReportRows) {
      lines.push([
        esc(r.type),
        esc(r.label),
        esc(r.id),
        esc(formatAttrs(r.attributes).replace(/\n/g, '; ')),
        esc(r.note),
        esc(r.extra)
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (currentGraph && currentGraph.name ? currentGraph.name : 'report') + '-report.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportReportJson() {
    if (!lastReportRows.length) {
      alert('Run a query first');
      return;
    }
    const payload = {
      graph: currentGraph ? currentGraph.name : '',
      generatedAt: new Date().toISOString(),
      count: lastReportRows.length,
      results: lastReportRows
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (currentGraph && currentGraph.name ? currentGraph.name : 'report') + '-report.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (btnReport) btnReport.addEventListener('click', openReportModal);

  // Event delegation so handlers work even if modal markup loads later
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.id === 'reportClose' || t.closest('#reportClose')) {
      e.preventDefault();
      e.stopPropagation();
      closeReportModal();
      return;
    }
    if (t.id === 'reportRun' || t.closest('#reportRun')) {
      e.preventDefault();
      runReportQuery();
      return;
    }
    if (t.id === 'reportExportCsv' || t.closest('#reportExportCsv')) {
      e.preventDefault();
      exportReportCsv();
      return;
    }
    if (t.id === 'reportExportJson' || t.closest('#reportExportJson')) {
      e.preventDefault();
      exportReportJson();
      return;
    }
    // backdrop click
    if (t.id === 'reportModal') {
      closeReportModal();
    }
  });

  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('reportModal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      closeReportModal();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'TEXTAREA') return;
      e.preventDefault();
      runReportQuery();
    }
  });


  // Report panel resize
  (function initReportResize() {
    let rs = null; // { mode, startX, startY, startW, startH }

    function panel() {
      return document.getElementById('reportPanel');
    }

    function applySavedSize() {
      const p = panel();
      if (!p) return;
      try {
        const saved = JSON.parse(localStorage.getItem('graphdb-report-size') || 'null');
        if (saved && saved.w) p.style.width = saved.w + 'px';
        if (saved && saved.h) p.style.height = saved.h + 'px';
      } catch (_) {}
    }

    function saveSize() {
      const p = panel();
      if (!p) return;
      try {
        localStorage.setItem('graphdb-report-size', JSON.stringify({
          w: Math.round(p.getBoundingClientRect().width),
          h: Math.round(p.getBoundingClientRect().height)
        }));
      } catch (_) {}
    }

    function onMove(e) {
      if (!rs) return;
      const p = panel();
      if (!p) return;
      const dx = e.clientX - rs.startX;
      const dy = e.clientY - rs.startY;
      if (rs.mode === 'e' || rs.mode === 'se') {
        const w = Math.min(window.innerWidth * 0.98, Math.max(420, rs.startW + dx));
        p.style.width = w + 'px';
      }
      if (rs.mode === 's' || rs.mode === 'se') {
        const h = Math.min(window.innerHeight * 0.96, Math.max(320, rs.startH + dy));
        p.style.height = h + 'px';
      }
    }

    function onUp() {
      if (!rs) return;
      const p = panel();
      if (p) p.classList.remove('resizing');
      saveSize();
      rs = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    function start(mode, e) {
      const p = panel();
      if (!p) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = p.getBoundingClientRect();
      rs = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        startW: rect.width,
        startH: rect.height
      };
      p.classList.add('resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    document.addEventListener('mousedown', (e) => {
      const t = e.target;
      if (!t || !t.id) return;
      if (t.id === 'reportResizeE') start('e', e);
      else if (t.id === 'reportResizeS') start('s', e);
      else if (t.id === 'reportResizeSE') start('se', e);
    });

    // apply when opening
    const _open = openReportModal;
    openReportModal = function () {
      _open();
      applySavedSize();
    };
  })();

  // --- Init ---
  refreshGraphList().then(() => {
    // if any graphs exist, select the first
    if (graphSelect.options.length > 1) {
      graphSelect.selectedIndex = 1;
      loadGraph(graphSelect.value);
    }
  });
})();
