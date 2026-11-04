import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { LocateFixed, Minus, Plus } from "lucide-react";
import {
  isFeatureSelected,
  territoryCityPathStyle,
  territoryCityTooltip,
  type GeoBounds,
  type TerritoryCity,
  type TerritoryMunicipalityFeature
} from "../../lib/territoryMap";

// Fundo OpenStreetMap (uso leve, com atribuição visível conforme a política de tiles do OSM).
export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

const MAP_MIN_ZOOM = 5;
const MAP_MAX_ZOOM = 15;
// Ctrl/Cmd + roda: meio nível de zoom a cada 50px de rolagem acumulada (roda de mouse ~100px por clique; trackpad aos poucos).
const WHEEL_ZOOM_STEP = 0.5;
const WHEEL_PIXELS_PER_STEP = 50;
const WHEEL_HINT_MS = 1500;

type Props = {
  features: TerritoryMunicipalityFeature[];
  resolveCity: (feature: TerritoryMunicipalityFeature) => TerritoryCity;
  selectedCity: TerritoryCity | null;
  onSelectCity: (city: TerritoryCity) => void;
  canInspect: boolean;
  focusBounds: GeoBounds;
  // Muda quando o enquadramento inicial deve ser refeito (vendedor, mês, território).
  viewKey: string;
  // Muda quando a cidade foi escolhida fora do mapa (lista do celular): o mapa leva a cidade para a área visível.
  revealSelectedKey: number;
  ariaLabel: string;
};

const toLatLngBounds = (bounds: GeoBounds) => L.latLngBounds([bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]);
const isMacPlatform = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

export default function TerritoryLeafletMap({ features, resolveCity, selectedCity, onSelectCity, canInspect, focusBounds, viewKey, revealSelectedKey, ariaLabel }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.GeoJSON | null>(null);
  const selectedRef = useRef(selectedCity);
  const onSelectRef = useRef(onSelectCity);
  const focusRef = useRef(focusBounds);
  const [showWheelHint, setShowWheelHint] = useState(false);
  selectedRef.current = selectedCity;
  onSelectRef.current = onSelectCity;
  focusRef.current = focusBounds;

  // Mapa: criado uma vez. Celular: pinça, arrastar com um dedo e duplo toque. Computador: arrastar, duplo clique, botões
  // e Ctrl/Cmd + roda (a roda sozinha continua rolando a página).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = L.map(container, {
      zoomControl: false,
      scrollWheelZoom: false,
      touchZoom: true,
      doubleClickZoom: true,
      dragging: true,
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      zoomSnap: 0.25
    });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>');
    // Afasta a atribuição do canto arredondado do cartão para "© OpenStreetMap contributors" ficar inteira à vista.
    const attribution = map.attributionControl.getContainer();
    if (attribution) attribution.style.marginRight = "14px";
    L.tileLayer(OSM_TILE_URL, {
      attribution: OSM_ATTRIBUTION,
      maxZoom: 19,
      referrerPolicy: "strict-origin-when-cross-origin"
    }).addTo(map);
    map.fitBounds(toLatLngBounds(focusRef.current));
    mapRef.current = map;

    let wheelDelta = 0;
    let hintTimer: number | undefined;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        // Sem Ctrl/Cmd: não mexe no mapa, deixa a página rolar e avisa como aproximar.
        setShowWheelHint(true);
        window.clearTimeout(hintTimer);
        hintTimer = window.setTimeout(() => setShowWheelHint(false), WHEEL_HINT_MS);
        return;
      }
      // Com Ctrl/Cmd (e na pinça do trackpad, que chega como Ctrl + roda): zoom no ponto do cursor, sem zoom da página.
      event.preventDefault();
      setShowWheelHint(false);
      wheelDelta += event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
      if (Math.abs(wheelDelta) < WHEEL_PIXELS_PER_STEP) return;
      const direction = wheelDelta < 0 ? 1 : -1;
      wheelDelta = 0;
      const nextZoom = Math.min(Math.max(map.getZoom() + direction * WHEEL_ZOOM_STEP, MAP_MIN_ZOOM), MAP_MAX_ZOOM);
      map.setZoomAround(map.mouseEventToContainerPoint(event as unknown as MouseEvent), nextZoom);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });

    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(container);

    return () => {
      container.removeEventListener("wheel", handleWheel);
      window.clearTimeout(hintTimer);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // Polígonos dos municípios: refeitos quando muda a cobertura (cores) ou a permissão de inspecionar.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Dica só em aparelho com mouse; no toque não aparece dica (o resumo sobre o mapa faz esse papel).
    const hoverTooltips = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

    const layer = L.geoJSON(
      { type: "FeatureCollection", features } as unknown as GeoJSON.FeatureCollection,
      {
        interactive: canInspect,
        style: (geoFeature) => {
          const feature = geoFeature as unknown as TerritoryMunicipalityFeature;
          return territoryCityPathStyle(resolveCity(feature).status, isFeatureSelected(feature, selectedRef.current));
        },
        onEachFeature: (geoFeature, featureLayer) => {
          const feature = geoFeature as unknown as TerritoryMunicipalityFeature;
          const city = resolveCity(feature);
          const tooltip = territoryCityTooltip(city);
          if (hoverTooltips && tooltip) {
            featureLayer.bindTooltip(tooltip, { sticky: true, direction: "top", offset: [0, -8], className: "territory-map-tooltip" });
          }
          if (!canInspect) return;
          featureLayer.on("click", () => onSelectRef.current(city));
          featureLayer.on("add", () => {
            const element = (featureLayer as L.Path).getElement();
            if (!element) return;
            element.setAttribute("tabindex", "0");
            element.setAttribute("role", "button");
            element.setAttribute("aria-label", `${city.city}, ${city.state}: ${city.statusLabel}`);
            element.addEventListener("keydown", (event) => {
              const key = (event as KeyboardEvent).key;
              if (key === "Enter" || key === " ") {
                event.preventDefault();
                onSelectRef.current(city);
              }
            });
          });
        }
      }
    ).addTo(map);
    layerRef.current = layer;

    return () => {
      layer.remove();
      if (layerRef.current === layer) layerRef.current = null;
    };
  }, [features, resolveCity, canInspect]);

  // Destaque da cidade selecionada sem refazer os polígonos.
  useEffect(() => {
    layerRef.current?.setStyle((geoFeature) => {
      const feature = geoFeature as unknown as TerritoryMunicipalityFeature;
      return territoryCityPathStyle(resolveCity(feature).status, isFeatureSelected(feature, selectedCity));
    });
  }, [selectedCity, resolveCity]);

  // Cidade escolhida pela lista: se não estiver toda à vista, o mapa centraliza nela (sem mudar o zoom).
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!revealSelectedKey || !map || !layer || !selectedRef.current) return;
    const target = layer.getLayers().find((item) => isFeatureSelected((item as L.GeoJSON).feature as unknown as TerritoryMunicipalityFeature, selectedRef.current)) as L.Polygon | undefined;
    if (!target) return;
    const bounds = target.getBounds();
    if (!map.getBounds().contains(bounds)) map.panTo(bounds.getCenter());
  }, [revealSelectedKey]);

  // Enquadramento: território do vendedor (ou PR, SC e MS sem território) ao trocar vendedor/mês.
  useEffect(() => {
    mapRef.current?.fitBounds(toLatLngBounds(focusRef.current));
  }, [viewKey]);

  return (
    <div className="relative">
      {/* z-0 cria um contexto próprio: os z-index internos do Leaflet (400+) não passam por cima do menu e dos modais.
          territory-map: foco de teclado desenhado na borda da cidade (index.css), sem o retângulo do navegador. */}
      <div
        ref={containerRef}
        role="region"
        aria-label={ariaLabel}
        className="territory-map relative z-0 h-[420px] w-full bg-slate-100 sm:h-[560px] lg:h-[700px]"
      />
      {showWheelHint ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-slate-950/30" aria-hidden="true">
          <p className="rounded-[0.75rem] bg-slate-950/85 px-4 py-2 text-sm font-semibold text-white shadow-lg">
            {isMacPlatform() ? "Use Cmd + rolagem para aproximar o mapa" : "Use Ctrl + rolagem para aproximar o mapa"}
          </p>
        </div>
      ) : null}
      {/* rounded-[1rem] (e não rounded-2xl): no celular o shell estica todo .rounded-2xl para 100% da largura. */}
      <div className="absolute left-4 top-4 z-10 inline-flex w-max overflow-hidden rounded-[1rem] border border-slate-200 bg-white/95 shadow-lg backdrop-blur">
        <button
          type="button"
          className="inline-flex h-11 w-11 items-center justify-center border-r border-slate-200 text-slate-700 transition hover:bg-slate-50"
          onClick={() => mapRef.current?.zoomIn()}
          aria-label="Aproximar mapa"
        >
          <Plus size={18} />
        </button>
        <button
          type="button"
          className="inline-flex h-11 w-11 items-center justify-center border-r border-slate-200 text-slate-700 transition hover:bg-slate-50"
          onClick={() => mapRef.current?.zoomOut()}
          aria-label="Afastar mapa"
        >
          <Minus size={18} />
        </button>
        <button
          type="button"
          className="inline-flex h-11 w-11 items-center justify-center text-slate-700 transition hover:bg-slate-50"
          onClick={() => mapRef.current?.fitBounds(toLatLngBounds(focusRef.current))}
          aria-label="Recentralizar mapa"
        >
          <LocateFixed size={18} />
        </button>
      </div>
    </div>
  );
}
