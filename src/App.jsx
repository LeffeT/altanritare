import React, { useState, useRef, useEffect, useMemo } from "react";
import * as THREE from "three";
import {
  Home, Square, Ruler, FileText, Download, Box, Layers,
  RotateCcw, Pencil, ChevronRight, TriangleRight, Maximize, Minimize,
  Hammer, ChevronDown, Menu, Save, FolderOpen
} from "lucide-react";

/* ===========================================================================
   ALTANRITARE — förenklad ritapp för altaner, hus och altantak
   - Allt körs i webbläsaren, ingen backend
   - 2D (rita) + 3D (Three.js) + tre tekniska ritningar + PDF-export (utskrift)
   ===========================================================================*/

/* ---------- Tema ---------- */
const T = {
  bg: "#0d1117",
  panel: "#141a22",
  panel2: "#1b2530",
  line: "#26303c",
  text: "#e6edf3",
  dim: "#8b97a6",
  wood: "#c98a3c",
  woodDark: "#8a5a23",
  cyan: "#5eead4",
  sky: "#56b6ff",
};

/* ---------- Hjälpare ---------- */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const APP_VERSION = "v1.7 · antal stående brädor";

// Svensk talformatering: 2.7 -> "2,7", 4 -> "4"
const num = (v) => {
  const r = Math.round(v * 100) / 100;
  return String(r).replace(".", ",");
};
const m = (v) => `${num(v)} m`;

// Härled beräknade värden ur projektet
function derive(p) {
  const drop = (p.roof.slope / 100) * p.roof.depth;      // fall till stolplinje/framkant
  const frontHeight = p.roof.heightAtWall - drop;        // fri höjd vid framkant (stolplinje)
  const of = p.roof.overhangFront || 0;                  // takutsprång fram
  const edgeRun = p.roof.depth + of;                     // total horisontell längd till ytterkant
  const edgeDrop = (p.roof.slope / 100) * edgeRun;       // fall till yttersta takkant
  const edgeHeight = p.roof.heightAtWall - edgeDrop;     // fri höjd vid yttersta takkant
  const angleRad = Math.atan2(drop, p.roof.depth);
  const angleDeg = (angleRad * 180) / Math.PI;
  // Takstolens höjd (ur vald dimension, t.ex. "45×220" → 0,22 m) ger ståhöjden
  const rafterDepth = (parseFloat(String(p.frame?.rafterDim || "45×220").split("×")[1]) || 0) / 1000;
  const staWall = p.roof.heightAtWall - rafterDepth;     // ståhöjd vid husvägg (under takstol)
  const staFront = frontHeight - rafterDepth;            // ståhöjd vid framkant
  const staEdge = edgeHeight - rafterDepth;              // ståhöjd vid yttersta takkant
  return { drop, frontHeight, of, edgeRun, edgeDrop, edgeHeight, angleRad, angleDeg, rafterDepth, staWall, staFront, staEdge };
}

// Avstånd från altanens kanter till tomtgränserna (fasta linjer i världen).
// Värdena räknas om automatiskt när altanen flyttas.
function boundClear(p) {
  const leftEdge = p.deck.offset - p.deck.width / 2;
  const rightEdge = p.deck.offset + p.deck.width / 2;
  const rd = p.house.recess.on ? p.house.recess.depth : 0;
  const frontY = (p.house.depth - rd) + p.deck.depth; // altanen ansluter vid innerväggen
  const b = p.boundaries;
  return {
    leftEdge, rightEdge, frontY,
    left: leftEdge - b.left.pos,
    right: b.right.pos - rightEdge,
    front: b.front.pos - frontY,
  };
}

// Husets fasadgeometri sett uppifrån. Hanterar nisch (indrag) + takutsprång.
// Trappans geometri (delas av 3D och ritningar). Lokala altankoordinater:
// x i [offset-w/2, offset+w/2], z = 0 vid anslutningsvägg, z = djup vid framkant.
function stairGeom(p) {
  const st = p.stairs || {};
  const deck = p.deck;
  const sw = Math.max(0.4, Math.min(st.width || 1.2, st.side === "front" ? deck.width - 0.2 : deck.depth - 0.2));
  const n = Math.max(1, Math.round(st.steps || 3));
  const rise = deck.height / n;
  const run = 0.27;
  const proj = n * run;
  const side = st.side || "right";
  let cx, cz;
  if (side === "front") {
    cx = clamp(deck.offset + (st.pos || 0), deck.offset - deck.width / 2 + sw / 2, deck.offset + deck.width / 2 - sw / 2);
    cz = deck.depth;
  } else {
    cz = clamp(deck.depth / 2 + (st.pos || 0), sw / 2, deck.depth - sw / 2);
    cx = side === "left" ? deck.offset - deck.width / 2 : deck.offset + deck.width / 2;
  }
  return { on: !!st.on, side, sw, n, rise, run, proj, cx, cz };
}

function planGeom(p) {
  const r = p.house.recess;
  const rd = r.on ? r.depth : 0;
  const hw = p.house.width / 2;
  const recL = clamp(r.offset - r.width / 2, -hw, hw);
  const recR = clamp(r.offset + r.width / 2, -hw, hw);
  const innerY = p.house.depth - rd;            // vägg som altanen sitter mot
  const eavesY = p.house.depth + (p.house.overhang || 0); // befintlig takfot
  const deckFrontY = innerY + p.deck.depth;
  const coveredDepth = rd + (p.house.overhang || 0);       // djup under befintligt tak
  const utstick = Math.max(0, p.deck.depth - rd);          // del som går förbi ytterväggen
  return { rd, recL, recR, innerY, frontY: p.house.depth, eavesY, deckFrontY, coveredDepth, utstick };
}

// Materialberäkning för altantaket (mängder ur takets mått + valda cc-avstånd)
function computeBom(p) {
  const d = derive(p);
  const f = p.frame;
  const fack = Math.max(1, Math.ceil((p.roof.width * 1000) / Math.max(100, f.rafterCC)));
  const rafters = fack + 1;
  const edgeRun = p.roof.depth + (p.roof.overhangFront || 0);
  const slopeLen = edgeRun / Math.cos(d.angleRad);
  const rafterOrder = Math.ceil((slopeLen + 0.1) * 10) / 10;
  const battenRows = Math.max(2, Math.ceil((slopeLen * 1000) / Math.max(100, f.battenCC)) + 1);
  const battenLM = battenRows * p.roof.width;
  const front = Math.max(1, Math.round(p.deck.posts));
  const back = p.deck.roofAttach === "free" ? front : 0;
  const posts = front + back;
  const roofArea = p.roof.width * slopeLen;
  return { fack, rafters, slopeLen, rafterOrder, battenRows, battenLM, beams: 2, beamLen: p.roof.width, front, back, posts, roofArea, angleDeg: d.angleDeg };
}

function bomRows(p) {
  const b = computeBom(p);
  const f = p.frame;
  return [
    ["Takstolar / reglar", f.rafterDim, `${b.rafters} st`, `cc ${f.rafterCC} mm · ${b.fack} fack · längd ca ${num(b.rafterOrder)} m`],
    ["Bärlinor", f.beamDim, `${b.beams} st`, `längd ${num(b.beamLen)} m (fram + bak)`],
    ["Stolpar", f.postDim, `${b.posts} st`, b.back ? `${b.front} fram + ${b.back} bak` : `${b.front} fram · bak infäst i vägg`],
    ["Bärläkt", f.battenDim, `${b.battenRows} rader`, `cc ${f.battenCC} mm · ca ${num(b.battenLM)} löpmeter`],
    ["Takyta", "TP20 plåt", `${num(b.roofArea)} m²`, `taklutning ca ${num(b.angleDeg)}°`],
  ];
}

// --- Lagring (localStorage med säker degradering om den är blockerad) ---
const LS_SAVES = "altanritare:saves";
const LS_AUTO = "altanritare:autosave";
const mem = {};
function lsGet(key) {
  try { const v = window.localStorage.getItem(key); return v == null ? mem[key] ?? null : v; }
  catch (_) { return mem[key] ?? null; }
}
function lsSet(key, val) {
  mem[key] = val;
  try { window.localStorage.setItem(key, val); return true; } catch (_) { return false; }
}
function loadSaves() {
  try { return JSON.parse(lsGet(LS_SAVES) || "{}"); } catch (_) { return {}; }
}
function storeSaves(obj) { lsSet(LS_SAVES, JSON.stringify(obj)); }

const DEFAULT_PROJECT = {
  name: "Mitt altanprojekt",
  house: {
    width: 18, depth: 9, height: 5, overhang: 1.5, roofPitch: 24,
    recess: { on: true, width: 9, depth: 1.5, offset: 0 }, // indrag i fasaden
  },
  deck: {
    width: 8, depth: 4, height: 0.4, offset: 0, posts: 3,
    hasRoof: true, roofAttach: "attached", // attached | free
  },
  railing: { on: true, height: 1.0, type: "vertical", back: false, rows: 4, vcount: 40 }, // rows=liggande, vcount=stående
  stairs: { on: false, side: "right", width: 1.2, pos: 0, steps: 3 }, // side: front | left | right
  roof: { width: 8, depth: 4, heightAtWall: 2.6, slope: 15, overhangFront: 0.3 },
  // Virke/stomme för materiallistan
  frame: {
    rafterDim: "45×220", rafterCC: 600,
    battenDim: "45×70", battenCC: 600,
    beamDim: "56×225 limträ", postDim: "95×95",
  },
  // Tomtgränser som fasta linjer. pos = absolut koordinat (m):
  // front.pos = y (mätt från husbaksidan), left/right.pos = x.
  boundaries: {
    front: { on: true, pos: 7.5 + 4 + 4.5 }, // innervägg(7,5) + altandjup(4) + 4,5 m
    left: { on: false, pos: -(8 / 2 + 4) },  // 4 m från vänster altankant
    right: { on: false, pos: 8 / 2 + 4 },    // 4 m från höger altankant
  },
};

/* ===========================================================================
   STARTSKÄRM
   ===========================================================================*/
function StartScreen({ onStart }) {
  const [name, setName] = useState("Mitt altanprojekt");
  const choices = [
    { id: "deck", title: "Rita altan", desc: "Börja med altanens mått och placering", Icon: Square, accent: T.wood },
    { id: "house", title: "Rita hus", desc: "Lägg till husvägg och husmått", Icon: Home, accent: T.sky },
    { id: "roof", title: "Rita altantak", desc: "Pulpettak med lutning och fri höjd", Icon: TriangleRight, accent: T.cyan },
  ];
  return (
    <div style={{
      minHeight: "100%", display: "flex", boxSizing: "border-box",
      background: `radial-gradient(1200px 600px at 50% -10%, #16202b 0%, ${T.bg} 60%)`,
      color: T.text, padding: 24,
    }}>
      <div style={{ width: "min(760px, 100%)", margin: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10, display: "grid", placeItems: "center",
            background: `linear-gradient(135deg, ${T.wood}, ${T.woodDark})`, color: "#1a1206",
          }}><Ruler size={20} /></div>
          <span style={{ letterSpacing: 1, fontSize: 13, color: T.dim, textTransform: "uppercase" }}>
            Altanritare
          </span>
        </div>
        <h1 style={{ fontSize: 40, lineHeight: 1.05, margin: "10px 0 8px", fontWeight: 700 }}>
          Rita din altan.<br />
          <span style={{ color: T.wood }}>Klart för bygganmälan.</span>
        </h1>
        <p style={{ color: T.dim, fontSize: 16, maxWidth: 520, margin: "0 0 28px" }}>
          Ett enkelt verktyg för villaägare. Mata in måtten, se modellen i 3D och få
          plan-, fasad- och sektionsritning du kan exportera som PDF.
        </p>

        <label style={{ display: "block", fontSize: 13, color: T.dim, marginBottom: 8 }}>
          Projektets namn
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="T.ex. Altan baksida"
          style={{
            width: "100%", padding: "14px 16px", fontSize: 16, color: T.text,
            background: T.panel, border: `1px solid ${T.line}`, borderRadius: 12, outline: "none",
            marginBottom: 22,
          }}
        />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
          {choices.map(({ id, title, desc, Icon, accent }) => (
            <button
              key={id}
              onClick={() => onStart(name.trim() || "Mitt altanprojekt", id)}
              style={{
                textAlign: "left", cursor: "pointer", padding: 18, borderRadius: 16,
                background: T.panel, border: `1px solid ${T.line}`, color: T.text,
                transition: "transform .12s, border-color .12s, background .12s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = accent; e.currentTarget.style.transform = "translateY(-2px)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.line; e.currentTarget.style.transform = "none"; }}
            >
              <div style={{
                width: 40, height: 40, borderRadius: 10, display: "grid", placeItems: "center",
                background: T.panel2, color: accent, marginBottom: 12,
              }}><Icon size={22} /></div>
              <div style={{ fontWeight: 650, fontSize: 17, marginBottom: 4 }}>{title}</div>
              <div style={{ color: T.dim, fontSize: 13, lineHeight: 1.4 }}>{desc}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, color: accent, fontSize: 13, marginTop: 12 }}>
                Starta <ChevronRight size={15} />
              </div>
            </button>
          ))}
        </div>
        <p style={{ color: "#5b6675", fontSize: 12, marginTop: 24 }}>
          Du kan ändra allt senare. Verktyget är förenklat — inte avancerat CAD. <span style={{ color: T.wood }}>{APP_VERSION}</span>
        </p>
      </div>
    </div>
  );
}

/* ===========================================================================
   SIDOPANEL — inmatningsfält
   ===========================================================================*/
function NumberField({ label, value, onChange, unit = "m", step = 0.1, min = 0, max = 9999 }) {
  const [txt, setTxt] = useState(num(value));
  useEffect(() => { setTxt(num(value)); }, [value]);
  const handle = (s) => {
    setTxt(s);
    const v = parseFloat(s.replace(",", "."));
    if (!isNaN(v)) onChange(clamp(v, min, max));
  };
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ fontSize: 12.5, color: T.dim, display: "block", marginBottom: 5 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "stretch", background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 9, overflow: "hidden" }}>
        <input
          value={txt}
          inputMode="decimal"
          onChange={(e) => handle(e.target.value)}
          onBlur={() => setTxt(num(value))}
          style={{ flex: 1, padding: "9px 11px", background: "transparent", border: "none", color: T.text, fontSize: 14.5, outline: "none", width: "100%" }}
        />
        <span style={{ display: "grid", placeItems: "center", padding: "0 11px", color: T.dim, fontSize: 12.5, background: "#10161e", borderLeft: `1px solid ${T.line}` }}>{unit}</span>
      </div>
    </label>
  );
}

function Section({ title, Icon, accent, open, onToggle, children }) {
  return (
    <div style={{ borderBottom: `1px solid ${T.line}` }}>
      <button onClick={onToggle} style={{
        width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
        background: "transparent", border: "none", color: T.text, cursor: "pointer", fontSize: 14, fontWeight: 600,
      }}>
        <span style={{ color: accent, display: "grid", placeItems: "center" }}><Icon size={17} /></span>
        {title}
        <ChevronRight size={16} style={{ marginLeft: "auto", color: T.dim, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
      </button>
      {open && <div style={{ padding: "2px 16px 16px" }}>{children}</div>}
    </div>
  );
}

function Toggle({ value, onChange, options }) {
  return (
    <div style={{ display: "flex", background: "#10161e", border: `1px solid ${T.line}`, borderRadius: 9, padding: 3, gap: 3 }}>
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} style={{
          flex: 1, padding: "7px 6px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12.5,
          background: value === o.value ? T.wood : "transparent",
          color: value === o.value ? "#1a1206" : T.dim, fontWeight: value === o.value ? 650 : 500,
        }}>{o.label}</button>
      ))}
    </div>
  );
}

function Switch({ on, onChange }) {
  return (
    <button onClick={() => onChange(!on)} aria-pressed={on} style={{
      width: 40, height: 23, borderRadius: 12, border: `1px solid ${T.line}`,
      background: on ? T.wood : "#10161e", position: "relative", cursor: "pointer", flexShrink: 0,
    }}>
      <span style={{ position: "absolute", top: 2, left: on ? 19 : 2, width: 17, height: 17, borderRadius: 9, background: on ? "#1a1206" : "#5b6675", transition: "left .15s" }} />
    </button>
  );
}

function Sidebar({ project, set, openSection, setOpenSection, width = 320, onClose, onSave, onOpenProjects }) {
  const d = derive(project);
  const lowHeadroom = d.staEdge < 2.0;

  const setHouse = (k, v) => set((p) => ({ ...p, house: { ...p.house, [k]: v } }));
  const setDeck = (k, v) => set((p) => ({ ...p, deck: { ...p.deck, [k]: v } }));
  const setRoof = (k, v) => set((p) => ({ ...p, roof: { ...p.roof, [k]: v } }));
  const setRecess = (k, v) => set((p) => ({ ...p, house: { ...p.house, recess: { ...p.house.recess, [k]: v } } }));
  const setRail = (k, v) => set((p) => ({ ...p, railing: { ...p.railing, [k]: v } }));
  const setStairs = (k, v) => set((p) => ({ ...p, stairs: { ...p.stairs, [k]: v } }));
  // Flytta altanen i sidled och låt nischen följa med samma steg
  const moveDeckOffset = (v) => set((p) => {
    const dx = v - p.deck.offset;
    return { ...p, deck: { ...p.deck, offset: v }, house: { ...p.house, recess: { ...p.house.recess, offset: p.house.recess.offset + dx } } };
  });
  const setBound = (side, patch) => set((p) => ({ ...p, boundaries: { ...p.boundaries, [side]: { ...p.boundaries[side], ...patch } } }));
  const c = boundClear(project);
  const g = planGeom(project);
  const over = project.deck.depth - g.coveredDepth;
  const coverNote = over <= 0.001
    ? "Hela altanen ryms under befintligt tak."
    : `${num(over)} m av altanen sticker ut utanför befintligt tak.`;
  const posFromDist = (side, dist) =>
    side === "front" ? c.frontY + dist : side === "left" ? c.leftEdge - dist : c.rightEdge + dist;
  const toggle = (id) => setOpenSection((s) => (s === id ? null : id));

  return (
    <aside style={{ width, flexShrink: 0, height: "100%", background: T.panel, borderRight: `1px solid ${T.line}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: 16, borderBottom: `1px solid ${T.line}` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11.5, color: T.dim, letterSpacing: 1, textTransform: "uppercase" }}>Projekt</span>
          {onClose && (
            <button onClick={onClose} style={{ background: "transparent", border: "none", color: T.dim, cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", gap: 5 }}>
              Stäng ✕
            </button>
          )}
        </div>
        <input
          value={project.name}
          onChange={(e) => set((p) => ({ ...p, name: e.target.value }))}
          style={{ width: "100%", marginTop: 7, padding: "9px 11px", background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 9, color: T.text, fontSize: 15, fontWeight: 600, outline: "none" }}
        />
        {(onSave || onOpenProjects) && (
          <div style={{ display: "flex", gap: 8, marginTop: 9 }}>
            <button onClick={onSave} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, background: T.panel2, border: `1px solid ${T.line}`, color: T.text, borderRadius: 9, padding: "8px", cursor: "pointer", fontSize: 13 }}>
              <Save size={14} /> Spara
            </button>
            <button onClick={onOpenProjects} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, background: T.panel2, border: `1px solid ${T.line}`, color: T.text, borderRadius: 9, padding: "8px", cursor: "pointer", fontSize: 13 }}>
              <FolderOpen size={14} /> Mina projekt
            </button>
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {/* HUS */}
        <Section title="Hus" Icon={Home} accent={T.sky} open={openSection === "house"} onToggle={() => toggle("house")}>
          <NumberField label="Husets bredd (fasadlängd)" value={project.house.width} onChange={(v) => setHouse("width", v)} min={1} max={60} />
          <NumberField label="Husets djup" value={project.house.depth} onChange={(v) => setHouse("depth", v)} min={1} max={60} />
          <NumberField label="Vägghöjd (till takfot)" value={project.house.height} onChange={(v) => setHouse("height", v)} min={2} max={20} />
          <NumberField label="Takvinkel (hus)" unit="°" value={project.house.roofPitch} onChange={(v) => setHouse("roofPitch", v)} step={1} min={5} max={60} />
          <NumberField label="Takutsprång (befintligt tak)" value={project.house.overhang} onChange={(v) => setHouse("overhang", v)} min={0} max={3} />

          <div style={{ marginTop: 6, paddingTop: 12, borderTop: `1px solid ${T.line}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: project.house.recess.on ? 10 : 0 }}>
              <span style={{ fontSize: 13.5 }}>Indrag i fasad (nisch)</span>
              <Switch on={project.house.recess.on} onChange={(v) => setRecess("on", v)} />
            </div>
            {project.house.recess.on && (
              <>
                <NumberField label="Nischens bredd" value={project.house.recess.width} onChange={(v) => setRecess("width", v)} min={0.5} max={project.house.width} />
                <NumberField label="Nischens djup (in i huset)" value={project.house.recess.depth} onChange={(v) => setRecess("depth", v)} min={0} max={Math.max(0.5, project.house.depth - 0.5)} />
                <NumberField label="Nischens placering i sidled" value={project.house.recess.offset} onChange={(v) => setRecess("offset", v)} min={-20} max={20} />
                <div style={{ padding: "11px 13px", borderRadius: 11, background: "#10201d", border: "1px solid #1f4038", marginTop: 4 }}>
                  <div style={{ fontSize: 12, color: T.dim, marginBottom: 3 }}>Täckt djup under befintligt tak</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: T.cyan }}>{m(g.coveredDepth)}</div>
                  <div style={{ fontSize: 11.5, color: over <= 0.001 ? T.dim : T.wood, marginTop: 4 }}>{coverNote}</div>
                </div>
              </>
            )}
          </div>
        </Section>

        {/* ALTAN */}
        <Section title="Altan" Icon={Square} accent={T.wood} open={openSection === "deck"} onToggle={() => toggle("deck")}>
          <NumberField label="Bredd" value={project.deck.width} onChange={(v) => setDeck("width", v)} min={0.5} max={40} />
          <NumberField label="Altandjup (från anslutningsvägg)" value={project.deck.depth} onChange={(v) => setDeck("depth", v)} min={0.5} max={20} />
          {project.house.recess.on && (
            <div style={{ padding: "10px 12px", borderRadius: 10, background: "#1c1407", border: "1px solid #4a3413", marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: T.dim }}>Utstick utanför yttervägg</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: T.wood }}>{m(g.utstick)}</div>
              <div style={{ fontSize: 11.5, color: T.dim, marginTop: 3 }}>Altandjup {m(project.deck.depth)} − indrag {m(project.house.recess.depth)}</div>
            </div>
          )}
          <NumberField label="Höjd över mark" value={project.deck.height} onChange={(v) => setDeck("height", v)} min={0} max={6} />
          <NumberField label="Placering i sidled (− vänster / + höger)" value={project.deck.offset} onChange={moveDeckOffset} min={-20} max={20} />

          <NumberField label="Antal stolpar (fram)" value={project.deck.posts} onChange={(v) => setDeck("posts", Math.round(v))} unit="st" step={1} min={1} max={12} />
          {project.deck.posts > 1 && (
            <div style={{ fontSize: 11.5, color: T.dim, margin: "-6px 0 12px" }}>
              Centrumavstånd c/c ≈ {m(project.deck.width / (Math.round(project.deck.posts) - 1))} · går från mark till tak
            </div>
          )}

          <div style={{ margin: "14px 0 6px", fontSize: 12.5, color: T.dim }}>Tak</div>
          <Toggle value={project.deck.hasRoof ? "yes" : "no"} onChange={(v) => setDeck("hasRoof", v === "yes")}
            options={[{ value: "yes", label: "Med tak" }, { value: "no", label: "Utan tak" }]} />

          {project.deck.hasRoof && (
            <div style={{ marginTop: 10 }}>
              <div style={{ margin: "4px 0 6px", fontSize: 12.5, color: T.dim }}>Takfäste</div>
              <Toggle value={project.deck.roofAttach} onChange={(v) => setDeck("roofAttach", v)}
                options={[{ value: "attached", label: "Fäst i hus" }, { value: "free", label: "Fristående" }]} />
            </div>
          )}
        </Section>

        {/* RÄCKE */}
        <Section title="Räcke" Icon={Layers} accent={T.wood} open={openSection === "railing"} onToggle={() => toggle("railing")}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: project.railing.on ? 12 : 0 }}>
            <span style={{ fontSize: 13.5 }}>Räcke runt altanen</span>
            <Switch on={project.railing.on} onChange={(v) => setRail("on", v)} />
          </div>
          {project.railing.on && (
            <>
              <NumberField label="Räckeshöjd" value={project.railing.height} onChange={(v) => setRail("height", v)} min={0.3} max={1.5} />
              <div style={{ margin: "2px 0 6px", fontSize: 12.5, color: T.dim }}>Brädor</div>
              <Toggle value={project.railing.type} onChange={(v) => setRail("type", v)}
                options={[{ value: "vertical", label: "Stående" }, { value: "horizontal", label: "Liggande" }]} />
              {project.railing.type === "horizontal" ? (
                <div style={{ marginTop: 10 }}>
                  <NumberField label="Antal brädrader" value={project.railing.rows} onChange={(v) => setRail("rows", Math.round(v))} min={1} max={16} unit="st" />
                </div>
              ) : (
                <div style={{ marginTop: 10 }}>
                  <NumberField label="Antal brädor (på framsidan)" value={project.railing.vcount} onChange={(v) => setRail("vcount", Math.round(v))} min={4} max={120} unit="st" />
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12 }}>
                <span style={{ fontSize: 13 }}>Även mot huset</span>
                <Switch on={project.railing.back} onChange={(v) => setRail("back", v)} />
              </div>
              <div style={{ fontSize: 11.5, color: T.dim, marginTop: 8 }}>
                Räcket sätts runt altanens öppna sidor. Stående brädor sätts med ca 100 mm mellanrum. Där trappan står lämnas en öppning.
              </div>
            </>
          )}
        </Section>

        {/* TRAPPA */}
        <Section title="Trappa" Icon={Layers} accent={T.cyan} open={openSection === "stairs"} onToggle={() => toggle("stairs")}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: project.stairs.on ? 12 : 0 }}>
            <span style={{ fontSize: 13.5 }}>Trappa ned till mark</span>
            <Switch on={project.stairs.on} onChange={(v) => setStairs("on", v)} />
          </div>
          {project.stairs.on && (
            <>
              <div style={{ margin: "2px 0 6px", fontSize: 12.5, color: T.dim }}>Sida</div>
              <Toggle value={project.stairs.side} onChange={(v) => setStairs("side", v)}
                options={[{ value: "left", label: "Vänster" }, { value: "front", label: "Fram" }, { value: "right", label: "Höger" }]} />
              <div style={{ marginTop: 10 }}>
                <NumberField label="Trappbredd" value={project.stairs.width} onChange={(v) => setStairs("width", v)} min={0.5} max={6} />
                <NumberField label="Placering (0 = mitten)" value={project.stairs.pos} onChange={(v) => setStairs("pos", v)} min={-10} max={10} />
                <NumberField label="Antal steg" value={project.stairs.steps} onChange={(v) => setStairs("steps", Math.round(v))} min={1} max={12} unit="st" />
              </div>
              {(() => {
                const sg = stairGeom(project);
                return (
                  <div style={{ fontSize: 11.5, color: T.dim, marginTop: 8, lineHeight: 1.6 }}>
                    Steghöjd ca {m(sg.rise)} · djup {m(sg.run)}/steg · sticker ut {m(sg.proj)} från altanen.
                  </div>
                );
              })()}
            </>
          )}
        </Section>

        {/* TOMTGRÄNSER */}
        <Section title="Tomtgränser" Icon={Ruler} accent="#ef6b6b" open={openSection === "bounds"} onToggle={() => toggle("bounds")}>
          <p style={{ fontSize: 12, color: T.dim, margin: "0 0 12px", lineHeight: 1.5 }}>
            Slå på de sidor där tomtgränsen är nära. Avstånden mäts från altanens kant och uppdateras automatiskt när du flyttar altanen.
          </p>
          {[
            { side: "front", label: "Framför altan" },
            { side: "left", label: "Vänster sida" },
            { side: "right", label: "Höger sida" },
          ].map(({ side, label }) => {
            const bo = project.boundaries[side];
            const dist = c[side];
            return (
              <div key={side} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${T.line}` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13.5 }}>{label}</span>
                  <Switch on={bo.on} onChange={(v) => setBound(side, { on: v })} />
                </div>
                {bo.on && (
                  <div style={{ marginTop: 8 }}>
                    <NumberField label="Avstånd till tomtgräns" value={dist} onChange={(nd) => setBound(side, { pos: posFromDist(side, nd) })} min={0} max={80} />
                    {dist < 0 && <div style={{ color: "#ef6b6b", fontSize: 11.5, marginTop: -4 }}>Altanen går över tomtgränsen.</div>}
                  </div>
                )}
              </div>
            );
          })}
        </Section>

        {/* TAK */}
        {project.deck.hasRoof && (
          <Section title="Tak (pulpettak)" Icon={TriangleRight} accent={T.cyan} open={openSection === "roof"} onToggle={() => toggle("roof")}>
            <NumberField label="Takbredd" value={project.roof.width} onChange={(v) => setRoof("width", v)} min={0.5} max={40} />
            <NumberField label="Takdjup" value={project.roof.depth} onChange={(v) => setRoof("depth", v)} min={0.5} max={20} />
            <NumberField label="Höjd vid husvägg (till takstolens ovankant)" value={project.roof.heightAtWall} onChange={(v) => setRoof("heightAtWall", v)} min={1.5} max={8} />
            <NumberField label="Lutning" unit="cm/m" value={project.roof.slope} onChange={(v) => setRoof("slope", v)} step={1} min={0} max={120} />
            <NumberField label="Takutsprång fram (utöver stolplinjen)" value={project.roof.overhangFront} onChange={(v) => setRoof("overhangFront", v)} min={0} max={2} />

            <div style={{ marginTop: 10, padding: "12px 13px", borderRadius: 11, background: lowHeadroom ? "#2a1c10" : "#10201d", border: `1px solid ${lowHeadroom ? "#5a3a1c" : "#1f4038"}` }}>
              <div style={{ fontSize: 12, color: T.dim, marginBottom: 3 }}>Ståhöjd vid framkant (under takstol)</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: lowHeadroom ? T.wood : T.cyan }}>{m(d.staFront)}</div>
              {d.of > 0.001 && (
                <div style={{ marginTop: 9, paddingTop: 9, borderTop: `1px solid ${lowHeadroom ? "#5a3a1c" : "#1f4038"}` }}>
                  <div style={{ fontSize: 12, color: T.dim, marginBottom: 3 }}>Ståhöjd vid yttersta takkant</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: lowHeadroom ? T.wood : T.cyan }}>{m(d.staEdge)}</div>
                </div>
              )}
              <div style={{ fontSize: 11.5, color: T.dim, marginTop: 6 }}>
                Takhöjd vid framkant {m(d.frontHeight)} minus takstol {Math.round(d.rafterDepth * 1000)} mm ({project.frame.rafterDim}) · fall {num(d.edgeDrop)} m · ca {num(d.angleDeg)}°
              </div>
              {lowHeadroom && (
                <div style={{ fontSize: 11.5, color: T.wood, marginTop: 6 }}>
                  Låg ståhöjd vid ytterkanten — överväg lägre lutning, högre fäste, lägre takstol eller mindre utsprång.
                </div>
              )}
            </div>
          </Section>
        )}
      </div>

      <div style={{ padding: 14, borderTop: `1px solid ${T.line}`, fontSize: 11.5, color: "#5b6675", lineHeight: 1.5 }}>
        Mått visas i meter. Kontrollera alltid mot kommunens krav inför bygganmälan.
      </div>
    </aside>
  );
}

/* ===========================================================================
   GEMENSAMMA MÅTT-KOMPONENTER (px-koordinater)
   ===========================================================================*/
const FONT = "ui-sans-serif, system-ui, -apple-system, sans-serif";

function DimH({ x1, x2, y, text, color = "#0f172a", bg = "#ffffff" }) {
  const mx = (x1 + x2) / 2;
  const w = Math.max(30, text.length * 7 + 8);
  return (
    <g>
      <line x1={x1} y1={y} x2={x2} y2={y} stroke={color} strokeWidth="1" />
      <line x1={x1} y1={y - 4} x2={x1} y2={y + 4} stroke={color} strokeWidth="1" />
      <line x1={x2} y1={y - 4} x2={x2} y2={y + 4} stroke={color} strokeWidth="1" />
      <rect x={mx - w / 2} y={y - 9} width={w} height={15} fill={bg} rx="2" />
      <text x={mx} y={y + 2.5} fontSize="11.5" fontFamily={FONT} fill={color} textAnchor="middle">{text}</text>
    </g>
  );
}

function DimV({ y1, y2, x, text, color = "#0f172a", bg = "#ffffff", side = "left" }) {
  const my = (y1 + y2) / 2;
  const w = Math.max(30, text.length * 7 + 8);
  const tx = side === "left" ? x - w / 2 - 4 : x + w / 2 + 4;
  return (
    <g>
      <line x1={x} y1={y1} x2={x} y2={y2} stroke={color} strokeWidth="1" />
      <line x1={x - 4} y1={y1} x2={x + 4} y2={y1} stroke={color} strokeWidth="1" />
      <line x1={x - 4} y1={y2} x2={x + 4} y2={y2} stroke={color} strokeWidth="1" />
      <rect x={tx - w / 2} y={my - 8} width={w} height={15} fill={bg} rx="2" />
      <text x={tx} y={my + 2.5} fontSize="11.5" fontFamily={FONT} fill={color} textAnchor="middle">{text}</text>
    </g>
  );
}

/* ===========================================================================
   2D — INTERAKTIV PLAN (mörk, dra altanen i sidled)
   ===========================================================================*/
function Plan2D({ project, set }) {
  const W = 860, H = 560, M = 64;
  const svgRef = useRef(null);
  const drag = useRef(null);
  const { house, deck } = project;
  const d = derive(project);
  const b = project.boundaries;
  const c = boundClear(project);
  const g = planGeom(project);

  // världsutbredning (meter) – inkludera aktiva sidogränser
  const xs = [-house.width / 2, house.width / 2, deck.offset - deck.width / 2, deck.offset + deck.width / 2];
  if (b.left.on) xs.push(b.left.pos);
  if (b.right.on) xs.push(b.right.pos);
  const minXm = Math.min(...xs) - 1;
  const maxXm = Math.max(...xs) + 1;
  const yMax = Math.max(house.depth, g.deckFrontY, g.eavesY, b.front.on ? b.front.pos : 0);
  const worldW = maxXm - minXm;
  const worldH = yMax + 1.5;
  const s = Math.min((W - 2 * M) / worldW, (H - 2 * M) / worldH);
  const X = (xm) => W / 2 + (xm - (minXm + maxXm) / 2) * s;
  const Y = (ym) => M + ym * s; // 0 = husbaksida överst

  const yHouseBack = 0;
  const yDeckBack = g.innerY;        // altanens anslutning (innervägg vid nisch)
  const yDeckFront = g.deckFrontY;
  const housePath = `M ${X(-house.width / 2)} ${Y(0)} L ${X(house.width / 2)} ${Y(0)} L ${X(house.width / 2)} ${Y(house.depth)} L ${X(g.recR)} ${Y(house.depth)} L ${X(g.recR)} ${Y(g.innerY)} L ${X(g.recL)} ${Y(g.innerY)} L ${X(g.recL)} ${Y(house.depth)} L ${X(-house.width / 2)} ${Y(house.depth)} Z`;

  // rutnät (1 m)
  const gridLines = [];
  const gx0 = Math.ceil(minXm), gx1 = Math.floor(maxXm);
  for (let i = gx0; i <= gx1; i++) gridLines.push(<line key={"vx" + i} x1={X(i)} y1={M - 8} x2={X(i)} y2={H - M + 8} stroke={i === 0 ? "#2c3a48" : "#1b242e"} strokeWidth="1" />);
  for (let j = 0; j <= Math.ceil(worldH); j++) gridLines.push(<line key={"hz" + j} x1={M - 10} y1={Y(j)} x2={W - M + 10} y2={Y(j)} stroke="#1b242e" strokeWidth="1" />);

  const onDown = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    const scale = r.width / W;
    const px = (e.clientX - r.left) / scale;
    const py = (e.clientY - r.top) / scale;
    if (px > X(deck.offset - deck.width / 2) - 12 && px < X(deck.offset + deck.width / 2) + 12 &&
        py > Y(yDeckBack) - 6 && py < Y(yDeckFront) + 6) {
      drag.current = { startPx: px, startOffset: deck.offset };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
  };
  const onMove = (e) => {
    if (!drag.current) return;
    const r = svgRef.current.getBoundingClientRect();
    const scale = r.width / W;
    const px = (e.clientX - r.left) / scale;
    const dm = (px - drag.current.startPx) / s;
    const lim = house.width / 2 + deck.width / 2;
    const off = clamp(Math.round((drag.current.startOffset + dm) * 20) / 20, -lim, lim);
    set((p) => {
      const dx = off - p.deck.offset;
      return { ...p, deck: { ...p.deck, offset: off }, house: { ...p.house, recess: { ...p.house.recess, offset: p.house.recess.offset + dx } } };
    });
  };
  const onUp = () => { drag.current = null; };

  return (
    <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 18, overflow: "auto" }}>
      <div style={{ width: "min(100%, 980px)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, color: T.dim, fontSize: 13 }}>
          <Pencil size={15} style={{ color: T.wood }} />
          Vy uppifrån · 1 ruta = 1 m · dra altanen i sidled för att placera den
        </div>
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: "#0b1016", borderRadius: 14, border: `1px solid ${T.line}`, touchAction: "none" }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
          {gridLines}

          {/* Hus med ev. nisch */}
          <path d={housePath} fill="#16202b" stroke={T.sky} strokeWidth="1.5" />
          <text x={X(0)} y={Y(Math.max(1, g.innerY) / 2)} fill={T.sky} fontSize="13" fontFamily={FONT} textAnchor="middle" opacity="0.85">HUS</text>
          {/* vägg som altanen sitter mot */}
          <line x1={X(g.rd > 0 ? g.recL : deck.offset - deck.width / 2)} y1={Y(yDeckBack)} x2={X(g.rd > 0 ? g.recR : deck.offset + deck.width / 2)} y2={Y(yDeckBack)} stroke={T.sky} strokeWidth="3" />

          {/* Befintligt takutsprång (takfot) */}
          {g.eavesY > house.depth + 0.001 && (
            <g>
              <line x1={X(-house.width / 2)} y1={Y(g.eavesY)} x2={X(house.width / 2)} y2={Y(g.eavesY)} stroke="#7fb4e6" strokeWidth="1.4" strokeDasharray="8 5" />
              <line x1={X(-house.width / 2)} y1={Y(house.depth)} x2={X(-house.width / 2)} y2={Y(g.eavesY)} stroke="#7fb4e6" strokeWidth="1" strokeDasharray="3 3" />
              <line x1={X(house.width / 2)} y1={Y(house.depth)} x2={X(house.width / 2)} y2={Y(g.eavesY)} stroke="#7fb4e6" strokeWidth="1" strokeDasharray="3 3" />
              <text x={X(-house.width / 2) + 6} y={Y(g.eavesY) - 6} fill="#7fb4e6" fontSize="10.5" fontFamily={FONT}>BEFINTLIG TAKFOT</text>
            </g>
          )}

          {/* Nytt altantak (streckat) */}
          {deck.hasRoof && (
            <rect x={X(deck.offset - project.roof.width / 2)} y={Y(yDeckBack)} width={project.roof.width * s} height={project.roof.depth * s}
              fill="none" stroke={T.cyan} strokeWidth="1.4" strokeDasharray="7 5" opacity="0.85" />
          )}

          {/* Altan (ansluter vid innervägg) */}
          <rect x={X(deck.offset - deck.width / 2)} y={Y(yDeckBack)} width={deck.width * s} height={deck.depth * s}
            fill="rgba(201,138,60,0.16)" stroke={T.wood} strokeWidth="2" rx="2" style={{ cursor: "grab" }} />
          {/* träplankor */}
          {Array.from({ length: Math.max(1, Math.floor(deck.width / 0.5)) }).map((_, i) => {
            const xm = deck.offset - deck.width / 2 + (i + 1) * 0.5;
            if (xm >= deck.offset + deck.width / 2) return null;
            return <line key={"pl" + i} x1={X(xm)} y1={Y(yDeckBack)} x2={X(xm)} y2={Y(yDeckFront)} stroke="rgba(201,138,60,0.35)" strokeWidth="1" />;
          })}
          <text x={X(deck.offset)} y={Y((yDeckBack + yDeckFront) / 2)} fill={T.wood} fontSize="13" fontFamily={FONT} textAnchor="middle" fontWeight="600">ALTAN</text>

          {/* räcke (streckad indragen linje) med öppning vid trappa */}
          {project.railing.on && (() => {
            const sg = stairGeom(project);
            const inset = 0.12;
            const xl = deck.offset - deck.width / 2 + inset, xr = deck.offset + deck.width / 2 - inset;
            const yf = yDeckFront - inset, yb = yDeckBack + inset;
            const cut = (a, b, g) => { if (!g) return [[a, b]]; const lo = Math.min(a, b), hi = Math.max(a, b), o = []; if (g[0] - lo > 0.05) o.push([lo, g[0]]); if (hi - g[1] > 0.05) o.push([g[1], hi]); return o; };
            const gF = sg.on && sg.side === "front" ? [sg.cx - sg.sw / 2, sg.cx + sg.sw / 2] : null;
            const gL = sg.on && sg.side === "left" ? [yDeckBack + sg.cz - sg.sw / 2, yDeckBack + sg.cz + sg.sw / 2] : null;
            const gR = sg.on && sg.side === "right" ? [yDeckBack + sg.cz - sg.sw / 2, yDeckBack + sg.cz + sg.sw / 2] : null;
            const L = [];
            cut(xl, xr, gF).forEach(([a, b]) => L.push([a, yf, b, yf]));
            cut(yb, yf, gL).forEach(([a, b]) => L.push([xl, a, xl, b]));
            cut(yb, yf, gR).forEach(([a, b]) => L.push([xr, a, xr, b]));
            if (project.railing.back) L.push([xl, yb, xr, yb]);
            return <g>{L.map(([x1, y1, x2, y2], k) => <line key={k} x1={X(x1)} y1={Y(y1)} x2={X(x2)} y2={Y(y2)} stroke={T.wood} strokeWidth="1.3" strokeDasharray="4 3" />)}</g>;
          })()}

          {/* trappa uppifrån */}
          {(() => {
            const sg = stairGeom(project);
            if (!sg.on) return null;
            const parts = [];
            if (sg.side === "front") {
              const x0 = sg.cx - sg.sw / 2;
              parts.push(<rect key="sb" x={X(x0)} y={Y(yDeckFront)} width={sg.sw * s} height={sg.proj * s} fill="rgba(94,234,212,0.10)" stroke={T.cyan} strokeWidth="1.4" />);
              for (let i = 1; i < sg.n; i++) parts.push(<line key={"sl" + i} x1={X(x0)} y1={Y(yDeckFront + i * sg.run)} x2={X(x0 + sg.sw)} y2={Y(yDeckFront + i * sg.run)} stroke={T.cyan} strokeWidth="0.9" />);
              parts.push(<text key="t" x={X(sg.cx)} y={Y(yDeckFront + sg.proj) + 13} fill={T.cyan} fontSize="10" fontFamily={FONT} textAnchor="middle">TRAPPA</text>);
            } else {
              const dir = sg.side === "left" ? -1 : 1;
              const edge = sg.side === "left" ? deck.offset - deck.width / 2 : deck.offset + deck.width / 2;
              const yMid = yDeckBack + sg.cz, x0 = Math.min(edge, edge + dir * sg.proj);
              parts.push(<rect key="sb" x={X(x0)} y={Y(yMid - sg.sw / 2)} width={sg.proj * s} height={sg.sw * s} fill="rgba(94,234,212,0.10)" stroke={T.cyan} strokeWidth="1.4" />);
              for (let i = 1; i < sg.n; i++) { const xx = edge + dir * i * sg.run; parts.push(<line key={"sl" + i} x1={X(xx)} y1={Y(yMid - sg.sw / 2)} x2={X(xx)} y2={Y(yMid + sg.sw / 2)} stroke={T.cyan} strokeWidth="0.9" />); }
              parts.push(<text key="t" x={X(edge + dir * (sg.proj + 0.35))} y={Y(yMid)} fill={T.cyan} fontSize="10" fontFamily={FONT} textAnchor="middle">TRAPPA</text>);
            }
            return <g>{parts}</g>;
          })()}
          {/* Tomtgränser (fasta linjer) */}
          {b.front.on && (
            <g>
              <line x1={X(minXm + 0.3)} y1={Y(b.front.pos)} x2={X(maxXm - 0.3)} y2={Y(b.front.pos)} stroke="#ef6b6b" strokeWidth="2" strokeDasharray="2 5" />
              <text x={X(maxXm - 0.3)} y={Y(b.front.pos) - 7} fill="#ef6b6b" fontSize="11" fontFamily={FONT} textAnchor="end">TOMTGRÄNS</text>
              <DimV y1={Y(yDeckFront)} y2={Y(b.front.pos)} x={X(deck.offset)} text={m(c.front)} color="#ef6b6b" bg="#0b1016" side="left" />
            </g>
          )}
          {b.left.on && (
            <g>
              <line x1={X(b.left.pos)} y1={Y(0)} x2={X(b.left.pos)} y2={Y(yMax)} stroke="#ef6b6b" strokeWidth="2" strokeDasharray="2 5" />
              <text x={X(b.left.pos)} y={Y(0) - 8} fill="#ef6b6b" fontSize="10.5" fontFamily={FONT} textAnchor="middle">GRÄNS</text>
              <DimH x1={X(b.left.pos)} x2={X(deck.offset - deck.width / 2)} y={Y(yDeckBack + deck.depth * 0.4)} text={m(c.left)} color="#ef6b6b" bg="#0b1016" />
            </g>
          )}
          {b.right.on && (
            <g>
              <line x1={X(b.right.pos)} y1={Y(0)} x2={X(b.right.pos)} y2={Y(yMax)} stroke="#ef6b6b" strokeWidth="2" strokeDasharray="2 5" />
              <text x={X(b.right.pos)} y={Y(0) - 8} fill="#ef6b6b" fontSize="10.5" fontFamily={FONT} textAnchor="middle">GRÄNS</text>
              <DimH x1={X(deck.offset + deck.width / 2)} x2={X(b.right.pos)} y={Y(yDeckBack + deck.depth * 0.62)} text={m(c.right)} color="#ef6b6b" bg="#0b1016" />
            </g>
          )}

          {/* Mått (cyan) */}
          {g.rd > 0 && g.utstick > 0.02 && (
            <g>
              <line x1={X(deck.offset - deck.width / 2)} y1={Y(house.depth)} x2={X(deck.offset + deck.width / 2)} y2={Y(house.depth)} stroke="#9fb3c8" strokeWidth="1.2" strokeDasharray="5 4" />
              <text x={X(deck.offset - deck.width / 2) + 4} y={Y(house.depth) - 5} fill="#9fb3c8" fontSize="10" fontFamily={FONT}>YTTERVÄGG</text>
              <DimV y1={Y(house.depth)} y2={Y(yDeckFront)} x={X(deck.offset + deck.width / 2) + 58} text={m(g.utstick)} color={T.wood} bg="#0b1016" side="right" />
            </g>
          )}
          <DimH x1={X(deck.offset - deck.width / 2)} x2={X(deck.offset + deck.width / 2)} y={Y(yDeckFront) + 22} text={m(deck.width)} color={T.cyan} bg="#0b1016" />
          <DimV y1={Y(yDeckBack)} y2={Y(yDeckFront)} x={X(deck.offset + deck.width / 2) + 26} text={m(deck.depth)} color={T.cyan} bg="#0b1016" side="right" />
          <DimH x1={X(-house.width / 2)} x2={X(house.width / 2)} y={Y(yHouseBack) - 18} text={m(house.width)} color={T.sky} bg="#0b1016" />
        </svg>
      </div>
    </div>
  );
}

/* ===========================================================================
   3D — Three.js med egen orbit-kamera
   ===========================================================================*/
function makeWoodTexture() {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#b67c39"; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 256; i += 32) {
    g.fillStyle = i % 64 === 0 ? "#a96f30" : "#bd8442";
    g.fillRect(0, i, 256, 30);
    g.strokeStyle = "rgba(80,45,15,0.5)"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
  }
  for (let k = 0; k < 60; k++) {
    g.strokeStyle = "rgba(120,70,25,0.12)"; g.beginPath();
    const x = Math.random() * 256; g.moveTo(x, 0); g.lineTo(x + (Math.random() * 20 - 10), 256); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function View3D({ project }) {
  const mount = useRef(null);
  const api = useRef(null);
  const shell = useRef(null);
  const [maxed, setMaxed] = useState(false);

  const toggleMax = () => {
    const el = shell.current;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!maxed) {
      setMaxed(true);
      // försök även äkta helskärm där det stöds (Android/desktop)
      (el?.requestFullscreen || el?.webkitRequestFullscreen)?.call(el).catch?.(() => {});
    } else {
      setMaxed(false);
      if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
  };

  // håll maxed i synk om användaren lämnar äkta helskärm
  useEffect(() => {
    const onFs = () => {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (!fsEl && maxed && !document.fullscreenElement) { /* behåll CSS-läge */ }
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, [maxed]);

  // init en gång
  useEffect(() => {
    const el = mount.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x16202c);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 600);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "grab";

    // ljus (mjukt dagsljus, undviker utfrätta ytor)
    scene.add(new THREE.HemisphereLight(0xcfe0ef, 0x3a402f, 1.05));
    const sun = new THREE.DirectionalLight(0xfff4e6, 1.7);
    sun.position.set(12, 18, 9); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0003;
    const cam = sun.shadow.camera; cam.left = -25; cam.right = 25; cam.top = 25; cam.bottom = -25; cam.near = 1; cam.far = 80;
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    // mark + rutnät (1 m linjer + tydligare 5 m linjer)
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: 0x3a4632, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    const grid = new THREE.GridHelper(60, 60, 0x55684e, 0x3a472f);
    grid.position.y = 0.01; scene.add(grid);
    const major = new THREE.GridHelper(60, 12, 0x86a07c, 0x6f8a66);
    major.position.y = 0.02; scene.add(major);

    const group = new THREE.Group(); scene.add(group);
    const wood = makeWoodTexture();

    // orbit-kamera
    const sph = { r: 17, theta: -0.85, phi: 1.05 };
    const target = new THREE.Vector3(0, 1.5, 2);
    const HOME = { r: 17, theta: -0.85, phi: 1.05, tx: 0, ty: 1.5, tz: 2 };
    const updateCam = () => {
      sph.phi = clamp(sph.phi, 0.12, Math.PI / 2 - 0.04);
      sph.r = clamp(sph.r, 5, 60);
      camera.position.set(
        target.x + sph.r * Math.sin(sph.phi) * Math.sin(sph.theta),
        target.y + sph.r * Math.cos(sph.phi),
        target.z + sph.r * Math.sin(sph.phi) * Math.cos(sph.theta)
      );
      camera.lookAt(target);
    };

    const dom = renderer.domElement;
    dom.style.touchAction = "none"; // hindra att sidan skrollar/panorerar vid rotation

    const pointers = new Map();
    let dragging = false, lx = 0, ly = 0, pinch = 0;
    const down = (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dom.setPointerCapture?.(e.pointerId);
      lx = e.clientX; ly = e.clientY; dragging = true; dom.style.cursor = "grabbing";
      if (pointers.size === 2) {
        const p = [...pointers.values()];
        pinch = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      }
    };
    const move = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2) {
        const p = [...pointers.values()];
        const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        if (pinch > 0 && d > 0) { sph.r *= pinch / d; updateCam(); }
        pinch = d;
        return;
      }
      if (!dragging) return;
      sph.theta -= (e.clientX - lx) * 0.005;
      sph.phi -= (e.clientY - ly) * 0.005;
      lx = e.clientX; ly = e.clientY; updateCam();
    };
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (pointers.size === 0) { dragging = false; dom.style.cursor = "grab"; }
      else { const p = [...pointers.values()][0]; lx = p.x; ly = p.y; }
    };
    const wheel = (e) => { e.preventDefault(); sph.r *= 1 + Math.sign(e.deltaY) * 0.08; updateCam(); };
    dom.addEventListener("pointerdown", down);
    dom.addEventListener("pointermove", move);
    dom.addEventListener("pointerup", up);
    dom.addEventListener("pointercancel", up);
    dom.addEventListener("wheel", wheel, { passive: false });

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();

    let raf;
    const loop = () => { raf = requestAnimationFrame(loop); renderer.render(scene, camera); };
    updateCam(); loop();

    // bygg-funktion
    const mat = {
      house: new THREE.MeshStandardMaterial({ color: 0xcfd6dd, roughness: 0.9 }),
      post: new THREE.MeshStandardMaterial({ color: 0x6b4a28, roughness: 0.8 }),
      roof: new THREE.MeshStandardMaterial({ color: 0x3a4350, roughness: 0.6, metalness: 0.1, transparent: true, opacity: 0.92, side: THREE.DoubleSide }),
      rafter: new THREE.MeshStandardMaterial({ color: 0xb98a4e, roughness: 0.85 }),
      batten: new THREE.MeshStandardMaterial({ color: 0xcaa162, roughness: 0.85 }),
      beam: new THREE.MeshStandardMaterial({ color: 0x7d5a30, roughness: 0.8 }),
      deck: new THREE.MeshStandardMaterial({ map: wood, roughness: 0.75 }),
      eaves: new THREE.MeshStandardMaterial({ color: 0x8a93a0, roughness: 0.8, transparent: true, opacity: 0.28, side: THREE.DoubleSide }),
      houseRoof: new THREE.MeshStandardMaterial({ color: 0x4a5360, roughness: 0.85, side: THREE.DoubleSide }),
      gable: new THREE.MeshStandardMaterial({ color: 0xc4ccd4, roughness: 0.9, side: THREE.DoubleSide }),
    };
    const addQuad = (a, b, c, d, material) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]), 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
    };
    const addTri = (a, b, c, material) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([...a, ...b, ...c]), 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
    };
    const addBox = (w, h, dd, x, y, z, material, rotX = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, dd), material);
      mesh.position.set(x, y, z); mesh.rotation.x = rotX;
      mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
    };

    const rebuild = (p) => {
      while (group.children.length) {
        const c = group.children.pop();
        c.geometry?.dispose?.();
      }
      const { house, deck, roof } = p;
      const dv = derive(p);
      const deckTop = deck.height;
      const r = house.recess;
      const rd = r.on ? r.depth : 0;
      const recL = r.offset - r.width / 2, recR = r.offset + r.width / 2;
      const overhang = house.overhang || 0;

      // Lägg modellen så att husets yttervägg (fasadliv) hamnar på en hel
      // rutnätslinje (z=0). Då ligger husets fotavtryck på linjerna vid jämna mått.
      group.position.z = -rd;

      // Hus: innervägg (där altanen sitter) vid z=0, huskroppen i -z.
      const backDepth = house.depth - rd;
      addBox(house.width, house.height, backDepth, 0, house.height / 2, -backDepth / 2, mat.house);
      if (rd > 0) {
        const leftW = recL + house.width / 2;
        const rightW = house.width / 2 - recR;
        if (leftW > 0.02) addBox(leftW, house.height, rd, (-house.width / 2 + recL) / 2, house.height / 2, rd / 2, mat.house);
        if (rightW > 0.02) addBox(rightW, house.height, rd, (recR + house.width / 2) / 2, house.height / 2, rd / 2, mat.house);
      }
      // Sadeltak på huset (nock längs fasadlängden), överhäng täcker nischen
      {
        const sideOver = 0.3;
        const xL = -house.width / 2 - sideOver, xR = house.width / 2 + sideOver;
        const frontWallZ = rd;             // yttre fasad fram
        const backWallZ = -backDepth;      // bakvägg
        const zF = frontWallZ + overhang;  // takfot fram (täcker nisch + utsprång)
        const zB = backWallZ - overhang;   // takfot bak
        const zRidge = (frontWallZ + backWallZ) / 2;
        const yE = house.height;
        const rise = (house.depth / 2) * Math.tan(((house.roofPitch || 24) * Math.PI) / 180);
        const yR = house.height + rise;
        addQuad([xL, yE, zF], [xR, yE, zF], [xR, yR, zRidge], [xL, yR, zRidge], mat.houseRoof);
        addQuad([xR, yE, zB], [xL, yE, zB], [xL, yR, zRidge], [xR, yR, zRidge], mat.houseRoof);
        addTri([-house.width / 2, yE, frontWallZ], [-house.width / 2, yE, backWallZ], [-house.width / 2, yR, zRidge], mat.gable);
        addTri([house.width / 2, yE, frontWallZ], [house.width / 2, yE, backWallZ], [house.width / 2, yR, zRidge], mat.gable);
      }

      // Altangolv (slab i +z från innerväggen)
      addBox(deck.width, 0.14, deck.depth, deck.offset, deckTop - 0.07, deck.depth / 2, mat.deck);

      // Räcke runt altangolvet. Brädorna sitter UTANPÅ stolparna, och på framsidan
      // delas panelerna mitt på varje genomgående (lång) stolpe. Samma upplägg för
      // stående brädor så de går att jämföra.
      const rail = p.railing || {};
      const sg = stairGeom(p);
      if (rail.on) {
        const rh = Math.max(0.3, rail.height || 1.0);
        const rows = Math.max(1, Math.round(rail.rows || 4));
        const boardW = 0.095;          // brädans bredd (höjd för liggande, bredd för stående)
        const boardThk = 0.026;        // tjocklek (utåt)
        const postW = 0.08;            // räckesstolpe
        const out = postW / 2 + boardThk / 2 - 0.003; // insida ligger an mot stolpens utsida (litet överlapp)
        const xL = deck.offset - deck.width / 2 + 0.05;
        const xR = deck.offset + deck.width / 2 - 0.05;
        const zB = 0.05, zF = deck.depth - 0.05;
        const railTopY = deckTop + rh;
        const vpitch = Math.max(boardW + 0.02, (xR - xL) / Math.max(2, Math.round(rail.vcount || 40))); // c/c för stående brädor
        const N = Math.max(1, Math.round(deck.posts || 1));
        const longXs = [];
        for (let i = 0; i < N; i++) { const t = N === 1 ? 0.5 : i / (N - 1); longXs.push(deck.offset - deck.width / 2 + 0.08 + t * (deck.width - 0.16)); }

        const cutR = (a, b, g) => { if (!g) return [[a, b]]; const lo = Math.min(a, b), hi = Math.max(a, b), o = []; const g0 = clamp(g[0], lo, hi), g1 = clamp(g[1], lo, hi); if (g0 - lo > 0.05) o.push([lo, g0]); if (hi - g1 > 0.05) o.push([g1, hi]); return o; };
        const sidePosts = (lo, hi, aligned) => {
          let ps = [lo, hi];
          if (aligned) ps = ps.concat(aligned.filter((x) => x > lo + 0.2 && x < hi - 0.2));
          else { const span = hi - lo, n = Math.max(1, Math.round(span / 1.6)); for (let i = 1; i < n; i++) ps.push(lo + span * i / n); }
          return [...new Set(ps.map((v) => +v.toFixed(3)))].sort((a, b) => a - b);
        };
        // axis: "x" (fram/bak, fast z=line) eller "z" (sidor, fast x=line)
        const buildSide = (axis, line, lo, hi, outSign, gap, aligned) => {
          const post = (u, w = 0.08) => { if (axis === "x") addBox(w, rh, w, u, deckTop + rh / 2, line, mat.post); else addBox(w, rh, w, line, deckTop + rh / 2, u, mat.post); };
          const hBoard = (a, b, y) => { const len = b - a; if (axis === "x") addBox(len, boardW, boardThk, (a + b) / 2, y, line + outSign * out, mat.batten); else addBox(boardThk, boardW, len, line + outSign * out, y, (a + b) / 2, mat.batten); };
          const vBoard = (u) => { if (axis === "x") addBox(boardW, rh - 0.06, boardThk, u, deckTop + rh / 2, line + outSign * out, mat.batten); else addBox(boardThk, rh - 0.06, boardW, line + outSign * out, deckTop + rh / 2, u, mat.batten); };
          // topplist – kapar brädorna (skjuter ut och täcker stolpe + brädor)
          cutR(lo, hi, gap).forEach(([a, b]) => {
            const mid = (a + b) / 2, len = b - a + 0.08, cz = line + outSign * 0.045;
            if (axis === "x") addBox(len, 0.05, 0.15, mid, railTopY, cz, mat.rafter);
            else addBox(0.15, 0.05, len, cz, railTopY, mid, mat.rafter);
          });
          // stolpar
          const posts = sidePosts(lo, hi, aligned);
          posts.forEach((u) => { if (gap && u > gap[0] + 0.02 && u < gap[1] - 0.02) return; post(u); });
          if (gap) { post(clamp(gap[0], lo, hi)); post(clamp(gap[1], lo, hi)); } // stolpar vid trappöppning
          // fyllnad per panel, monterad utanpå stolparna och insnäppt mellan dem
          for (let i = 0; i < posts.length - 1; i++) {
            cutR(posts[i], posts[i + 1], gap).forEach(([a, b]) => {
              if (b - a < 0.05) return;
              if (rail.type === "horizontal") {
                for (let k = 0; k < rows; k++) {
                  const frac = rows === 1 ? 0.5 : k / (rows - 1);
                  const y = (deckTop + 0.10) + (railTopY - 0.05 - (deckTop + 0.10)) * frac;
                  hBoard(a, b, y);
                }
              } else {
                const inset = 0.055, s0 = a + inset, s1 = b - inset, usable = s1 - s0;
                if (usable <= boardW) { vBoard((a + b) / 2); }
                else {
                  const m = Math.max(1, Math.round((b - a) / vpitch));
                  if (m === 1) vBoard((a + b) / 2);
                  else { const g2 = (usable - m * boardW) / (m - 1); for (let j = 0; j < m; j++) vBoard(s0 + boardW / 2 + j * (boardW + Math.max(0, g2))); }
                }
              }
            });
          }
        };
        const gapF = sg.on && sg.side === "front" ? [sg.cx - sg.sw / 2, sg.cx + sg.sw / 2] : null;
        const gapL = sg.on && sg.side === "left" ? [sg.cz - sg.sw / 2, sg.cz + sg.sw / 2] : null;
        const gapR = sg.on && sg.side === "right" ? [sg.cz - sg.sw / 2, sg.cz + sg.sw / 2] : null;
        buildSide("x", zF, xL, xR, +1, gapF, longXs);  // fram (delas mitt på långa stolpar)
        buildSide("z", xL, zB, zF, -1, gapL, null);    // vänster
        buildSide("z", xR, zB, zF, +1, gapR, null);    // höger
        if (rail.back) buildSide("x", zB, xL, xR, -1, null, null); // mot huset (valfritt)
      }

      // Trappa på vald sida (steg ned till mark)
      if (sg.on) {
        for (let i = 0; i < sg.n; i++) {
          const h = deckTop - (i + 1) * sg.rise; // trappstegets ovankant över mark
          if (h <= 0.001) continue;
          if (sg.side === "front") {
            addBox(sg.sw, h, sg.run, sg.cx, h / 2, deck.depth + i * sg.run + sg.run / 2, mat.deck);
          } else if (sg.side === "left") {
            addBox(sg.run, h, sg.sw, (deck.offset - deck.width / 2) - (i * sg.run + sg.run / 2), h / 2, sg.cz, mat.deck);
          } else {
            addBox(sg.run, h, sg.sw, (deck.offset + deck.width / 2) + (i * sg.run + sg.run / 2), h / 2, sg.cz, mat.deck);
          }
        }
      }

      // Tak: takstolar på högkant (hänger under takplanet), bärläkt ovanpå,
      // plåt överst och bärlinor (fram + bak) under takstolarna.
      if (deck.hasRoof) {
        const frame = p.frame || {};
        const R = roof.depth + (roof.overhangFront || 0);
        const slopeLen = Math.sqrt(R * R + dv.edgeDrop * dv.edgeDrop);
        const planeMidY = deckTop + roof.heightAtWall - dv.edgeDrop / 2; // ovankant takstol (mitt)
        const planeYat = (z) => deckTop + roof.heightAtWall - (roof.slope / 100) * z;
        const rDepth = dv.rafterDepth || 0.22;

        // Takstolar (45 mm breda, på högkant längs fallet)
        const rCC = Math.max(0.1, (frame.rafterCC || 600) / 1000);
        const nR = Math.max(2, Math.floor(roof.width / rCC) + 1);
        for (let i = 0; i < nR; i++) {
          const px = deck.offset - roof.width / 2 + (i / (nR - 1)) * roof.width;
          addBox(0.045, rDepth, slopeLen, px, planeMidY - rDepth / 2, R / 2, mat.rafter, dv.angleRad);
        }

        // Bärläkt (tvärs takstolarna, ovanpå)
        const bCC = Math.max(0.1, (frame.battenCC || 600) / 1000);
        const nB = Math.max(2, Math.floor(slopeLen / bCC) + 1);
        for (let k = 0; k < nB; k++) {
          const z = (k / (nB - 1)) * R;
          addBox(roof.width, 0.045, 0.07, deck.offset, planeYat(z) + 0.035, z, mat.batten);
        }

        // Takplåt överst
        addBox(roof.width, 0.03, slopeLen, deck.offset, planeMidY + 0.1, R / 2, mat.roof, dv.angleRad);

        // Bärlinor (fram vid stolplinjen + bak vid vägg) under takstolarna
        const bp = String(frame.beamDim || "56×225").split("×");
        const beamW = (parseFloat(bp[0]) || 56) / 1000;
        const beamH = (parseFloat(bp[1]) || 225) / 1000;
        [0.12, deck.depth].forEach((z) => {
          addBox(roof.width, beamH, beamW, deck.offset, planeYat(z) - rDepth - beamH / 2, z, mat.beam);
        });
      }

      // Stolpar: jämnt fördelade längs altangolvets bredd, går från mark
      // hela vägen upp till taket (eller golvet om inget tak). Inga separata småben.
      {
        const N = Math.max(1, Math.round(deck.posts || 1));
        const roofUnderAt = (z) => deckTop + roof.heightAtWall - (dv.drop / Math.max(0.001, roof.depth)) * clamp(z, 0, roof.depth);
        const frontTopY = deck.hasRoof ? roofUnderAt(deck.depth) : deckTop;
        const backTopY = deckTop + roof.heightAtWall;
        const xs = [];
        for (let i = 0; i < N; i++) {
          const t = N === 1 ? 0.5 : i / (N - 1);
          xs.push(deck.offset - deck.width / 2 + 0.08 + t * (deck.width - 0.16));
        }
        xs.forEach((px) => { if (frontTopY > 0.2) addBox(0.12, frontTopY, 0.12, px, frontTopY / 2, deck.depth - 0.08, mat.post); });
        if (deck.hasRoof && deck.roofAttach === "free") {
          xs.forEach((px) => addBox(0.12, backTopY, 0.12, px, backTopY / 2, 0.08, mat.post));
        }
      }

      target.set(deck.offset, deckTop + 0.6, deck.depth / 2 - rd);
      updateCam();
    };

    api.current = { rebuild, resetView: () => { Object.assign(sph, { r: HOME.r, theta: HOME.theta, phi: HOME.phi }); updateCam(); } };
    rebuild(project);

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      dom.removeEventListener("pointerdown", down);
      dom.removeEventListener("pointermove", move);
      dom.removeEventListener("pointerup", up);
      dom.removeEventListener("pointercancel", up);
      dom.removeEventListener("wheel", wheel);
      renderer.dispose(); el.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line
  }, []);

  // bygg om vid ändring
  const key = JSON.stringify(project);
  useEffect(() => { api.current?.rebuild(project); }, [key]);

  return (
    <div ref={shell} style={maxed
      ? { position: "fixed", inset: 0, zIndex: 9999, background: T.bg, overflow: "hidden" }
      : { flex: 1, position: "relative", overflow: "hidden" }}>
      <div ref={mount} style={{ position: "absolute", inset: 0 }} />
      <div style={{ position: "absolute", left: 16, bottom: 14, fontSize: 12.5, color: T.dim, background: "rgba(13,17,23,0.7)", padding: "6px 11px", borderRadius: 8, border: `1px solid ${T.line}`, pointerEvents: "none" }}>
        En finger roterar · nyp för att zooma
      </div>
      <div style={{ position: "absolute", right: 16, top: 16, display: "flex", gap: 8 }}>
        <button onClick={toggleMax} title={maxed ? "Avsluta helskärm" : "Helskärm"} style={{
          display: "flex", alignItems: "center", gap: 7,
          background: T.panel, border: `1px solid ${T.line}`, color: T.text, padding: "8px 12px", borderRadius: 9, cursor: "pointer", fontSize: 13,
        }}>{maxed ? <Minimize size={15} /> : <Maximize size={15} />} {maxed ? "Stäng" : "Helskärm"}</button>
        <button onClick={() => api.current?.resetView()} title="Återställ vy" style={{
          display: "flex", alignItems: "center", gap: 7,
          background: T.panel, border: `1px solid ${T.line}`, color: T.text, padding: "8px 12px", borderRadius: 9, cursor: "pointer", fontSize: 13,
        }}><RotateCcw size={15} /> Återställ</button>
      </div>
    </div>
  );
}

/* ===========================================================================
   TEKNISKA RITNINGAR (ljust "papper")
   ===========================================================================*/
function Paper({ title, scaleNote, width, height, children }) {
  return (
    <div style={{ background: "#fff", borderRadius: 12, overflow: "hidden", border: "1px solid #d4d9df", boxShadow: "0 1px 0 rgba(0,0,0,0.04)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "11px 16px", borderBottom: "1px solid #e6e9ed", background: "#f7f8fa" }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "#0f172a", letterSpacing: 0.3 }}>{title}</span>
        <span style={{ fontSize: 11, color: "#64748b" }}>{scaleNote}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", display: "block" }}>{children}</svg>
    </div>
  );
}

function PlanDrawing({ project, width = 720 }) {
  const { house, deck, roof } = project;
  const b = project.boundaries;
  const c = boundClear(project);
  const g = planGeom(project);
  const M = 56, H = 460;
  const xs = [-house.width / 2, house.width / 2, deck.offset - deck.width / 2, deck.offset + deck.width / 2];
  if (b.left.on) xs.push(b.left.pos);
  if (b.right.on) xs.push(b.right.pos);
  const minXm = Math.min(...xs) - 0.6;
  const maxXm = Math.max(...xs) + 0.6;
  const yMax = Math.max(house.depth, g.deckFrontY, g.eavesY, b.front.on ? b.front.pos : 0);
  const s = Math.min((width - 2 * M) / (maxXm - minXm), (H - 2 * M) / (yMax + 1));
  const X = (xm) => width / 2 + (xm - (minXm + maxXm) / 2) * s;
  const Y = (ym) => M + ym * s;
  const yDB = g.innerY, yDF = g.deckFrontY;
  const housePath = `M ${X(-house.width / 2)} ${Y(0)} L ${X(house.width / 2)} ${Y(0)} L ${X(house.width / 2)} ${Y(house.depth)} L ${X(g.recR)} ${Y(house.depth)} L ${X(g.recR)} ${Y(g.innerY)} L ${X(g.recL)} ${Y(g.innerY)} L ${X(g.recL)} ${Y(house.depth)} L ${X(-house.width / 2)} ${Y(house.depth)} Z`;

  return (
    <Paper title="PLANRITNING (uppifrån)" scaleNote={`${num(maxXm - minXm)} × ${num(yMax)} m`} width={width} height={H}>
      <rect x="0" y="0" width={width} height={H} fill="#fff" />
      <path d={housePath} fill="#eef1f4" stroke="#334155" strokeWidth="1.4" />
      <text x={X(0)} y={Y(Math.max(1, g.innerY) / 2)} fontSize="12" fontFamily={FONT} fill="#475569" textAnchor="middle">HUS</text>
      <line x1={X(g.rd > 0 ? g.recL : deck.offset - deck.width / 2)} y1={Y(yDB)} x2={X(g.rd > 0 ? g.recR : deck.offset + deck.width / 2)} y2={Y(yDB)} stroke="#0f172a" strokeWidth="2.4" />

      {g.eavesY > house.depth + 0.001 && (
        <g>
          <line x1={X(-house.width / 2)} y1={Y(g.eavesY)} x2={X(house.width / 2)} y2={Y(g.eavesY)} stroke="#3b82f6" strokeWidth="1" strokeDasharray="7 4" />
          <text x={X(-house.width / 2) + 5} y={Y(g.eavesY) - 5} fontSize="9.5" fontFamily={FONT} fill="#3b82f6">BEFINTLIG TAKFOT</text>
        </g>
      )}
      {deck.hasRoof && (
        <rect x={X(deck.offset - roof.width / 2)} y={Y(yDB)} width={roof.width * s} height={roof.depth * s} fill="none" stroke="#0ea5a4" strokeWidth="1.2" strokeDasharray="6 4" />
      )}
      <rect x={X(deck.offset - deck.width / 2)} y={Y(yDB)} width={deck.width * s} height={deck.depth * s} fill="#f3e2c9" stroke="#b07b2f" strokeWidth="1.8" />
      {project.railing.on && (() => {
        const sg = stairGeom(project);
        const i = 0.12, xl = deck.offset - deck.width / 2 + i, xr = deck.offset + deck.width / 2 - i, yf = yDF - i, yb = yDB + i;
        const lines = [];
        const cut = (a, b, g) => { // dela [a,b] runt öppning g=[g0,g1]
          if (!g) return [[a, b]];
          const lo = Math.min(a, b), hi = Math.max(a, b), out = [];
          if (g[0] - lo > 0.05) out.push([lo, g[0]]);
          if (hi - g[1] > 0.05) out.push([g[1], hi]);
          return out;
        };
        const gF = sg.on && sg.side === "front" ? [sg.cx - sg.sw / 2, sg.cx + sg.sw / 2] : null;
        const gL = sg.on && sg.side === "left" ? [yDB + sg.cz - sg.sw / 2, yDB + sg.cz + sg.sw / 2] : null;
        const gR = sg.on && sg.side === "right" ? [yDB + sg.cz - sg.sw / 2, yDB + sg.cz + sg.sw / 2] : null;
        cut(xl, xr, gF).forEach(([a, b]) => lines.push([a, yf, b, yf]));     // fram
        cut(yb, yf, gL).forEach(([a, b]) => lines.push([xl, a, xl, b]));     // vänster
        cut(yb, yf, gR).forEach(([a, b]) => lines.push([xr, a, xr, b]));     // höger
        if (project.railing.back) lines.push([xl, yb, xr, yb]);
        return <g>{lines.map(([x1, y1, x2, y2], k) => <line key={k} x1={X(x1)} y1={Y(y1)} x2={X(x2)} y2={Y(y2)} stroke="#8a5a23" strokeWidth="1.3" strokeDasharray="3 2" />)}</g>;
      })()}

      {/* trappa uppifrån */}
      {(() => {
        const sg = stairGeom(project);
        if (!sg.on) return null;
        const parts = [];
        if (sg.side === "front") {
          const x0 = sg.cx - sg.sw / 2;
          parts.push(<rect key="sb" x={X(x0)} y={Y(yDF)} width={sg.sw * s} height={sg.proj * s} fill="#efe0c6" stroke="#8a5a23" strokeWidth="1.2" />);
          for (let i = 1; i < sg.n; i++) parts.push(<line key={"sl" + i} x1={X(x0)} y1={Y(yDF + i * sg.run)} x2={X(x0 + sg.sw)} y2={Y(yDF + i * sg.run)} stroke="#8a5a23" strokeWidth="0.8" />);
          parts.push(<text key="stx" x={X(sg.cx)} y={Y(yDF + sg.proj) + 13} fontSize="9.5" fontFamily={FONT} fill="#8a5a23" textAnchor="middle">TRAPPA</text>);
        } else {
          const dir = sg.side === "left" ? -1 : 1;
          const edge = sg.side === "left" ? deck.offset - deck.width / 2 : deck.offset + deck.width / 2;
          const yMidPlan = yDB + sg.cz, x0 = Math.min(edge, edge + dir * sg.proj);
          parts.push(<rect key="sb" x={X(x0)} y={Y(yMidPlan - sg.sw / 2)} width={sg.proj * s} height={sg.sw * s} fill="#efe0c6" stroke="#8a5a23" strokeWidth="1.2" />);
          for (let i = 1; i < sg.n; i++) { const xx = edge + dir * i * sg.run; parts.push(<line key={"sl" + i} x1={X(xx)} y1={Y(yMidPlan - sg.sw / 2)} x2={X(xx)} y2={Y(yMidPlan + sg.sw / 2)} stroke="#8a5a23" strokeWidth="0.8" />); }
          parts.push(<text key="stx" x={X(edge + dir * sg.proj / 2)} y={Y(yMidPlan)} fontSize="9.5" fontFamily={FONT} fill="#8a5a23" textAnchor="middle" transform={`rotate(${dir * 90} ${X(edge + dir * sg.proj / 2)} ${Y(yMidPlan)})`}>TRAPPA</text>);
        }
        return <g>{parts}</g>;
      })()}
      <text x={X(deck.offset)} y={Y((yDB + yDF) / 2)} fontSize="12" fontFamily={FONT} fill="#8a5a23" textAnchor="middle" fontWeight="600">ALTAN</text>

      {b.front.on && (
        <g>
          <line x1={X(minXm + 0.2)} y1={Y(b.front.pos)} x2={X(maxXm - 0.2)} y2={Y(b.front.pos)} stroke="#dc2626" strokeWidth="1.4" strokeDasharray="2 5" />
          <text x={X(maxXm - 0.2)} y={Y(b.front.pos) - 6} fontSize="10" fontFamily={FONT} fill="#dc2626" textAnchor="end">TOMTGRÄNS</text>
          <DimV y1={Y(yDF)} y2={Y(b.front.pos)} x={X(deck.offset)} text={m(c.front)} side="left" color="#dc2626" />
        </g>
      )}
      {b.left.on && (
        <g>
          <line x1={X(b.left.pos)} y1={Y(0)} x2={X(b.left.pos)} y2={Y(yMax)} stroke="#dc2626" strokeWidth="1.4" strokeDasharray="2 5" />
          <DimH x1={X(b.left.pos)} x2={X(deck.offset - deck.width / 2)} y={Y(yDB + (yDF - yDB) * 0.4)} text={m(c.left)} color="#dc2626" />
        </g>
      )}
      {b.right.on && (
        <g>
          <line x1={X(b.right.pos)} y1={Y(0)} x2={X(b.right.pos)} y2={Y(yMax)} stroke="#dc2626" strokeWidth="1.4" strokeDasharray="2 5" />
          <DimH x1={X(deck.offset + deck.width / 2)} x2={X(b.right.pos)} y={Y(yDB + (yDF - yDB) * 0.62)} text={m(c.right)} color="#dc2626" />
        </g>
      )}

      {g.rd > 0 && g.utstick > 0.02 && (
        <g>
          <line x1={X(deck.offset - deck.width / 2)} y1={Y(house.depth)} x2={X(deck.offset + deck.width / 2)} y2={Y(house.depth)} stroke="#64748b" strokeWidth="1" strokeDasharray="5 4" />
          <text x={X(deck.offset - deck.width / 2) + 3} y={Y(house.depth) - 4} fill="#64748b" fontSize="9" fontFamily={FONT}>YTTERVÄGG</text>
          <DimV y1={Y(house.depth)} y2={Y(yDF)} x={X(deck.offset + deck.width / 2) + 54} text={m(g.utstick)} side="right" color="#b07b2f" />
        </g>
      )}
      <DimH x1={X(deck.offset - deck.width / 2)} x2={X(deck.offset + deck.width / 2)} y={Y(yDF) + 20} text={m(deck.width)} />
      <DimV y1={Y(yDB)} y2={Y(yDF)} x={X(deck.offset + deck.width / 2) + 24} text={m(deck.depth)} side="right" />
      <DimH x1={X(-house.width / 2)} x2={X(house.width / 2)} y={Y(0) - 16} text={m(house.width)} />
    </Paper>
  );
}

function FacadeDrawing({ project, width = 720 }) {
  const { house, deck, roof } = project;
  const d = derive(project);
  const M = 56, H = 400;
  const minXm = Math.min(-house.width / 2, deck.offset - Math.max(deck.width, roof.width) / 2) - 0.6;
  const maxXm = Math.max(house.width / 2, deck.offset + Math.max(deck.width, roof.width) / 2) + 0.6;
  const maxY = Math.max(house.height, deck.height + roof.heightAtWall) + 0.6;
  const s = Math.min((width - 2 * M) / (maxXm - minXm), (H - 2 * M) / maxY);
  const X = (xm) => width / 2 + (xm - (minXm + maxXm) / 2) * s;
  const groundY = H - M;
  const Y = (ym) => groundY - ym * s;

  const dt = deck.height, rf = deck.height + d.frontHeight, rw = deck.height + roof.heightAtWall;

  return (
    <Paper title="FASADRITNING (framifrån)" scaleNote={`B ${num(maxXm - minXm)} m · H ${num(maxY)} m`} width={width} height={H}>
      <rect x="0" y="0" width={width} height={H} fill="#fff" />
      {/* hus bakom */}
      <rect x={X(-house.width / 2)} y={Y(house.height)} width={house.width * s} height={house.height * s} fill="#f1f3f6" stroke="#94a3b8" strokeWidth="1.2" />
      {/* takets nock (bakkant) streckad */}
      {deck.hasRoof && <line x1={X(deck.offset - roof.width / 2)} y1={Y(rw)} x2={X(deck.offset + roof.width / 2)} y2={Y(rw)} stroke="#94a3b8" strokeWidth="1" strokeDasharray="4 4" />}
      {/* stolpar: jämnt fördelade, från mark upp till tak (eller golv) */}
      {Array.from({ length: Math.max(1, Math.round(deck.posts || 1)) }).map((_, i) => {
        const N = Math.max(1, Math.round(deck.posts || 1));
        const t = N === 1 ? 0.5 : i / (N - 1);
        const xm = deck.offset - deck.width / 2 + 0.1 + t * (deck.width - 0.2);
        const top = deck.hasRoof ? rf : dt;
        return <rect key={"p" + i} x={X(xm) - 3} y={Y(top)} width="6" height={top * s} fill="#6b4a28" />;
      })}
      {/* altangolv kant */}
      <rect x={X(deck.offset - deck.width / 2)} y={Y(dt)} width={deck.width * s} height={Math.max(4, 0.14 * s)} fill="#c98a3c" stroke="#8a5a23" strokeWidth="1" />

      {/* räcke (visar brädmönster) */}
      {project.railing.on && (() => {
        const rh = project.railing.height;
        const rows = Math.max(1, Math.round(project.railing.rows || 4));
        const sgF = stairGeom(project);
        const gap = sgF.on && sgF.side === "front" ? [sgF.cx - sgF.sw / 2, sgF.cx + sgF.sw / 2] : null;
        const x0 = deck.offset - deck.width / 2, x1 = deck.offset + deck.width / 2;
        const yTop = Y(dt + rh), yBot = Y(dt);
        const inGap = (xm) => gap && xm > gap[0] - 0.001 && xm < gap[1] + 0.001;
        const parts = [];
        // topplist (delas vid öppning)
        if (gap) {
          parts.push(<line key="tr1" x1={X(x0)} y1={yTop} x2={X(gap[0])} y2={yTop} stroke="#8a5a23" strokeWidth="3" strokeLinecap="round" />);
          parts.push(<line key="tr2" x1={X(gap[1])} y1={yTop} x2={X(x1)} y2={yTop} stroke="#8a5a23" strokeWidth="3" strokeLinecap="round" />);
        } else parts.push(<line key="tr" x1={X(x0)} y1={yTop} x2={X(x1)} y2={yTop} stroke="#8a5a23" strokeWidth="3" strokeLinecap="round" />);
        const nP = Math.max(2, Math.round(deck.width / 1.6) + 1);
        for (let i = 0; i < nP; i++) { const xm = x0 + deck.width * (i / (nP - 1)); if (!inGap(xm)) parts.push(<rect key={"rp" + i} x={X(xm) - 2.5} y={yTop} width="5" height={rh * s} fill="#6b4a28" />); }
        if (project.railing.type === "horizontal") {
          for (let k = 0; k < rows; k++) {
            const yy = Y(dt + 0.12 + (rh - 0.22) * (rows === 1 ? 0.5 : k / (rows - 1)));
            if (gap) { parts.push(<line key={"rbA" + k} x1={X(x0)} y1={yy} x2={X(gap[0])} y2={yy} stroke="#a9711f" strokeWidth="2" />); parts.push(<line key={"rbB" + k} x1={X(gap[1])} y1={yy} x2={X(x1)} y2={yy} stroke="#a9711f" strokeWidth="2" />); }
            else parts.push(<line key={"rb" + k} x1={X(x0)} y1={yy} x2={X(x1)} y2={yy} stroke="#a9711f" strokeWidth="2" />);
          }
        } else {
          const nb = Math.max(2, Math.round(project.railing.vcount || 40));
          for (let i = 0; i <= nb; i++) { const xm = x0 + deck.width * (i / nb); if (!inGap(xm)) parts.push(<line key={"rv" + i} x1={X(xm)} y1={yTop} x2={X(xm)} y2={yBot} stroke="#a9711f" strokeWidth="1.3" />); }
        }
        return <g>{parts}</g>;
      })()}

      {/* trappa (steg) sedd framifrån */}
      {(() => {
        const sgF = stairGeom(project);
        if (!sgF.on) return null;
        const parts = [];
        if (sgF.side === "front") {
          // sett framifrån: bredd syns, steg som horisontella linjer nedåt
          for (let i = 0; i < sgF.n; i++) {
            const yTop = Y(dt - i * sgF.rise), yb = Y(dt - (i + 1) * sgF.rise);
            parts.push(<rect key={"st" + i} x={X(sgF.cx - sgF.sw / 2)} y={yTop} width={sgF.sw * s} height={Math.max(1, yb - yTop)} fill={i % 2 ? "#d9b483" : "#cb9a5f"} stroke="#8a5a23" strokeWidth="0.6" />);
          }
        } else {
          // sidotrappa: steg sticker ut i sidled, syns i profil
          const dir = sgF.side === "left" ? -1 : 1;
          const baseX = sgF.side === "left" ? deck.offset - deck.width / 2 : deck.offset + deck.width / 2;
          for (let i = 0; i < sgF.n; i++) {
            const h = dt - (i + 1) * sgF.rise;
            const x = baseX + dir * (i * sgF.run);
            parts.push(<rect key={"st" + i} x={Math.min(X(x), X(x + dir * sgF.run))} y={Y(h)} width={sgF.run * s} height={Math.max(2, h * s)} fill="#cb9a5f" stroke="#8a5a23" strokeWidth="0.6" />);
          }
        }
        return <g>{parts}</g>;
      })()}
      {/* fascia (takets framkant) */}
      {deck.hasRoof && (
        <rect x={X(deck.offset - roof.width / 2)} y={Y(rf) - 6} width={roof.width * s} height="8" fill="#3a4350" />
      )}

      <DimV y1={groundY} y2={Y(dt)} x={X(minXm + 0.2)} text={m(deck.height)} side="right" />
      {deck.hasRoof && <DimV y1={groundY} y2={Y(rf)} x={X(maxXm - 0.2)} text={m(rf)} side="left" />}
      <DimH x1={X(deck.offset - deck.width / 2)} x2={X(deck.offset + deck.width / 2)} y={groundY + 22} text={m(deck.width)} />
      <line x1={X(minXm)} y1={groundY} x2={X(maxXm)} y2={groundY} stroke="#0f172a" strokeWidth="1.6" />
    </Paper>
  );
}

function SectionDrawing({ project, width = 720 }) {
  const { house, deck, roof } = project;
  const d = derive(project);
  const g = planGeom(project);
  const M = 58, H = 420;
  const wallSlice = 0.4;
  const cov = g.coveredDepth;
  const zMin = -wallSlice - 0.4;
  const sgS = stairGeom(project);
  const stairZ = sgS.on && sgS.side === "front" ? deck.depth + sgS.proj : 0;
  const zMax = Math.max(deck.depth, deck.hasRoof ? roof.depth + (roof.overhangFront || 0) : 0, cov, stairZ) + 0.8;
  const maxY = deck.height + (deck.hasRoof ? roof.heightAtWall : 0.4) + 0.8;
  const s = Math.min((width - 2 * M) / (zMax - zMin), (H - 2 * M) / maxY);
  const X = (zm) => M + (zm - zMin) * s;
  const groundY = H - M;
  const Y = (ym) => groundY - ym * s;

  const dt = deck.height;
  const rw = dt + roof.heightAtWall, rfH = dt + d.frontHeight;
  const rEdge = roof.depth + d.of, yEdge = dt + d.edgeHeight;

  return (
    <Paper title="SEKTIONSRITNING (från sidan)" scaleNote={`Visar taklutning ${num(project.roof.slope)} cm/m`} width={width} height={H}>
      <rect x="0" y="0" width={width} height={H} fill="#fff" />
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="#94a3b8" strokeWidth="1" />
        </pattern>
      </defs>

      {/* husvägg (snitt) */}
      <rect x={X(-wallSlice)} y={Y(house.height)} width={wallSlice * s} height={house.height * s} fill="url(#hatch)" stroke="#334155" strokeWidth="1.3" />

      {/* altangolv */}
      <rect x={X(0)} y={Y(dt)} width={deck.depth * s} height={Math.max(4, 0.14 * s)} fill="#c98a3c" stroke="#8a5a23" strokeWidth="1" />
      {!deck.hasRoof && dt > 0.25 && <rect x={X(deck.depth) - Math.max(2, 0.06 * s)} y={Y(dt)} width={Math.max(4, 0.12 * s)} height={dt * s} fill="#6b4a28" />}

      {/* räcke vid framkant (snitt – kant mot dig) */}
      {project.railing.on && (() => {
        const rh = project.railing.height, xr = X(deck.depth);
        return (
          <g>
            <line x1={xr} y1={Y(dt)} x2={xr} y2={Y(dt + rh)} stroke="#6b4a28" strokeWidth="3" />
            <line x1={xr - 7} y1={Y(dt + rh)} x2={xr + 7} y2={Y(dt + rh)} stroke="#8a5a23" strokeWidth="3" strokeLinecap="round" />
            <text x={xr + 10} y={Y(dt + rh) - 4} fontSize="9.5" fontFamily={FONT} fill="#8a5a23">räcke {m(rh)}</text>
          </g>
        );
      })()}

      {/* trappa fram i profil */}
      {sgS.on && sgS.side === "front" && (() => {
        const parts = [];
        for (let i = 0; i < sgS.n; i++) {
          const h = dt - (i + 1) * sgS.rise;
          if (h <= 0.001) continue;
          const z0 = deck.depth + i * sgS.run;
          parts.push(<rect key={"ss" + i} x={X(z0)} y={Y(h)} width={sgS.run * s} height={h * s} fill={i % 2 ? "#d9b483" : "#cb9a5f"} stroke="#8a5a23" strokeWidth="0.8" />);
        }
        parts.push(<text key="sstx" x={X(deck.depth + sgS.proj / 2)} y={groundY + 14} fontSize="9.5" fontFamily={FONT} fill="#8a5a23" textAnchor="middle">{sgS.n} steg</text>);
        return <g>{parts}</g>;
      })()}

      {/* tak: lutande linje till ytterkant + genomgående stolpe vid framkant */}
      {deck.hasRoof && (
        <>
          <line x1={X(0)} y1={Y(rw)} x2={X(rEdge)} y2={Y(yEdge)} stroke="#3a4350" strokeWidth="6" strokeLinecap="round" />
          <rect x={X(roof.depth) - Math.max(2, 0.06 * s)} y={Y(rfH)} width={Math.max(4, 0.12 * s)} height={rfH * s} fill="#6b4a28" />
          {deck.roofAttach === "free"
            ? <rect x={X(0)} y={Y(rw)} width={Math.max(4, 0.12 * s)} height={rw * s} fill="#6b4a28" />
            : <rect x={X(-0.12)} y={Y(rw) - 4} width={Math.max(5, 0.14 * s)} height="10" fill="#334155" />}
          {/* lutningstext */}
          <text x={X(roof.depth / 2)} y={Y((rw + rfH) / 2) - 10} fontSize="11" fontFamily={FONT} fill="#0ea5a4" textAnchor="middle" transform={`rotate(${-d.angleDeg} ${X(roof.depth / 2)} ${Y((rw + rfH) / 2) - 10})`}>
            {num(project.roof.slope)} cm/m
          </text>
          <DimV y1={Y(dt)} y2={Y(rw)} x={X(0) - 14} text={m(roof.heightAtWall)} side="left" color="#0ea5a4" />
          {/* takstolarnas underkant = ståhöjd */}
          <line x1={X(0)} y1={Y(rw - d.rafterDepth)} x2={X(rEdge)} y2={Y(yEdge - d.rafterDepth)} stroke="#0ea5a4" strokeWidth="1.2" strokeDasharray="5 4" />
          <text x={X(rEdge / 2)} y={Y((rw + yEdge) / 2 - d.rafterDepth) + 12} fontSize="9" fontFamily={FONT} fill="#0ea5a4" textAnchor="middle">ståhöjd (underkant takstol)</text>
          <DimV y1={Y(dt)} y2={Y(rfH - d.rafterDepth)} x={X(roof.depth) + 16} text={m(d.staFront)} side="right" color="#0ea5a4" />
          {d.of > 0.001 && (
            <DimV y1={Y(dt)} y2={Y(yEdge - d.rafterDepth)} x={X(rEdge) + 16} text={m(d.staEdge)} side="right" color="#b07b2f" />
          )}
          <DimH x1={X(0)} x2={X(rEdge)} y={Y(rw) - 22} text={m(rEdge)} />
        </>
      )}

      <DimV y1={groundY} y2={Y(dt)} x={X(deck.depth) + 16} text={m(deck.height)} side="right" />
      <DimH x1={X(0)} x2={X(deck.depth)} y={groundY + 22} text={m(deck.depth)} />
      {g.rd > 0 && g.utstick > 0.02 && (
        <g>
          <line x1={X(g.rd)} y1={Y(dt + 0.25)} x2={X(g.rd)} y2={groundY} stroke="#64748b" strokeWidth="1" strokeDasharray="5 4" />
          <text x={X(g.rd) + 3} y={Y(dt + 0.25) - 3} fontSize="9" fontFamily={FONT} fill="#64748b">YTTERVÄGG</text>
          <DimH x1={X(g.rd)} x2={X(deck.depth)} y={groundY + 39} text={`utstick ${m(g.utstick)}`} color="#b07b2f" />
        </g>
      )}

      {/* befintligt tak ovan (takutsprång) */}
      {cov > 0.02 && (
        <g>
          <line x1={X(0)} y1={Y(maxY - 0.25)} x2={X(cov)} y2={Y(maxY - 0.25)} stroke="#3b82f6" strokeWidth="1.2" strokeDasharray="7 4" />
          <line x1={X(cov)} y1={Y(maxY - 0.25)} x2={X(cov)} y2={Y(0)} stroke="#3b82f6" strokeWidth="0.8" strokeDasharray="3 3" />
          <text x={X(cov / 2)} y={Y(maxY - 0.25) - 5} fontSize="10" fontFamily={FONT} fill="#3b82f6" textAnchor="middle">BEFINTLIGT TAK ovan</text>
          <DimH x1={X(0)} x2={X(cov)} y={Y(maxY - 0.25) + 14} text={m(cov)} color="#3b82f6" />
        </g>
      )}

      {/* mark */}
      <line x1={X(zMin)} y1={groundY} x2={X(zMax)} y2={groundY} stroke="#0f172a" strokeWidth="1.6" />
      <text x={X(zMin) + 4} y={groundY + 16} fontSize="10.5" fontFamily={FONT} fill="#64748b">MARK</text>
      <text x={X(-wallSlice / 2)} y={Y(house.height) - 6} fontSize="10.5" fontFamily={FONT} fill="#64748b" textAnchor="middle">HUS</text>
    </Paper>
  );
}

/* ===========================================================================
   RITNINGAR-VYN + måttsammanställning
   ===========================================================================*/
function measureRows(project) {
  const d = derive(project);
  const c = boundClear(project);
  return [
    ["Hus – fasadlängd", m(project.house.width)],
    ...(project.house.overhang ? [["Befintligt takutsprång", m(project.house.overhang)]] : []),
    ["Hus – takvinkel", `${num(project.house.roofPitch)}°`],
    ...(project.house.recess.on ? [
      ["Nisch – bredd", m(project.house.recess.width)],
      ["Nisch – djup (indrag)", m(project.house.recess.depth)],
      ["Täckt djup under befintligt tak", m(planGeom(project).coveredDepth)],
    ] : []),
    ["Altan – bredd", m(project.deck.width)],
    ["Altan – djup/utstick", m(project.deck.depth)],
    ...(project.house.recess.on ? [["Altan – utstick utanför yttervägg", m(planGeom(project).utstick)]] : []),
    ["Altan – höjd över mark", m(project.deck.height)],
    ["Stolpar fram", `${Math.round(project.deck.posts)} st${project.deck.posts > 1 ? ` · c/c ${m(project.deck.width / (Math.round(project.deck.posts) - 1))}` : ""}`],
    ...(project.railing.on ? [["Räcke", `${m(project.railing.height)} · ${project.railing.type === "vertical" ? `stående, ${Math.max(1, Math.round(project.railing.vcount || 40))} brädor` : `liggande, ${Math.max(1, Math.round(project.railing.rows || 4))} rader`}`]] : []),
    ...(project.stairs.on ? [["Trappa", `${{ front: "fram", left: "vänster", right: "höger" }[project.stairs.side]} · ${Math.max(1, Math.round(project.stairs.steps))} steg · b ${m(stairGeom(project).sw)}`]] : []),
    ...(project.boundaries.front.on ? [["Tomtgräns – framför", m(c.front)]] : []),
    ...(project.boundaries.left.on ? [["Tomtgräns – vänster", m(c.left)]] : []),
    ...(project.boundaries.right.on ? [["Tomtgräns – höger", m(c.right)]] : []),
    ...(project.deck.hasRoof ? [
      ["Tak – bredd", m(project.roof.width)],
      ["Tak – djup", m(project.roof.depth)],
      ["Fri höjd vid husvägg", m(project.roof.heightAtWall)],
      ["Taklutning", `${num(project.roof.slope)} cm/m (${num(d.angleDeg)}°)`],
      ["Fri höjd vid framkant", m(d.frontHeight)],
      ...(d.of > 0.001 ? [
        ["Takutsprång fram", m(d.of)],
        ["Fri höjd vid yttersta takkant", m(d.edgeHeight)],
      ] : []),
      [`Ståhöjd vid framkant (under takstol ${project.frame.rafterDim})`, m(d.staFront)],
      ...(d.of > 0.001 ? [["Ståhöjd vid yttersta takkant", m(d.staEdge)]] : []),
      ["Takfäste", project.deck.roofAttach === "attached" ? "Fäst i hus" : "Fristående"],
    ] : []),
  ];
}

function MeasureTable({ project }) {
  const rows = measureRows(project);
  return (
    <div style={{ background: "#fff", border: "1px solid #d4d9df", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "11px 16px", borderBottom: "1px solid #e6e9ed", background: "#f7f8fa", fontSize: 13.5, fontWeight: 700, color: "#0f172a" }}>MÅTTSAMMANSTÄLLNING</div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i} style={{ borderBottom: "1px solid #eef1f4" }}>
              <td style={{ padding: "9px 16px", color: "#475569" }}>{k}</td>
              <td style={{ padding: "9px 16px", color: "#0f172a", fontWeight: 600, textAlign: "right" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BomTable({ project }) {
  const rows = bomRows(project);
  return (
    <div style={{ background: "#fff", border: "1px solid #d4d9df", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "11px 16px", borderBottom: "1px solid #e6e9ed", background: "#f7f8fa", fontSize: 13.5, fontWeight: 700, color: "#0f172a" }}>MATERIALLISTA (UPPSKATTAD)</div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #e6e9ed", color: "#64748b", fontSize: 11.5, textTransform: "uppercase" }}>
            <th style={{ padding: "8px 16px", textAlign: "left", fontWeight: 600 }}>Del</th>
            <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600 }}>Dimension</th>
            <th style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600 }}>Antal</th>
            <th style={{ padding: "8px 16px", textAlign: "left", fontWeight: 600 }}>Detalj</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([del, dim, antal, detalj], i) => (
            <tr key={i} style={{ borderBottom: "1px solid #eef1f4" }}>
              <td style={{ padding: "9px 16px", color: "#0f172a", fontWeight: 600 }}>{del}</td>
              <td style={{ padding: "9px 10px", color: "#475569" }}>{dim}</td>
              <td style={{ padding: "9px 10px", color: "#0f172a", fontWeight: 600, textAlign: "right", whiteSpace: "nowrap" }}>{antal}</td>
              <td style={{ padding: "9px 16px", color: "#64748b", fontSize: 12 }}>{detalj}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: "10px 16px", borderTop: "1px solid #e6e9ed", fontSize: 11, color: "#94a3b8" }}>
        Mängderna beräknas ur takets mått och dina cc-avstånd. Dimensioner och cc är egna val — kontrollera bärförmåga och snölast med konstruktör eller virkeshandel för din ort.
      </div>
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ fontSize: 12.5, color: T.dim, display: "block", marginBottom: 5 }}>{label}</span>
      <div style={{ position: "relative" }}>
        <select value={value} onChange={(e) => onChange(e.target.value)} style={{
          width: "100%", padding: "10px 32px 10px 11px", background: T.panel2, border: `1px solid ${T.line}`,
          borderRadius: 9, color: T.text, fontSize: 14.5, outline: "none", appearance: "none", WebkitAppearance: "none",
        }}>
          {options.map((o) => <option key={o} value={o} style={{ background: "#1b2530", color: T.text }}>{o}</option>)}
        </select>
        <ChevronDown size={16} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: T.dim, pointerEvents: "none" }} />
      </div>
    </label>
  );
}

const RAFTER_DIMS = ["45×170", "45×195", "45×220", "45×245", "45×295"];
const BATTEN_DIMS = ["25×48", "34×70", "45×45", "45×70"];
const BEAM_DIMS = ["45×220", "56×225 limträ", "90×225 limträ", "115×225 limträ"];
const POST_DIMS = ["95×95", "120×120", "90×90 limträ", "115×115 limträ"];

function MaterialView({ project, set }) {
  const setFrame = (k, v) => set((p) => ({ ...p, frame: { ...p.frame, [k]: v } }));
  const f = project.frame;
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 22 }}>
      <div style={{ maxWidth: 760, margin: "0 auto", display: "grid", gap: 16 }}>
        {!project.deck.hasRoof && (
          <div style={{ padding: "12px 14px", borderRadius: 11, background: "#2a1c10", border: "1px solid #5a3a1c", color: T.wood, fontSize: 13 }}>
            Altanen har inget tak just nu. Slå på "Med tak" i Altan-panelen för att få takvirke beräknat.
          </div>
        )}
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 12, color: T.text }}>Virke & cc-avstånd</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0 14px" }}>
            <Select label="Takstolar / reglar" value={f.rafterDim} onChange={(v) => setFrame("rafterDim", v)} options={RAFTER_DIMS} />
            <NumberField label="Takstolar cc" unit="mm" value={f.rafterCC} onChange={(v) => setFrame("rafterCC", Math.round(v))} step={50} min={200} max={1200} />
            <Select label="Bärläkt" value={f.battenDim} onChange={(v) => setFrame("battenDim", v)} options={BATTEN_DIMS} />
            <NumberField label="Bärläkt cc" unit="mm" value={f.battenCC} onChange={(v) => setFrame("battenCC", Math.round(v))} step={50} min={150} max={1500} />
            <Select label="Bärlinor" value={f.beamDim} onChange={(v) => setFrame("beamDim", v)} options={BEAM_DIMS} />
            <Select label="Stolpar" value={f.postDim} onChange={(v) => setFrame("postDim", v)} options={POST_DIMS} />
          </div>
          <div style={{ fontSize: 11.5, color: T.dim, marginTop: 4 }}>
            Antal stolpar styrs i Altan-panelen ({Math.round(project.deck.posts)} st fram{project.deck.roofAttach === "free" ? " + lika många bak" : ", bak infäst i vägg"}).
          </div>
        </div>
        <BomTable project={project} />
      </div>
    </div>
  );
}

function DrawingsView({ project }) {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 22 }}>
      <div style={{ maxWidth: 760, margin: "0 auto", display: "grid", gap: 18 }}>
        <PlanDrawing project={project} />
        <FacadeDrawing project={project} />
        <SectionDrawing project={project} />
        <MeasureTable project={project} />
      </div>
    </div>
  );
}

/* ===========================================================================
   UTSKRIFTSVY (visas bara vid PDF-export / utskrift)
   ===========================================================================*/
function PrintLayout({ project }) {
  const today = new Date().toLocaleDateString("sv-SE");
  return (
    <div className="print-area">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid #0f172a", paddingBottom: 10, marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 1.5, color: "#64748b", textTransform: "uppercase" }}>Bygglovsritning · altan</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "#0f172a" }}>{project.name}</div>
        </div>
        <div style={{ textAlign: "right", fontSize: 12, color: "#475569" }}>
          Datum: {today}<br />Upprättad i Altanritare
        </div>
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        <PlanDrawing project={project} width={700} />
        <FacadeDrawing project={project} width={700} />
        <SectionDrawing project={project} width={700} />
        <MeasureTable project={project} />
        {project.deck.hasRoof && <BomTable project={project} />}
      </div>
      <div style={{ marginTop: 16, fontSize: 11, color: "#94a3b8" }}>
        Förenklad ritning. Kontrollera mått och krav med din kommun inför bygganmälan.
      </div>
    </div>
  );
}

/* ===========================================================================
   APP
   ===========================================================================*/
const PRINT_CSS = `
.print-area { display: none; }
@media print {
  .app-shell { display: none !important; }
  .print-area { display: block !important; padding: 8mm; background:#fff; }
  @page { size: A4 portrait; margin: 10mm; }
}
`;

/* ===========================================================================
   PDF-EXPORT (genererar en riktig PDF i webbläsaren – funkar även på mobil)
   ===========================================================================*/
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function titleSvgBlock(p) {
  const today = new Date().toLocaleDateString("sv-SE");
  const w = 760, h = 64;
  const str = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<rect width="${w}" height="${h}" fill="#fff"/>`
    + `<text x="0" y="15" font-family="sans-serif" font-size="11" letter-spacing="1.5" fill="#64748b">BYGGLOVSRITNING · ALTAN</text>`
    + `<text x="0" y="44" font-family="sans-serif" font-size="23" font-weight="800" fill="#0f172a">${xmlEsc(p.name || "Altanprojekt")}</text>`
    + `<text x="${w}" y="20" text-anchor="end" font-family="sans-serif" font-size="12" fill="#475569">Datum: ${today}</text>`
    + `<line x1="0" y1="${h - 6}" x2="${w}" y2="${h - 6}" stroke="#0f172a" stroke-width="2"/></svg>`;
  return { str, w, h };
}

function tableSvgBlock(title, rows, width) {
  const rowH = 22, headH = 30, h = headH + rows.length * rowH + 2;
  let b = `<rect x="0" y="0" width="${width}" height="${h}" fill="#fff" stroke="#d4d9df"/>`;
  b += `<rect x="0" y="0" width="${width}" height="${headH}" fill="#f7f8fa"/>`;
  b += `<line x1="0" y1="${headH}" x2="${width}" y2="${headH}" stroke="#e6e9ed"/>`;
  b += `<text x="14" y="${headH - 10}" font-family="sans-serif" font-size="13" font-weight="700" fill="#0f172a">${xmlEsc(title)}</text>`;
  rows.forEach((r, i) => {
    const y = headH + i * rowH;
    b += `<text x="14" y="${y + 15}" font-family="sans-serif" font-size="12" fill="#475569">${xmlEsc(r[0])}</text>`;
    b += `<text x="${width - 14}" y="${y + 15}" text-anchor="end" font-family="sans-serif" font-size="12" font-weight="600" fill="#0f172a">${xmlEsc(r[1])}</text>`;
    if (i < rows.length - 1) b += `<line x1="0" y1="${y + rowH}" x2="${width}" y2="${y + rowH}" stroke="#eef1f4"/>`;
  });
  return { str: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${b}</svg>`, w: width, h };
}

function domSvgBlock(svgEl) {
  const vb = (svgEl.getAttribute("viewBox") || "0 0 700 460").split(/\s+/).map(Number);
  const w = vb[2] || 700, h = vb[3] || 460;
  const clone = svgEl.cloneNode(true);
  clone.removeAttribute("style");
  clone.setAttribute("width", w); clone.setAttribute("height", h);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return { str: new XMLSerializer().serializeToString(clone), w, h };
}

const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
const svgUrl = (s) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);

function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.split(",")[1]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function renderPageImage(blocks) {
  const CW = 760, gap = 16, padTop = 6, scale = 2;
  const items = blocks.map((b) => ({ b, hh: b.h * (CW / b.w) }));
  const totalH = padTop + items.reduce((s, it) => s + it.hh + gap, 0);
  const canvas = document.createElement("canvas");
  canvas.width = CW * scale; canvas.height = Math.ceil(totalH) * scale;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = padTop;
  for (const it of items) {
    const img = await loadImg(svgUrl(it.b.str));
    ctx.drawImage(img, 0, y * scale, CW * scale, it.hh * scale);
    y += it.hh + gap;
  }
  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  return { jpeg: dataUrlToBytes(dataUrl), dataUrl, w: canvas.width, h: canvas.height };
}

function buildPdf(pages) {
  const A4 = [595.28, 841.89], margin = 26;
  const chunks = []; let len = 0; const off = [];
  const enc = new TextEncoder();
  const pushS = (s) => { const u = enc.encode(s); chunks.push(u); len += u.length; };
  const pushB = (u) => { chunks.push(u); len += u.length; };
  pushS("%PDF-1.4\n");
  let n = 3;
  const pg = pages.map((p) => ({ ...p, img: n++, content: n++, page: n++ }));
  const totalObjs = n - 1;
  const obj = (num, body) => { off[num] = len; pushS(`${num} 0 obj\n${body}\nendobj\n`); };
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pg.map((p) => `${p.page} 0 R`).join(" ")}] >>`);
  pg.forEach((p) => {
    off[p.img] = len;
    pushS(`${p.img} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    pushB(p.jpeg); pushS("\nendstream\nendobj\n");
    const sc = Math.min((A4[0] - margin * 2) / p.w, (A4[1] - margin * 2) / p.h);
    const dw = p.w * sc, dh = p.h * sc, tx = (A4[0] - dw) / 2, ty = A4[1] - margin - dh;
    const cs = `q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${tx.toFixed(2)} ${ty.toFixed(2)} cm /Im0 Do Q`;
    obj(p.content, `<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`);
    obj(p.page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4[0]} ${A4[1]}] /Resources << /XObject << /Im0 ${p.img} 0 R >> >> /Contents ${p.content} 0 R >>`);
  });
  const xrefAt = len;
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjs; i++) xref += String(off[i] || 0).padStart(10, "0") + " 00000 n \n";
  pushS(xref);
  pushS(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`);
  const out = new Uint8Array(len); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return new Blob([out], { type: "application/pdf" });
}

async function buildPdfUrl(project) {
  const drawings = [...document.querySelectorAll(".print-area svg")].map(domSvgBlock);
  if (!drawings.length) throw new Error("Hittade inga ritningar att exportera.");
  const title = titleSvgBlock(project);
  const measure = tableSvgBlock("MÅTTSAMMANSTÄLLNING", measureRows(project), 760);
  const bom = project.deck.hasRoof
    ? tableSvgBlock("MATERIALLISTA (UPPSKATTAD)", bomRows(project).map((r) => [r[0], `${r[2]} · ${r[1]}`]), 760)
    : null;

  const pagesBlocks = [];
  if (drawings[0]) pagesBlocks.push([title, drawings[0]]);
  if (drawings[1]) pagesBlocks.push([drawings[1]]);
  if (drawings[2]) pagesBlocks.push([drawings[2]]);
  pagesBlocks.push(bom ? [measure, bom] : [measure]);

  const pages = [];
  for (const blocks of pagesBlocks) pages.push(await renderPageImage(blocks));
  const blob = buildPdf(pages);
  const safe = (project.name || "altan").replace(/[^\w\-åäöÅÄÖ ]+/g, "").trim() || "altan";
  return { blob, url: URL.createObjectURL(blob), name: `${safe}.pdf`, images: pages.map((p) => p.dataUrl) };
}

export default function App() {
  const [started, setStarted] = useState(false);
  const [project, setProject] = useState(DEFAULT_PROJECT);
  const [view, setView] = useState("2d");
  const [openSection, setOpenSection] = useState("deck");
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" && window.innerWidth < 820);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    const on = () => setIsMobile(mq.matches);
    on();
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on); };
  }, []);

  const start = (name, choice) => {
    setProject((p) => ({
      ...p, name,
      deck: { ...p.deck, hasRoof: choice === "roof" ? true : p.deck.hasRoof },
    }));
    setOpenSection(choice);
    setView(choice === "roof" ? "3d" : "2d");
    setStarted(true);
  };

  // --- Spara / öppna projekt ---
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [saves, setSaves] = useState({});
  const [toast, setToast] = useState(null);
  const fileRef = useRef(null);
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  // Autoladda senaste arbetet vid start
  useEffect(() => {
    setSaves(loadSaves());
    try {
      const auto = lsGet(LS_AUTO);
      if (auto) {
        const data = JSON.parse(auto);
        if (data && data.house && data.deck) {
          setProject({ ...DEFAULT_PROJECT, ...data, railing: { ...DEFAULT_PROJECT.railing, ...(data.railing || {}) } });
          setStarted(true);
        }
      }
    } catch (_) { /* ignorera */ }
  }, []);

  // Autospara löpande
  useEffect(() => {
    if (started) lsSet(LS_AUTO, JSON.stringify(project));
  }, [project, started]);

  const saveProject = () => {
    const name = (project.name || "").trim() || "Namnlöst projekt";
    const next = { ...loadSaves(), [name]: { project, savedAt: Date.now() } };
    storeSaves(next); setSaves(next);
    showToast(`Sparat: ${name}`);
  };
  const loadProject = (name) => {
    const s = loadSaves()[name];
    if (!s) return;
    setProject({ ...DEFAULT_PROJECT, ...s.project, railing: { ...DEFAULT_PROJECT.railing, ...(s.project.railing || {}) } });
    setStarted(true); setProjectsOpen(false);
    showToast(`Öppnade: ${name}`);
  };
  const deleteProject = (name) => {
    const next = { ...loadSaves() }; delete next[name];
    storeSaves(next); setSaves(next);
  };
  const exportProjectFile = () => {
    try {
      const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${(project.name || "altan").replace(/[^\w\-åäöÅÄÖ ]+/g, "").trim() || "altan"}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (_) { showToast("Kunde inte exportera filen här"); }
  };
  const importProjectFile = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data.house || !data.deck) throw new Error("fel format");
        setProject({ ...DEFAULT_PROJECT, ...data, railing: { ...DEFAULT_PROJECT.railing, ...(data.railing || {}) } });
        setStarted(true); setProjectsOpen(false);
        showToast("Projektfil öppnad");
      } catch (_) { showToast("Ogiltig projektfil"); }
    };
    reader.readAsText(f);
    e.target.value = "";
  };

  const [exporting, setExporting] = useState(false);
  const [pdf, setPdf] = useState(null);       // { url, name }
  const [exportError, setExportError] = useState(null);
  const exportPDF = async () => {
    if (exporting) return;
    setExporting(true); setExportError(null);
    try {
      const res = await buildPdfUrl(project);
      setPdf(res);
    } catch (e) {
      setExportError(String((e && e.message) || e));
    } finally {
      setExporting(false);
    }
  };
  const closePdf = () => {
    if (pdf) setTimeout(() => URL.revokeObjectURL(pdf.url), 1000);
    setPdf(null);
  };
  const sharePdf = async () => {
    if (!pdf) return;
    try {
      const file = new File([pdf.blob], pdf.name, { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: pdf.name });
        return;
      }
    } catch (e) { /* faller igenom till nedladdning */ }
    try {
      const a = document.createElement("a");
      a.href = pdf.url; a.download = pdf.name; a.target = "_blank"; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { /* ignoreras – bilderna nedan funkar ändå */ }
  };

  if (!started) {
    return (<>
      <style>{PRINT_CSS}</style>
      <div style={{ position: "fixed", inset: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", fontFamily: FONT }}><StartScreen onStart={start} /></div>
    </>);
  }

  const tabs = [
    { id: "2d", label: "2D", Icon: Pencil },
    { id: "3d", label: "3D", Icon: Box },
    { id: "drawings", label: "Ritningar", Icon: Layers },
    { id: "material", label: "Material", Icon: Hammer },
  ];

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div className="app-shell" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: T.bg, color: T.text, fontFamily: FONT }}>
        {/* Toppbar */}
        <header style={{ height: 56, flexShrink: 0, display: "flex", alignItems: "center", gap: isMobile ? 8 : 14, padding: isMobile ? "0 10px" : "0 16px", borderBottom: `1px solid ${T.line}`, background: T.panel }}>
          {isMobile ? (
            <button onClick={() => setSidebarOpen(true)} title="Inställningar" style={{ display: "grid", placeItems: "center", width: 38, height: 38, background: "#10161e", border: `1px solid ${T.line}`, borderRadius: 9, color: T.text, cursor: "pointer", flexShrink: 0 }}>
              <Menu size={18} />
            </button>
          ) : (
            <button onClick={() => setStarted(false)} title="Till start" style={{ display: "flex", alignItems: "center", gap: 9, background: "transparent", border: "none", color: T.text, cursor: "pointer" }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", background: `linear-gradient(135deg, ${T.wood}, ${T.woodDark})`, color: "#1a1206" }}><Ruler size={17} /></div>
              <span style={{ fontWeight: 700, fontSize: 14.5 }}>Altanritare</span>
            </button>
          )}

          <div style={{ marginLeft: isMobile ? 0 : 8, display: "flex", background: "#10161e", border: `1px solid ${T.line}`, borderRadius: 10, padding: 3, gap: 3, overflowX: "auto" }}>
            {tabs.map(({ id, label, Icon }) => (
              <button key={id} onClick={() => setView(id)} style={{
                display: "flex", alignItems: "center", gap: 7, padding: isMobile ? "8px 10px" : "7px 14px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 13.5, whiteSpace: "nowrap",
                background: view === id ? T.panel2 : "transparent", color: view === id ? T.text : T.dim, fontWeight: view === id ? 650 : 500,
              }}><Icon size={15} />{!isMobile && ` ${label}`}</button>
            ))}
          </div>

          {!isMobile && <div style={{ marginLeft: "auto", color: T.dim, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 }}>{project.name}</div>}
          <button onClick={exportPDF} disabled={exporting} title="Exportera som PDF" style={{
            marginLeft: isMobile ? "auto" : 0, flexShrink: 0, whiteSpace: "nowrap",
            display: "flex", alignItems: "center", gap: 8, background: T.wood, border: "none", color: "#1a1206",
            padding: isMobile ? "9px 11px" : "9px 14px", borderRadius: 10, cursor: exporting ? "default" : "pointer", fontSize: 13.5, fontWeight: 650, opacity: exporting ? 0.7 : 1,
          }}><Download size={16} />{isMobile ? (exporting ? " …" : " PDF") : (exporting ? " Skapar PDF…" : " Exportera som PDF")}</button>
        </header>

        {/* Kropp */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
          {!isMobile && <Sidebar project={project} set={setProject} openSection={openSection} setOpenSection={setOpenSection} onSave={saveProject} onOpenProjects={() => setProjectsOpen(true)} />}
          <main style={{ flex: 1, display: "flex", overflow: "hidden", background: T.bg }}>
            {view === "2d" && <Plan2D project={project} set={setProject} />}
            {view === "3d" && <View3D project={project} />}
            {view === "drawings" && <DrawingsView project={project} />}
            {view === "material" && <MaterialView project={project} set={setProject} />}
          </main>

          {/* Mobil: utfällbar sidopanel */}
          {isMobile && sidebarOpen && (
            <div onClick={() => setSidebarOpen(false)} style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(5,8,12,0.55)" }}>
              <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: "min(320px, 86%)", boxShadow: "2px 0 24px rgba(0,0,0,0.45)" }}>
                <Sidebar project={project} set={setProject} openSection={openSection} setOpenSection={setOpenSection} width="100%" onClose={() => setSidebarOpen(false)} onSave={saveProject} onOpenProjects={() => setProjectsOpen(true)} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Endast för utskrift / PDF */}
      <PrintLayout project={project} />

      {/* PDF klar – dela/spara, eller långtryck på bilderna för att spara */}
      {pdf && (
        <div onClick={closePdf} style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(5,8,12,0.78)", display: "grid", placeItems: "center", padding: 16, fontFamily: FONT }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(440px, 100%)", maxHeight: "90vh", overflowY: "auto", background: T.panel, border: `1px solid ${T.line}`, borderRadius: 16, padding: 20, color: T.text }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>PDF:en är klar</div>
            <div style={{ fontSize: 13, color: T.dim, marginBottom: 16, lineHeight: 1.5 }}>
              Tryck för att dela eller spara filen. Om det inte öppnar något kan du långtrycka på en ritning nedan och spara den som bild.
            </div>
            <button onClick={sharePdf} style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              background: T.wood, color: "#1a1206", border: "none", padding: "13px 16px", borderRadius: 11, fontSize: 15, fontWeight: 700, cursor: "pointer",
            }}><Download size={18} /> Dela / spara PDF</button>

            <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
              {pdf.images.map((src, i) => (
                <img key={i} src={src} alt={`Sida ${i + 1}`} style={{ width: "100%", borderRadius: 8, border: `1px solid ${T.line}`, background: "#fff" }} />
              ))}
            </div>

            <button onClick={closePdf} style={{ width: "100%", marginTop: 14, background: "transparent", border: `1px solid ${T.line}`, color: T.dim, padding: "10px", borderRadius: 11, cursor: "pointer", fontSize: 13.5 }}>Stäng</button>
          </div>
        </div>
      )}

      {exportError && (
        <div style={{ position: "fixed", zIndex: 10000, left: "50%", bottom: 24, transform: "translateX(-50%)", maxWidth: "90%", background: "#2a1414", border: "1px solid #5a2a2a", color: "#ffd9d9", padding: "11px 16px", borderRadius: 11, fontSize: 13, fontFamily: FONT, display: "flex", gap: 12, alignItems: "center" }}>
          <span>Kunde inte skapa PDF: {exportError}</span>
          <button onClick={() => setExportError(null)} style={{ background: "transparent", border: "none", color: "#ffd9d9", cursor: "pointer", fontSize: 16 }}>×</button>
        </div>
      )}

      {/* Mina projekt */}
      {projectsOpen && (
        <div onClick={() => setProjectsOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(5,8,12,0.78)", display: "grid", placeItems: "center", padding: 16, fontFamily: FONT }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(440px, 100%)", maxHeight: "88vh", overflowY: "auto", background: T.panel, border: `1px solid ${T.line}`, borderRadius: 16, padding: 20, color: T.text }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>Mina projekt</div>
              <button onClick={() => setProjectsOpen(false)} style={{ background: "transparent", border: "none", color: T.dim, cursor: "pointer", fontSize: 18 }}>✕</button>
            </div>

            <button onClick={saveProject} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: T.wood, color: "#1a1206", border: "none", padding: "12px", borderRadius: 11, fontSize: 14.5, fontWeight: 700, cursor: "pointer" }}>
              <Save size={16} /> Spara "{(project.name || "Namnlöst").trim()}"
            </button>

            <div style={{ margin: "16px 0 8px", fontSize: 12, color: T.dim, letterSpacing: 0.5, textTransform: "uppercase" }}>Sparade projekt</div>
            {Object.keys(saves).length === 0 ? (
              <div style={{ fontSize: 13, color: T.dim, padding: "8px 0 4px" }}>Inga sparade projekt än.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {Object.entries(saves).sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0)).map(([name, s]) => (
                  <div key={name} style={{ display: "flex", alignItems: "center", gap: 8, background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 10, padding: "9px 11px" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                      <div style={{ fontSize: 11.5, color: T.dim }}>{s.savedAt ? new Date(s.savedAt).toLocaleDateString("sv-SE", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}</div>
                    </div>
                    <button onClick={() => loadProject(name)} style={{ background: T.wood, color: "#1a1206", border: "none", borderRadius: 8, padding: "7px 12px", cursor: "pointer", fontSize: 13, fontWeight: 650 }}>Öppna</button>
                    <button onClick={() => deleteProject(name)} title="Ta bort" style={{ background: "transparent", border: `1px solid ${T.line}`, color: T.dim, borderRadius: 8, padding: "7px 10px", cursor: "pointer", fontSize: 13 }}>Ta bort</button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ margin: "18px 0 8px", fontSize: 12, color: T.dim, letterSpacing: 0.5, textTransform: "uppercase" }}>Säkerhetskopia (fil)</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={exportProjectFile} style={{ flex: 1, background: T.panel2, border: `1px solid ${T.line}`, color: T.text, borderRadius: 10, padding: "10px", cursor: "pointer", fontSize: 13 }}>Exportera fil</button>
              <button onClick={() => fileRef.current && fileRef.current.click()} style={{ flex: 1, background: T.panel2, border: `1px solid ${T.line}`, color: T.text, borderRadius: 10, padding: "10px", cursor: "pointer", fontSize: 13 }}>Öppna fil</button>
            </div>
            <input ref={fileRef} type="file" accept="application/json,.json" onChange={importProjectFile} style={{ display: "none" }} />
            <div style={{ fontSize: 11.5, color: T.dim, marginTop: 10, lineHeight: 1.5 }}>
              Sparade projekt ligger i denna webbläsare. Exportera en fil för att flytta projektet till en annan enhet eller som backup.
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{ position: "fixed", zIndex: 10001, left: "50%", bottom: 24, transform: "translateX(-50%)", background: "#13351f", border: "1px solid #2c6b41", color: "#d6ffe4", padding: "10px 16px", borderRadius: 11, fontSize: 13, fontFamily: FONT }}>
          {toast}
        </div>
      )}
    </>
  );
}
