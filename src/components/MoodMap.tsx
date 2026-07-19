import { useEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson';
import { MOODS, MOOD_LIST, valenceColor, type MoodId } from '@shared/moods';
import { cellPolygon, parseCellId, resForZoom } from '@shared/grid';
import { K_ANONYMITY, type AggregateCell } from '@shared/types';
import { signedPct } from '../format';

const SRC_ID = 'mood-cells';
const GLOW_SRC_ID = 'mood-cell-centers';
const GLOW_ID = 'mood-cells-glow';
const FILL_ID = 'mood-cells-fill';
const LINE_ID = 'mood-cells-line';
const HOVER_FILL_ID = 'mood-cells-hover-fill';
const HOVER_LINE_ID = 'mood-cells-hover-line';
const SELECT_ID = 'mood-cells-selected';
const EMOJI_ID = 'mood-cells-emoji';

/**
 * Mood emojis are rendered onto a canvas with the system emoji font and
 * registered as map images — MapLibre's glyph pipeline is monochrome SDF,
 * so real colored emoji must come in as icons, not text.
 */
const EMOJI_IMG_SIZE = 64;
const EMOJI_IMG_RATIO = 2;

function makeEmojiImage(emoji: string): ImageData | null {
  const px = EMOJI_IMG_SIZE * EMOJI_IMG_RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = `${Math.round(px * 0.72)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Soft dark halo so emojis stay readable over bright glow areas.
  ctx.shadowColor = 'rgba(4, 8, 20, 0.55)';
  ctx.shadowBlur = px * 0.06;
  ctx.fillText(emoji, px / 2, px / 2 + px * 0.03);
  return ctx.getImageData(0, 0, px, px);
}

/**
 * Basemap style chain: production dark basemap → maplibre demo tiles →
 * flat inline dark background. Each step is tried only if the previous
 * one errors before its first successful style.load.
 */
const PRIMARY_STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const SECONDARY_STYLE_URL = 'https://demotiles.maplibre.org/style.json';

/** Flat dark background used when no remote style can be fetched. */
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1020' } }],
};

const INTRO_ZOOM_FROM = 0.9;
const INTRO_ZOOM_TO = 1.7;
const MAX_LIVE_RIPPLES = 8;
const RIPPLE_MS = 1800;
/** Breathing bounds for the glow layer's (non-data-driven) circle-opacity. */
const GLOW_OPACITY_MID = 0.16;
const GLOW_OPACITY_AMP = 0.06;
const GLOW_BREATH_PERIOD_MS = 5000;

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface CellProps {
  cellId: string;
  count: number;
  valence: number;
  topMood: string;
  color: string;
}

function cellProperties(c: AggregateCell): CellProps {
  return {
    cellId: c.cellId,
    count: c.count,
    valence: c.valence,
    topMood: c.topMood,
    // precomputed so layers can use a simple ['get', 'color']
    color: valenceColor(c.valence),
  };
}

function toGeoJson(cells: AggregateCell[]): FeatureCollection<Polygon, CellProps> {
  return {
    type: 'FeatureCollection',
    features: cells.map(
      (c): Feature<Polygon, CellProps> => ({
        type: 'Feature',
        properties: cellProperties(c),
        geometry: { type: 'Polygon', coordinates: [cellPolygon(c.cellId)] },
      }),
    ),
  };
}

/** Cell CENTER points for the soft aurora glow layer under the grid. */
function toGlowGeoJson(cells: AggregateCell[]): FeatureCollection<Point, CellProps> {
  return {
    type: 'FeatureCollection',
    features: cells.flatMap((c): Array<Feature<Point, CellProps>> => {
      const info = safeParseCell(c.cellId);
      if (!info) return [];
      return [
        {
          type: 'Feature',
          properties: cellProperties(c),
          geometry: { type: 'Point', coordinates: [info.centerLng, info.centerLat] },
        },
      ];
    }),
  };
}

function cellFilter(cellId: string | null): ExpressionSpecification {
  return ['==', ['get', 'cellId'], cellId ?? ''] as unknown as ExpressionSpecification;
}

function safeParseCell(cellId: string) {
  try {
    return parseCellId(cellId);
  } catch {
    return null;
  }
}

export interface LivePulse {
  cellId: string;
  mood: MoodId;
  key: number;
}

interface Props {
  cells: AggregateCell[];
  selectedCellId: string | null;
  picking: boolean;
  reportPulse: { cellId: string; key: number } | null;
  /** SSE pulse ripples (res-0 cells). Parent skips these while scrubbing. */
  livePulse: LivePulse | null;
  onResChange: (res: number) => void;
  onSelectCell: (cellId: string | null) => void;
  onPick: (lat: number, lng: number) => void;
  onCenterChange: (center: { lat: number; lng: number }) => void;
}

interface RippleEntry {
  marker: maplibregl.Marker;
  timer: number;
}

export function MoodMap(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const pickingRef = useRef(props.picking);
  pickingRef.current = props.picking;
  const selectedRef = useRef(props.selectedCellId);
  selectedRef.current = props.selectedCellId;
  const ripplesRef = useRef<RippleEntry[]>([]);

  const data = useMemo(() => toGeoJson(props.cells), [props.cells]);
  const dataRef = useRef(data);
  dataRef.current = data;
  const glowData = useMemo(() => toGlowGeoJson(props.cells), [props.cells]);
  const glowDataRef = useRef(glowData);
  glowDataRef.current = glowData;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const reduced = prefersReducedMotion();

    const map = new maplibregl.Map({
      container,
      style: PRIMARY_STYLE_URL,
      center: [10, 25],
      zoom: reduced ? INTRO_ZOOM_TO : INTRO_ZOOM_FROM,
      minZoom: 0.6,
      attributionControl: { compact: true },
      // Keep the WebGL buffer readable after each frame so the share
      // feature (src/share.ts) can draw the map onto a snapshot canvas.
      // Small performance cost, required for canvas capture.
      preserveDrawingBuffer: true,
    });
    mapRef.current = map;
    // Console debug handle AND the capture handle the share feature
    // (src/share.ts) reads the map canvas from.
    (window as unknown as { __moodMap?: maplibregl.Map }).__moodMap = map;

    let removed = false;
    let styleEverLoaded = false;
    let fallbackStage = 0; // 0 = primary, 1 = demo tiles, 2 = inline dark
    let handlersBound = false;
    let hoveredCell: string | null = null;

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: 'cell-popup',
      maxWidth: '260px',
    });

    const setHover = (cellId: string | null) => {
      if (hoveredCell === cellId) return;
      hoveredCell = cellId;
      const f = cellFilter(cellId);
      if (map.getLayer(HOVER_FILL_ID)) map.setFilter(HOVER_FILL_ID, f);
      if (map.getLayer(HOVER_LINE_ID)) map.setFilter(HOVER_LINE_ID, f);
    };

    const bindLayerEvents = () => {
      if (handlersBound) return;
      handlersBound = true;
      // Delegated listeners live on the Map, so they survive style swaps.
      map.on('mousemove', FILL_ID, (e) => {
        if (pickingRef.current) {
          setHover(null);
          return;
        }
        const f = e.features && e.features[0];
        if (!f) return;
        map.getCanvas().style.cursor = 'pointer';
        const p = f.properties as Partial<CellProps>;
        setHover(typeof p.cellId === 'string' ? p.cellId : null);
        const mood = typeof p.topMood === 'string' && p.topMood in MOODS ? MOODS[p.topMood as MoodId] : null;
        const count = typeof p.count === 'number' ? p.count : 0;
        const valence = typeof p.valence === 'number' ? p.valence : 0;
        popup
          .setLngLat(e.lngLat)
          .setHTML(
            '<div class="cell-popup-inner">' +
              `<div class="cell-popup-mood">${mood ? `${mood.emoji} ${mood.label}` : '—'}</div>` +
              `<div class="cell-popup-meta">${count} report${count === 1 ? '' : 's'} · valence ${signedPct(valence)}</div>` +
              '</div>',
          )
          .addTo(map);
      });
      map.on('mouseleave', FILL_ID, () => {
        map.getCanvas().style.cursor = pickingRef.current ? 'crosshair' : '';
        setHover(null);
        popup.remove();
      });
      map.on('click', FILL_ID, (e) => {
        if (pickingRef.current) return;
        const f = e.features && e.features[0];
        const cellId = f && typeof f.properties.cellId === 'string' ? (f.properties.cellId as string) : null;
        if (cellId) propsRef.current.onSelectCell(cellId);
      });
    };

    const ensureLayers = () => {
      if (removed || map.getSource(SRC_ID)) return;
      map.addSource(SRC_ID, { type: 'geojson', data: dataRef.current });
      map.addSource(GLOW_SRC_ID, { type: 'geojson', data: glowDataRef.current });
      // Soft aurora under the grid: blurred circles at cell centers,
      // colored by the same precomputed valence color. circle-opacity is a
      // plain number (NOT data-driven) so the breathing loop can modulate
      // it with a single cheap setPaintProperty per tick.
      map.addLayer({
        id: GLOW_ID,
        type: 'circle',
        source: GLOW_SRC_ID,
        paint: {
          'circle-color': ['get', 'color'] as unknown as ExpressionSpecification,
          'circle-blur': 1,
          'circle-opacity': GLOW_OPACITY_MID,
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            0,
            ['interpolate', ['linear'], ['get', 'count'], K_ANONYMITY, 4, 50, 9, 300, 16],
            3.5,
            ['interpolate', ['linear'], ['get', 'count'], K_ANONYMITY, 12, 50, 26, 300, 44],
            7,
            ['interpolate', ['linear'], ['get', 'count'], K_ANONYMITY, 26, 50, 54, 300, 90],
          ] as unknown as ExpressionSpecification,
        },
      });
      // Cells are now a SUBTLE valence tint — the mood emojis (below) carry
      // the story; the fill mostly provides region shape + hover/click area.
      map.addLayer({
        id: FILL_ID,
        type: 'fill',
        source: SRC_ID,
        paint: {
          'fill-color': ['get', 'color'] as unknown as ExpressionSpecification,
          'fill-opacity': [
            'interpolate',
            ['linear'],
            ['get', 'count'],
            K_ANONYMITY,
            0.08,
            50,
            0.13,
            300,
            0.18,
          ] as unknown as ExpressionSpecification,
        },
      });
      map.addLayer({
        id: LINE_ID,
        type: 'line',
        source: SRC_ID,
        paint: { 'line-color': 'rgba(235, 242, 255, 0.07)', 'line-width': 0.6 },
      });
      // Hover highlight: a faint brightening fill plus a crisp outline,
      // driven by setFilter exactly like the selection layer.
      map.addLayer({
        id: HOVER_FILL_ID,
        type: 'fill',
        source: SRC_ID,
        filter: cellFilter(hoveredCell),
        paint: { 'fill-color': 'rgba(235, 242, 255, 0.09)' },
      });
      map.addLayer({
        id: HOVER_LINE_ID,
        type: 'line',
        source: SRC_ID,
        filter: cellFilter(hoveredCell),
        paint: { 'line-color': 'rgba(235, 242, 255, 0.55)', 'line-width': 1.5 },
      });
      map.addLayer({
        id: SELECT_ID,
        type: 'line',
        source: SRC_ID,
        filter: cellFilter(selectedRef.current),
        paint: { 'line-color': '#f5b31d', 'line-width': 2.2 },
      });
      // The headline layer: each region's top mood as a real emoji, sized
      // by report volume. Collision-aware (busiest regions win at low zoom,
      // more emojis reveal as you zoom in). Images must be re-registered
      // after every style swap — addImage state lives on the style.
      for (const def of MOOD_LIST) {
        const imgId = `mood-${def.id}`;
        if (map.hasImage(imgId)) continue;
        const img = makeEmojiImage(def.emoji);
        if (img) map.addImage(imgId, img, { pixelRatio: EMOJI_IMG_RATIO });
      }
      map.addLayer({
        id: EMOJI_ID,
        type: 'symbol',
        source: GLOW_SRC_ID,
        layout: {
          'icon-image': ['concat', 'mood-', ['get', 'topMood']] as unknown as ExpressionSpecification,
          'icon-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            0.8,
            ['interpolate', ['linear'], ['get', 'count'], K_ANONYMITY, 0.2, 60, 0.3, 300, 0.42],
            4,
            ['interpolate', ['linear'], ['get', 'count'], K_ANONYMITY, 0.34, 60, 0.48, 300, 0.62],
            7,
            0.72,
          ] as unknown as ExpressionSpecification,
          'icon-allow-overlap': false,
          'icon-padding': 2,
          // Lower sort key renders first and wins collisions → busiest cells.
          'symbol-sort-key': ['*', -1, ['get', 'count']] as unknown as ExpressionSpecification,
        },
      });
      bindLayerEvents();
    };

    map.on('style.load', () => {
      styleEverLoaded = true;
      ensureLayers();
    });
    map.on('error', () => {
      // Walk the fallback chain only if no style ever loaded. Tile/glyph
      // errors after a successful style load are ignored.
      if (styleEverLoaded || removed) return;
      if (fallbackStage === 0) {
        fallbackStage = 1;
        map.setStyle(SECONDARY_STYLE_URL);
      } else if (fallbackStage === 1) {
        fallbackStage = 2;
        map.setStyle(FALLBACK_STYLE);
      }
    });

    // Cinematic intro: drift in from far out once the first style is up —
    // but never stomp a camera the user has already moved themselves
    // (user-initiated move/zoom events carry an originalEvent).
    let userMoved = false;
    const markUserMove = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) userMoved = true;
    };
    map.on('movestart', markUserMove);
    map.on('zoomstart', markUserMove);
    if (!reduced) {
      map.once('load', () => {
        if (removed || userMoved) return;
        if (document.hidden) {
          map.setZoom(INTRO_ZOOM_TO);
        } else {
          map.easeTo({ zoom: INTRO_ZOOM_TO, duration: 2500, essential: false });
        }
      });
    }

    // Gentle global breathing of the glow layer: one scalar paint update
    // per tick on a ~5s sine. Skipped entirely under reduced motion and
    // paused while the tab is hidden.
    let breathTimer: number | null = null;
    if (!reduced) {
      const t0 = performance.now();
      breathTimer = window.setInterval(() => {
        if (removed || document.hidden) return;
        try {
          if (!map.getLayer(GLOW_ID)) return;
          const phase = ((performance.now() - t0) / GLOW_BREATH_PERIOD_MS) * Math.PI * 2;
          map.setPaintProperty(GLOW_ID, 'circle-opacity', GLOW_OPACITY_MID + GLOW_OPACITY_AMP * Math.sin(phase));
        } catch {
          // style mid-swap — try again next tick
        }
      }, 100);
    }

    map.on('click', (e) => {
      if (!pickingRef.current) return;
      const ll = e.lngLat.wrap();
      propsRef.current.onPick(ll.lat, ll.lng);
    });

    const reportRes = () => propsRef.current.onResChange(resForZoom(map.getZoom()));
    const reportCenter = () => {
      const c = map.getCenter().wrap();
      propsRef.current.onCenterChange({ lat: c.lat, lng: c.lng });
    };
    map.on('zoomend', reportRes);
    map.on('moveend', reportCenter);
    reportRes();
    reportCenter();

    return () => {
      removed = true;
      if (breathTimer !== null) window.clearInterval(breathTimer);
      for (const r of ripplesRef.current) {
        window.clearTimeout(r.timer);
        r.marker.remove();
      }
      ripplesRef.current = [];
      popup.remove();
      // Drop the capture handle so share.ts never reads a removed map.
      const w = window as unknown as { __moodMap?: maplibregl.Map };
      if (w.__moodMap === map) delete w.__moodMap;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Push fresh aggregate cells into both sources.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource(SRC_ID) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(data);
    const glow = map.getSource(GLOW_SRC_ID) as maplibregl.GeoJSONSource | undefined;
    if (glow) glow.setData(glowData);
  }, [data, glowData]);

  // Highlight the selected cell.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.getLayer(SELECT_ID)) map.setFilter(SELECT_ID, cellFilter(props.selectedCellId));
  }, [props.selectedCellId]);

  // Crosshair cursor while picking a report location.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = props.picking ? 'crosshair' : '';
  }, [props.picking]);

  // Brief pulse animation where the user's own report landed.
  useEffect(() => {
    const map = mapRef.current;
    const pulse = props.reportPulse;
    if (!map || !pulse) return;
    const info = safeParseCell(pulse.cellId);
    if (!info) return;
    const el = document.createElement('div');
    el.className = 'map-pulse';
    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([info.centerLng, info.centerLat])
      .addTo(map);
    const t = window.setTimeout(() => marker.remove(), 1800);
    return () => {
      window.clearTimeout(t);
      marker.remove();
    };
  }, [props.reportPulse]);

  // Live SSE ripples: mood-colored expanding rings at res-0 cell centers.
  // Capped, motion-gated, and skipped while the tab is hidden.
  useEffect(() => {
    const map = mapRef.current;
    const pulse = props.livePulse;
    if (!map || !pulse) return;
    if (prefersReducedMotion() || document.hidden) return;
    const info = safeParseCell(pulse.cellId);
    if (!info) return;
    const ripples = ripplesRef.current;
    if (ripples.length >= MAX_LIVE_RIPPLES) {
      const oldest = ripples.shift();
      if (oldest) {
        window.clearTimeout(oldest.timer);
        oldest.marker.remove();
      }
    }
    const mood = MOODS[pulse.mood];
    const el = document.createElement('div');
    el.className = 'map-ripple';
    el.style.setProperty('--ripple-color', mood ? mood.color : '#f5b31d');
    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([info.centerLng, info.centerLat])
      .addTo(map);
    const entry: RippleEntry = { marker, timer: 0 };
    entry.timer = window.setTimeout(() => {
      marker.remove();
      const i = ripples.indexOf(entry);
      if (i !== -1) ripples.splice(i, 1);
    }, RIPPLE_MS);
    ripples.push(entry);
  }, [props.livePulse]);

  return <div ref={containerRef} className="map-root" />;
}
