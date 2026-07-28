package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"embed"
)

//go:embed static/*
var staticFS embed.FS

// --- Data Model ---

type Position struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type Node struct {
	ID                string            `json:"id"`
	Label             string            `json:"label"`
	Note              string            `json:"note,omitempty"`
	Attributes        map[string]string `json:"attributes"`
	VisibleAttributes map[string]bool   `json:"visibleAttributes,omitempty"`
	AttributeOrder    []string          `json:"attributeOrder,omitempty"`
	Position          Position          `json:"position"`
}

type Edge struct {
	ID         string            `json:"id"`
	From       string            `json:"from"`
	To         string            `json:"to"`
	Label      string            `json:"label"`
	Note       string            `json:"note,omitempty"`
	Attributes map[string]string `json:"attributes"`
}

type Group struct {
	ID                string            `json:"id"`
	Label             string            `json:"label"`
	Note              string            `json:"note,omitempty"`
	NodeIDs           []string          `json:"nodeIds"`
	Attributes        map[string]string `json:"attributes,omitempty"`
	VisibleAttributes map[string]bool   `json:"visibleAttributes,omitempty"`
	AttributeOrder    []string          `json:"attributeOrder,omitempty"`
	Color             string            `json:"color,omitempty"`
}

type Graph struct {
	Name   string            `json:"name"`
	Nodes  map[string]*Node  `json:"nodes"`
	Edges  map[string]*Edge  `json:"edges"`
	Groups map[string]*Group `json:"groups"`
}

type Store struct {
	mu     sync.RWMutex
	graphs map[string]*Graph // name -> graph
	dir    string
}

func NewStore(dir string) *Store {
	os.MkdirAll(dir, 0755)
	s := &Store{
		graphs: make(map[string]*Graph),
		dir:    dir,
	}
	s.loadAll()
	return s
}

func (s *Store) loadAll() {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".json")
		data, err := os.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			continue
		}
		var g Graph
		if err := json.Unmarshal(data, &g); err != nil {
			continue
		}
		if g.Nodes == nil {
			g.Nodes = make(map[string]*Node)
		}
		if g.Edges == nil {
			g.Edges = make(map[string]*Edge)
		}
		if g.Groups == nil {
			g.Groups = make(map[string]*Group)
		}
		g.Name = name
		s.graphs[name] = &g
	}
}

func (s *Store) save(name string) error {
	s.mu.RLock()
	g, ok := s.graphs[name]
	s.mu.RUnlock()
	if !ok {
		return fmt.Errorf("graph not found")
	}
	data, err := json.MarshalIndent(g, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.dir, name+".json"), data, 0644)
}

func (s *Store) create(name string) (*Graph, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.graphs[name]; exists {
		return nil, fmt.Errorf("graph already exists")
	}
	g := &Graph{
		Name:   name,
		Nodes:  make(map[string]*Node),
		Edges:  make(map[string]*Edge),
		Groups: make(map[string]*Group),
	}
	s.graphs[name] = g
	return g, nil
}

func (s *Store) get(name string) (*Graph, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	g, ok := s.graphs[name]
	return g, ok
}

func (s *Store) list() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, 0, len(s.graphs))
	for n := range s.graphs {
		names = append(names, n)
	}
	return names
}

func (s *Store) delete(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.graphs[name]; !ok {
		return fmt.Errorf("not found")
	}
	delete(s.graphs, name)
	os.Remove(filepath.Join(s.dir, name+".json"))
	return nil
}

// --- HTTP Handlers ---

type Server struct {
	store *Store
}

func (srv *Server) listGraphs(w http.ResponseWriter, r *http.Request) {
	names := srv.store.list()
	writeJSON(w, names)
}

func (srv *Server) createGraph(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		http.Error(w, "invalid name", 400)
		return
	}
	req.Name = sanitizeName(req.Name)
	g, err := srv.store.create(req.Name)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	srv.store.save(req.Name)
	writeJSON(w, g)
}

func (srv *Server) getGraph(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	g, ok := srv.store.get(name)
	if !ok {
		http.Error(w, "not found", 404)
		return
	}
	writeJSON(w, g)
}

func (srv *Server) saveGraph(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var g Graph
	if err := json.NewDecoder(r.Body).Decode(&g); err != nil {
		http.Error(w, "invalid body", 400)
		return
	}
	g.Name = name
	if g.Nodes == nil {
		g.Nodes = make(map[string]*Node)
	}
	if g.Edges == nil {
		g.Edges = make(map[string]*Edge)
	}
	if g.Groups == nil {
		g.Groups = make(map[string]*Group)
	}
	srv.store.mu.Lock()
	srv.store.graphs[name] = &g
	srv.store.mu.Unlock()
	if err := srv.store.save(name); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, map[string]string{"status": "saved"})
}

func (srv *Server) deleteGraph(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := srv.store.delete(name); err != nil {
		http.Error(w, err.Error(), 404)
		return
	}
	writeJSON(w, map[string]string{"status": "deleted"})
}

// Node CRUD
func (srv *Server) createNode(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	g, ok := srv.store.get(name)
	if !ok {
		http.Error(w, "graph not found", 404)
		return
	}
	var req struct {
		Label             string            `json:"label"`
		Note              string            `json:"note"`
		Attributes        map[string]string `json:"attributes"`
		VisibleAttributes map[string]bool   `json:"visibleAttributes"`
		AttributeOrder    []string          `json:"attributeOrder"`
		Position          Position          `json:"position"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", 400)
		return
	}
	if req.Label == "" {
		req.Label = "Node"
	}
	if req.Attributes == nil {
		req.Attributes = make(map[string]string)
	}
	id := fmt.Sprintf("n%d", time.Now().UnixNano())
	node := &Node{
		ID:                id,
		Label:             req.Label,
		Note:              req.Note,
		Attributes:        req.Attributes,
		VisibleAttributes: req.VisibleAttributes,
		AttributeOrder:    req.AttributeOrder,
		Position:          req.Position,
	}
	if node.Position.X == 0 && node.Position.Y == 0 {
		// default position based on count
		count := len(g.Nodes)
		node.Position = Position{X: 50 + float64(count%5)*180, Y: 50 + float64(count/5)*140}
	}
	srv.store.mu.Lock()
	g.Nodes[id] = node
	srv.store.mu.Unlock()
	srv.store.save(name)
	writeJSON(w, node)
}

func (srv *Server) updateNode(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	nodeID := r.PathValue("id")
	g, ok := srv.store.get(name)
	if !ok {
		http.Error(w, "graph not found", 404)
		return
	}
	srv.store.mu.Lock()
	node, ok := g.Nodes[nodeID]
	if !ok {
		srv.store.mu.Unlock()
		http.Error(w, "node not found", 404)
		return
	}
	var req Node
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		srv.store.mu.Unlock()
		http.Error(w, "bad request", 400)
		return
	}
	if req.Label != "" {
		node.Label = req.Label
	}
	if req.Attributes != nil {
		node.Attributes = req.Attributes
	}
	// always accept visibleAttributes when provided (including empty map)
	if req.VisibleAttributes != nil {
		node.VisibleAttributes = req.VisibleAttributes
	}
	if req.AttributeOrder != nil {
		node.AttributeOrder = req.AttributeOrder
	}
	// Note always applied (allows clearing)
	node.Note = req.Note
	if req.Position.X != 0 || req.Position.Y != 0 {
		node.Position = req.Position
	}
	srv.store.mu.Unlock()
	srv.store.save(name)
	writeJSON(w, node)
}

func (srv *Server) deleteNode(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	nodeID := r.PathValue("id")
	g, ok := srv.store.get(name)
	if !ok {
		http.Error(w, "graph not found", 404)
		return
	}
	srv.store.mu.Lock()
	if _, ok := g.Nodes[nodeID]; !ok {
		srv.store.mu.Unlock()
		http.Error(w, "node not found", 404)
		return
	}
	delete(g.Nodes, nodeID)
	// remove connected edges
	for eid, e := range g.Edges {
		if e.From == nodeID || e.To == nodeID {
			delete(g.Edges, eid)
		}
	}
	// remove from groups; drop empty groups
	for gid, grp := range g.Groups {
		filtered := make([]string, 0, len(grp.NodeIDs))
		for _, nid := range grp.NodeIDs {
			if nid != nodeID {
				filtered = append(filtered, nid)
			}
		}
		if len(filtered) == 0 {
			delete(g.Groups, gid)
		} else {
			grp.NodeIDs = filtered
		}
	}
	srv.store.mu.Unlock()
	srv.store.save(name)
	writeJSON(w, map[string]string{"status": "deleted"})
}

// Group CRUD
func (srv *Server) createGroup(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	g, ok := srv.store.get(name)
	if !ok {
		http.Error(w, "graph not found", 404)
		return
	}
	var req struct {
		Label             string            `json:"label"`
		Note              string            `json:"note"`
		NodeIDs           []string          `json:"nodeIds"`
		Attributes        map[string]string `json:"attributes"`
		VisibleAttributes map[string]bool   `json:"visibleAttributes"`
		AttributeOrder    []string          `json:"attributeOrder"`
		Color             string            `json:"color"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", 400)
		return
	}
	if len(req.NodeIDs) == 0 {
		http.Error(w, "at least one node required", 400)
		return
	}
	for _, nid := range req.NodeIDs {
		if _, ok := g.Nodes[nid]; !ok {
			http.Error(w, "node not found: "+nid, 400)
			return
		}
	}
	if req.Label == "" {
		req.Label = "Group"
	}
	if req.Attributes == nil {
		req.Attributes = make(map[string]string)
	}
	id := fmt.Sprintf("g%d", time.Now().UnixNano())
	grp := &Group{
		ID:                id,
		Label:             req.Label,
		Note:              req.Note,
		NodeIDs:           req.NodeIDs,
		Attributes:        req.Attributes,
		VisibleAttributes: req.VisibleAttributes,
		AttributeOrder:    req.AttributeOrder,
		Color:             req.Color,
	}
	srv.store.mu.Lock()
	if g.Groups == nil {
		g.Groups = make(map[string]*Group)
	}
	g.Groups[id] = grp
	srv.store.mu.Unlock()
	srv.store.save(name)
	writeJSON(w, grp)
}

func (srv *Server) updateGroup(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	groupID := r.PathValue("id")
	g, ok := srv.store.get(name)
	if !ok {
		http.Error(w, "graph not found", 404)
		return
	}
	srv.store.mu.Lock()
	grp, ok := g.Groups[groupID]
	if !ok {
		srv.store.mu.Unlock()
		http.Error(w, "group not found", 404)
		return
	}
	var req Group
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		srv.store.mu.Unlock()
		http.Error(w, "bad request", 400)
		return
	}
	if req.Label != "" {
		grp.Label = req.Label
	}
	if req.NodeIDs != nil {
		valid := make([]string, 0, len(req.NodeIDs))
		for _, nid := range req.NodeIDs {
			if _, ok := g.Nodes[nid]; ok {
				valid = append(valid, nid)
			}
		}
		grp.NodeIDs = valid
	}
	if req.Attributes != nil {
		grp.Attributes = req.Attributes
	}
	if req.VisibleAttributes != nil {
		grp.VisibleAttributes = req.VisibleAttributes
	}
	if req.AttributeOrder != nil {
		grp.AttributeOrder = req.AttributeOrder
	}
	grp.Note = req.Note
	if req.Color != "" {
		grp.Color = req.Color
	}
	srv.store.mu.Unlock()
	srv.store.save(name)
	writeJSON(w, grp)
}

func (srv *Server) deleteGroup(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	groupID := r.PathValue("id")
	g, ok := srv.store.get(name)
	if !ok {
		http.Error(w, "graph not found", 404)
		return
	}
	srv.store.mu.Lock()
	if _, ok := g.Groups[groupID]; !ok {
		srv.store.mu.Unlock()
		http.Error(w, "group not found", 404)
		return
	}
	delete(g.Groups, groupID)
	// remove edges that referenced this group
	for eid, e := range g.Edges {
		if e.From == groupID || e.To == groupID {
			delete(g.Edges, eid)
		}
	}
	srv.store.mu.Unlock()
	srv.store.save(name)
	writeJSON(w, map[string]string{"status": "deleted"})
}

func endpointExists(g *Graph, id string) bool {
	if _, ok := g.Nodes[id]; ok {
		return true
	}
	if _, ok := g.Groups[id]; ok {
		return true
	}
	return false
}

// Edge CRUD
func (srv *Server) createEdge(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	g, ok := srv.store.get(name)
	if !ok {
		http.Error(w, "graph not found", 404)
		return
	}
	var req struct {
		From       string            `json:"from"`
		To         string            `json:"to"`
		Label      string            `json:"label"`
		Note       string            `json:"note"`
		Attributes map[string]string `json:"attributes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", 400)
		return
	}
	if req.From == "" || req.To == "" {
		http.Error(w, "from and to required", 400)
		return
	}
	if !endpointExists(g, req.From) {
		http.Error(w, "from endpoint not found (node or group)", 400)
		return
	}
	if !endpointExists(g, req.To) {
		http.Error(w, "to endpoint not found (node or group)", 400)
		return
	}
	if req.Label == "" {
		req.Label = "relates"
	}
	if req.Attributes == nil {
		req.Attributes = make(map[string]string)
	}
	id := fmt.Sprintf("e%d", time.Now().UnixNano())
	edge := &Edge{
		ID:         id,
		From:       req.From,
		To:         req.To,
		Label:      req.Label,
		Note:       req.Note,
		Attributes: req.Attributes,
	}
	srv.store.mu.Lock()
	g.Edges[id] = edge
	srv.store.mu.Unlock()
	srv.store.save(name)
	writeJSON(w, edge)
}

func (srv *Server) updateEdge(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	edgeID := r.PathValue("id")
	g, ok := srv.store.get(name)
	if !ok {
		http.Error(w, "graph not found", 404)
		return
	}
	srv.store.mu.Lock()
	edge, ok := g.Edges[edgeID]
	if !ok {
		srv.store.mu.Unlock()
		http.Error(w, "edge not found", 404)
		return
	}
	var req Edge
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		srv.store.mu.Unlock()
		http.Error(w, "bad request", 400)
		return
	}
	if req.Label != "" {
		edge.Label = req.Label
	}
	if req.Attributes != nil {
		edge.Attributes = req.Attributes
	}
	edge.Note = req.Note
	// allow changing from/to carefully (node or group)
	if req.From != "" && endpointExists(g, req.From) {
		edge.From = req.From
	}
	if req.To != "" && endpointExists(g, req.To) {
		edge.To = req.To
	}
	srv.store.mu.Unlock()
	srv.store.save(name)
	writeJSON(w, edge)
}

func (srv *Server) deleteEdge(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	edgeID := r.PathValue("id")
	g, ok := srv.store.get(name)
	if !ok {
		http.Error(w, "graph not found", 404)
		return
	}
	srv.store.mu.Lock()
	if _, ok := g.Edges[edgeID]; !ok {
		srv.store.mu.Unlock()
		http.Error(w, "edge not found", 404)
		return
	}
	delete(g.Edges, edgeID)
	srv.store.mu.Unlock()
	srv.store.save(name)
	writeJSON(w, map[string]string{"status": "deleted"})
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func sanitizeName(n string) string {
	n = strings.TrimSpace(n)
	n = strings.ReplaceAll(n, "/", "_")
	n = strings.ReplaceAll(n, "\\", "_")
	n = strings.ReplaceAll(n, "..", "_")
	if n == "" {
		n = "untitled"
	}
	return n
}

func main() {
	dataDir := "graphs"
	if d := os.Getenv("GRAPHDB_DIR"); d != "" {
		dataDir = d
	}
	store := NewStore(dataDir)
	srv := &Server{store: store}

	mux := http.NewServeMux()

	// API
	mux.HandleFunc("GET /api/graphs", srv.listGraphs)
	mux.HandleFunc("POST /api/graphs", srv.createGraph)
	mux.HandleFunc("GET /api/graphs/{name}", srv.getGraph)
	mux.HandleFunc("PUT /api/graphs/{name}", srv.saveGraph)
	mux.HandleFunc("DELETE /api/graphs/{name}", srv.deleteGraph)

	mux.HandleFunc("POST /api/graphs/{name}/nodes", srv.createNode)
	mux.HandleFunc("PUT /api/graphs/{name}/nodes/{id}", srv.updateNode)
	mux.HandleFunc("DELETE /api/graphs/{name}/nodes/{id}", srv.deleteNode)

	mux.HandleFunc("POST /api/graphs/{name}/edges", srv.createEdge)
	mux.HandleFunc("PUT /api/graphs/{name}/edges/{id}", srv.updateEdge)
	mux.HandleFunc("DELETE /api/graphs/{name}/edges/{id}", srv.deleteEdge)

	mux.HandleFunc("POST /api/graphs/{name}/groups", srv.createGroup)
	mux.HandleFunc("PUT /api/graphs/{name}/groups/{id}", srv.updateGroup)
	mux.HandleFunc("DELETE /api/graphs/{name}/groups/{id}", srv.deleteGroup)

	// Static files
	staticContent, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", http.FileServer(http.FS(staticContent)))

	addr := ":8080"
	if a := os.Getenv("ADDR"); a != "" {
		addr = a
	}
	fmt.Printf("GraphDB server running at http://localhost%s\n", addr)
	fmt.Printf("Data directory: %s\n", dataDir)
	log.Fatal(http.ListenAndServe(addr, mux))
}
