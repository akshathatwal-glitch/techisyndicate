// @ts-nocheck

"use client"

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Search, X, Link2, Trash2, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";

/**
 * GraphCanvas — an Obsidian-style "graph view" / infinite node canvas.
 *
 * Drop this into a Next.js app as a CLIENT component:
 *   "use client";
 *   import GraphCanvas from "@/components/GraphCanvas";
 *
 * Each dot on the canvas is a node anchored to a "block" (a little note:
 * title + body). Nodes auto-arrange with a lightweight force simulation
 * (repulsion + spring edges + centering), can be dragged by hand, connected
 * to each other, panned/zoomed, searched, created, and deleted.
 *
 * No external physics library required — the simulation is ~40 lines of
 * plain JS below. The graph auto-saves to localStorage (debounced) and
 * reloads itself on mount, so notes/edges survive a refresh. To persist
 * server-side instead, swap the body of `persist()` for an API/DB call —
 * everything else stays the same.
 *
 * New notes auto-connect: on creation, a note links to whichever is
 * closer — the nearest existing node, or the nearest point along an
 * existing line (in which case it links to that line's nearer endpoint).
 */

// ---------------------------------------------------------------------------
// Seed data (swap this for your own notes / fetch from an API)
// ---------------------------------------------------------------------------
const seedNodes = [
  { id: "start", label: "Start here", content: "Welcome. This is the entry point of the graph." },
  { id: "plugins", label: "List of plugins", content: "Hub note linking out to every plugin doc." },
  { id: "backlinks", label: "Backlinks", content: "See which notes link back to this one." },
  { id: "graphview", label: "Graph view", content: "Visualize all notes and their connections." },
  { id: "daily", label: "Daily notes", content: "One note per day, created automatically." },
  { id: "search", label: "Search", content: "Full text search across the whole vault." },
  { id: "templates", label: "Templates", content: "Reusable note skeletons you can insert." },
  { id: "tags", label: "Tag pane", content: "Browse notes grouped by tag." },
  { id: "internal", label: "Internal link", content: "Link between two notes with [[double brackets]]." },
  { id: "quickswitch", label: "Quick switcher", content: "Jump to any note with a keyboard shortcut." },
  { id: "fileexplorer", label: "File explorer", content: "Browse the folder structure of your vault." },
  { id: "embed", label: "Embed files", content: "Embed images, PDFs, or other notes inline." },
  { id: "publish", label: "Publish", content: "Share selected notes as a public website." },
  { id: "folding", label: "Folding", content: "Collapse headings and lists to focus on a section." },
  { id: "wordcount", label: "Word count", content: "Live word and character count in the status bar." },
];

const seedEdges = [
  ["start", "plugins"], ["start", "search"], ["start", "graphview"],
  ["plugins", "backlinks"], ["plugins", "templates"], ["plugins", "publish"],
  ["plugins", "daily"], ["plugins", "tags"], ["plugins", "embed"], ["plugins", "folding"],
  ["graphview", "backlinks"], ["graphview", "internal"],
  ["backlinks", "internal"], ["internal", "quickswitch"], ["internal", "fileexplorer"],
  ["daily", "templates"], ["tags", "search"], ["fileexplorer", "quickswitch"],
  ["embed", "wordcount"], ["publish", "internal"],
];

// ---------------------------------------------------------------------------
// Physics constants
// ---------------------------------------------------------------------------
const REPULSE = 2600;
const SPRING_K = 0.02;
const IDEAL_LEN = 130;
const CENTER_K = 0.0015;
const DAMPING = 0.86;
const MIN_DIST = 30;
const SETTLE_ENERGY = 0.02;

function degreeMap(nodes, edges) {
  const m = new Map(nodes.map((n) => [n.id, 0]));
  edges.forEach(({ source, target }) => {
    m.set(source, (m.get(source) || 0) + 1);
    m.set(target, (m.get(target) || 0) + 1);
  });
  return m;
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------
const STORAGE_KEY = "graph-canvas:v1";

function loadSavedGraph() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auto-connect: attach a freshly created node to whatever is nearby —
// either the closest existing node, or the closest point along an existing
// line (edge), in which case it links to that line's nearer endpoint.
// ---------------------------------------------------------------------------
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function findAutoConnections(newNode, nodes, edges, maxLinks = 2) {
  const best = new Map(); // id -> smallest distance found

  nodes.forEach((n) => {
    if (n.id === newNode.id) return;
    const d = Math.hypot(n.x - newNode.x, n.y - newNode.y);
    if (!best.has(n.id) || d < best.get(n.id)) best.set(n.id, d);
  });

  edges.forEach(({ source, target }) => {
    const a = nodes.find((n) => n.id === source);
    const b = nodes.find((n) => n.id === target);
    if (!a || !b) return;
    const d = distToSegment(newNode.x, newNode.y, a.x, a.y, b.x, b.y);
    const nearerEnd =
      Math.hypot(a.x - newNode.x, a.y - newNode.y) < Math.hypot(b.x - newNode.x, b.y - newNode.y) ? a.id : b.id;
    if (!best.has(nearerEnd) || d < best.get(nearerEnd)) best.set(nearerEnd, d);
  });

  return [...best.entries()].sort((x, y) => x[1] - y[1]).slice(0, maxLinks).map(([id]) => id);
}

export default function GraphCanvas() {
  const containerRef = useRef(null);
  const rafRef = useRef(null);
  const draggingRef = useRef(null); // node id being dragged
  const panRef = useRef(null); // {startX, startY, offX, offY}
  const movedRef = useRef(false);

  const [nodes, setNodes] = useState(() => {
    const saved = loadSavedGraph();
    if (saved) return saved.nodes;
    return seedNodes.map((n, i) => {
      const angle = (i / seedNodes.length) * Math.PI * 2;
      return { ...n, x: 500 + Math.cos(angle) * 260, y: 350 + Math.sin(angle) * 220, vx: 0, vy: 0 };
    });
  });
  const [edges, setEdges] = useState(() => {
    const saved = loadSavedGraph();
    if (saved) return saved.edges;
    return seedEdges.map(([source, target]) => ({ source, target }));
  });
  const [view, setView] = useState({ offsetX: 0, offsetY: 0, scale: 0.85 });
  const [selected, setSelected] = useState(null); // node id shown in side panel
  const [linkMode, setLinkMode] = useState(false);
  const [linkSource, setLinkSource] = useState(null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(null); // {label, content} while editing panel

  const degrees = degreeMap(nodes, edges);

  // ---- persistence: debounced localStorage write ------------------------
  // Swap the body of this for an API/DB call if you'd rather persist server
  // side — everything else in the component stays the same either way.
  const saveTimer = useRef(null);
  const persist = useCallback((_nodes, _edges) => {
    if (typeof window === "undefined") return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes: _nodes, edges: _edges }));
      } catch {
        // storage full or unavailable (private browsing etc.) — fail silently
      }
    }, 300);
  }, []);

  // Auto-save whenever the graph changes — covers drags, new/edited/deleted
  // notes, and new links, without needing a persist() call at every site.
  useEffect(() => {
    persist(nodes, edges);
  }, [nodes, edges, persist]);

  function clearSavedGraph() {
    if (typeof window === "undefined") return;
    if (!window.confirm("Reset the graph back to the starter notes? This clears what's saved locally.")) return;
    window.localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  }

  // ---- physics simulation ----------------------------------------------
  useEffect(() => {
    let alive = true;

    function tick() {
      if (!alive) return;
      setNodes((prev) => {
        const next = prev.map((n) => ({ ...n }));
        const byId = new Map(next.map((n) => [n.id, n]));

        // repulsion
        for (let i = 0; i < next.length; i++) {
          for (let j = i + 1; j < next.length; j++) {
            const a = next[i], b = next[j];
            let dx = a.x - b.x, dy = a.y - b.y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
            if (dist < MIN_DIST) dist = MIN_DIST;
            const force = REPULSE / (dist * dist);
            const fx = (dx / dist) * force, fy = (dy / dist) * force;
            a.vx += fx; a.vy += fy;
            b.vx -= fx; b.vy -= fy;
          }
        }

        // springs along edges
        edges.forEach(({ source, target }) => {
          const a = byId.get(source), b = byId.get(target);
          if (!a || !b) return;
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const force = (dist - IDEAL_LEN) * SPRING_K;
          const fx = (dx / dist) * force, fy = (dy / dist) * force;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        });

        // centering
        next.forEach((n) => {
          n.vx += (500 - n.x) * CENTER_K;
          n.vy += (350 - n.y) * CENTER_K;
        });

        let energy = 0;
        next.forEach((n) => {
          if (n.id === draggingRef.current) { n.vx = 0; n.vy = 0; return; }
          n.vx *= DAMPING; n.vy *= DAMPING;
          n.x += n.vx; n.y += n.vy;
          energy += n.vx * n.vx + n.vy * n.vy;
        });

        rafRef.current = energy > SETTLE_ENERGY || draggingRef.current
          ? requestAnimationFrame(tick)
          : null;

        return next;
      });
    }

    if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
    return () => { alive = false; if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, nodes.length]);

  function wake() {
    if (!rafRef.current) {
      // nudge one frame to restart the loop via the effect above
      setNodes((p) => p.map((n) => ({ ...n, vx: n.vx + 0.0001 })));
    }
  }

  // ---- coordinate helpers ----------------------------------------------
  function screenToWorld(clientX, clientY) {
    const rect = containerRef.current.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.offsetX) / view.scale,
      y: (clientY - rect.top - view.offsetY) / view.scale,
    };
  }

  // ---- pan / zoom --------------------------------------------------------
  function onBgPointerDown(e) {
    if (e.target !== e.currentTarget) return;
    panRef.current = { startX: e.clientX, startY: e.clientY, offX: view.offsetX, offY: view.offsetY };
    movedRef.current = false;
  }
  function onWheel(e) {
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const worldX = (mx - view.offsetX) / view.scale;
    const worldY = (my - view.offsetY) / view.scale;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.min(2.5, Math.max(0.25, view.scale * factor));
    setView({ scale: newScale, offsetX: mx - worldX * newScale, offsetY: my - worldY * newScale });
  }

  function onPointerMove(e) {
    if (panRef.current) {
      const dx = e.clientX - panRef.current.startX, dy = e.clientY - panRef.current.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) movedRef.current = true;
      setView((v) => ({ ...v, offsetX: panRef.current.offX + dx, offsetY: panRef.current.offY + dy }));
      return;
    }
    if (draggingRef.current) {
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      setNodes((prev) => prev.map((n) => (n.id === draggingRef.current ? { ...n, x, y } : n)));
    }
  }
  function onPointerUp() {
    panRef.current = null;
    if (draggingRef.current) { draggingRef.current = null; wake(); }
  }

  // ---- node interactions --------------------------------------------------
  function onNodePointerDown(e, id) {
    e.stopPropagation();
    draggingRef.current = id;
    movedRef.current = false;
    wake();
  }
  function onNodeClick(e, id) {
    e.stopPropagation();
    if (movedRef.current) return; // was a drag, not a click
    if (linkMode) {
      if (!linkSource) { setLinkSource(id); return; }
      if (linkSource !== id) {
        setEdges((prev) => {
          const exists = prev.some(
            (ed) => (ed.source === linkSource && ed.target === id) || (ed.source === id && ed.target === linkSource)
          );
          const next = exists ? prev : [...prev, { source: linkSource, target: id }];
          persist(nodes, next);
          return next;
        });
      }
      setLinkSource(null);
      setLinkMode(false);
      wake();
      return;
    }
    openPanel(id);
  }

  function openPanel(id) {
    const n = nodes.find((n) => n.id === id);
    setSelected(id);
    setDraft({ label: n.label, content: n.content });
  }
  function saveDraft() {
    if (!selected || !draft) return;
    setNodes((prev) => {
      const next = prev.map((n) => (n.id === selected ? { ...n, label: draft.label, content: draft.content } : n));
      persist(next, edges);
      return next;
    });
  }
  function deleteSelected() {
    if (!selected) return;
    setNodes((prev) => {
      const next = prev.filter((n) => n.id !== selected);
      persist(next, edges);
      return next;
    });
    setEdges((prev) => prev.filter((e) => e.source !== selected && e.target !== selected));
    setSelected(null);
    setDraft(null);
  }
  function addNode() {
    const id = "note-" + Math.random().toString(36).slice(2, 8);
    const center = screenToWorld(
      containerRef.current.getBoundingClientRect().left + containerRef.current.clientWidth / 2,
      containerRef.current.getBoundingClientRect().top + containerRef.current.clientHeight / 2
    );
    const node = { id, label: "New note", content: "", x: center.x + (Math.random() - 0.5) * 40, y: center.y + (Math.random() - 0.5) * 40, vx: 0, vy: 0 };

    // Auto-connect to whatever's closest — a nearby node, or a nearby line
    // (in which case it links to that line's nearer endpoint).
    const autoTargets = findAutoConnections(node, nodes, edges, 2);

    setNodes((prev) => [...prev, node]);
    if (autoTargets.length) {
      setEdges((prev) => [...prev, ...autoTargets.map((target) => ({ source: id, target }))]);
    }
    wake();
    openPanel(id);
  }
  function resetView() {
    setView({ offsetX: 0, offsetY: 0, scale: 0.85 });
  }

  const matches = query.trim().toLowerCase();
  const selectedNode = nodes.find((n) => n.id === selected);

  return (
    <div className="flex h-[640px] w-full overflow-hidden rounded-xl border border-neutral-800 bg-[#0c0c0e] text-neutral-200 font-sans select-none">
      {/* Canvas */}
      <div className="relative flex-1 overflow-hidden">
        {/* Toolbar */}
        <div className="absolute top-3 left-3 right-3 z-10 flex items-center gap-2 flex-wrap">
          <button
            onClick={addNode}
            className="flex items-center gap-1.5 rounded-md bg-neutral-800/90 hover:bg-neutral-700 px-3 py-1.5 text-sm backdrop-blur"
          >
            <Plus size={15} /> New note
          </button>
          <button
            onClick={() => { setLinkMode((v) => !v); setLinkSource(null); }}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm backdrop-blur ${
              linkMode ? "bg-violet-600 hover:bg-violet-500" : "bg-neutral-800/90 hover:bg-neutral-700"
            }`}
          >
            <Link2 size={15} /> {linkMode ? (linkSource ? "Pick target note" : "Pick first note") : "Link notes"}
          </button>
          <div className="flex items-center gap-1.5 rounded-md bg-neutral-800/90 px-2.5 py-1.5 backdrop-blur">
            <Search size={14} className="text-neutral-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search notes"
              className="bg-transparent outline-none text-sm placeholder-neutral-500 w-32"
            />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button onClick={() => setView((v) => ({ ...v, scale: Math.min(2.5, v.scale * 1.15) }))} className="rounded-md bg-neutral-800/90 hover:bg-neutral-700 p-1.5"><ZoomIn size={15} /></button>
            <button onClick={() => setView((v) => ({ ...v, scale: Math.max(0.25, v.scale * 0.87) }))} className="rounded-md bg-neutral-800/90 hover:bg-neutral-700 p-1.5"><ZoomOut size={15} /></button>
            <button onClick={resetView} className="rounded-md bg-neutral-800/90 hover:bg-neutral-700 p-1.5"><Maximize2 size={15} /></button>
            <button onClick={clearSavedGraph} className="rounded-md bg-neutral-800/90 hover:bg-neutral-700 p-1.5" title="Reset graph"><Trash2 size={15} /></button>
          </div>
        </div>

        <div
          ref={containerRef}
          onPointerDown={onBgPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onWheel={onWheel}
          className="absolute inset-0 cursor-grab active:cursor-grabbing"
          style={{
            backgroundImage: "radial-gradient(circle, #1c1c20 1px, transparent 1px)",
            backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`,
            backgroundPosition: `${view.offsetX}px ${view.offsetY}px`,
          }}
        >
          <div style={{ transform: `translate(${view.offsetX}px, ${view.offsetY}px)`, transformOrigin: "0 0" }} className="absolute inset-0">
            <div style={{ transform: `scale(${view.scale})`, transformOrigin: "0 0" }} className="relative">
              <svg width={1400} height={1000} className="absolute top-0 left-0 pointer-events-none overflow-visible">
                {edges.map((e, i) => {
                  const a = nodes.find((n) => n.id === e.source);
                  const b = nodes.find((n) => n.id === e.target);
                  if (!a || !b) return null;
                  const dim = matches && !(a.label.toLowerCase().includes(matches) || b.label.toLowerCase().includes(matches));
                  return (
                    <line
                      key={i}
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke="#4b4b55"
                      strokeWidth={1}
                      opacity={dim ? 0.06 : 0.35}
                    />
                  );
                })}
                {linkMode && linkSource && (
                  (() => {
                    const a = nodes.find((n) => n.id === linkSource);
                    return a ? <circle cx={a.x} cy={a.y} r={16} fill="none" stroke="#a78bfa" strokeWidth={2} /> : null;
                  })()
                )}
              </svg>

              {nodes.map((n) => {
                const deg = degrees.get(n.id) || 0;
                const r = 5 + Math.min(deg, 8) * 1.6;
                const dim = matches && !n.label.toLowerCase().includes(matches);
                const isSel = selected === n.id;
                const isLinkSrc = linkSource === n.id;
                return (
                  <div
                    key={n.id}
                    onPointerDown={(e) => onNodePointerDown(e, n.id)}
                    onClick={(e) => onNodeClick(e, n.id)}
                    style={{ left: n.x, top: n.y, opacity: dim ? 0.25 : 1 }}
                    className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-1 cursor-pointer group"
                  >
                    <div
                      style={{
                        width: r * 2, height: r * 2,
                        background: isSel ? "#a78bfa" : isLinkSrc ? "#a78bfa" : "#8b8b96",
                      }}
                      className="rounded-full transition-transform group-hover:scale-125 ring-0 group-hover:ring-4 group-hover:ring-violet-500/20"
                    />
                    <span
                      className="text-[11px] whitespace-nowrap px-1 rounded"
                      style={{ color: isSel ? "#c4b5fd" : "#c9c9d1" }}
                    >
                      {n.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Side panel — the "block" anchored to a node */}
      {selected && draft && (
        <div className="w-80 shrink-0 border-l border-neutral-800 bg-[#101012] flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
            <span className="text-xs uppercase tracking-wide text-neutral-500">Note</span>
            <button onClick={() => { setSelected(null); setDraft(null); }} className="text-neutral-500 hover:text-neutral-300">
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            <input
              value={draft.label}
              onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              onBlur={saveDraft}
              className="bg-transparent text-lg font-medium outline-none border-b border-transparent focus:border-neutral-700 pb-1"
            />
            <textarea
              value={draft.content}
              onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
              onBlur={saveDraft}
              placeholder="Write something…"
              className="flex-1 min-h-[220px] bg-neutral-900/50 rounded-md p-3 text-sm outline-none resize-none placeholder-neutral-600"
            />
            <div className="text-xs text-neutral-500">
              {edges.filter((e) => e.source === selected || e.target === selected).length} connections
            </div>
          </div>
          <div className="p-3 border-t border-neutral-800">
            <button
              onClick={deleteSelected}
              className="w-full flex items-center justify-center gap-1.5 rounded-md bg-red-950/60 hover:bg-red-900/60 text-red-300 py-2 text-sm"
            >
              <Trash2 size={14} /> Delete note
            </button>
          </div>
        </div>
      )}
    </div>
  );
}