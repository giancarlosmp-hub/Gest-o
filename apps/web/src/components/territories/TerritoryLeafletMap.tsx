import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { LocateFixed, Minus, Plus } from "lucide-react";
import {
  isFeatureSelected,
  territoryCityPathStyle,
  type GeoBounds,
  type TerritoryCity,
  type TerritoryMunicipalityFeature
} from "../../lib/territoryMap";

// Fundo OpenStreetMap (uso leve, com atribuição visível conforme a política de tiles do OSM).
export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

const MAP_MIN_ZOOM = 5;
const MAP_MAX_ZOOM = 15;

type Props = {
  features: TerritoryMunicipalityFeature[];
  resolveCity: (feature: TerritoryMunicipalityFeature) => TerritoryCity;
  selectedCity: TerritoryCity | null;
  onSelectCity: (city: TerritoryCity) => void;
  canInspect: boolean;
  focusBounds: GeoBounds;
  // Muda quando o enquadramento inicial deve ser refeito (vendedor, mês, território).
  viewKey: string;
  tooltipText: (city: TerritoryCity) => string;
  ariaLabel: string;
};

const toLatLngBounds = (bounds: GeoBounds) => L.latLngBounds([bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]);

export default function TerritoryLeafletMap({ features, resolveCity, selectedCity, onSelectCity, canInspect, focusBounds, viewKey, tooltipText, ariaLabel }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.GeoJSON | null>(null);
  const selectedRef = useRef(selectedCity);
  const onSelectRef = useRef(onSelectCity);
  const focusRef = useRef(focusBounds);
  selectedRef.current = selectedCity;
  onSelectRef.current = onSelectCity;
  focusRef.current = focusBounds;

  // Mapa: criado uma vez. Pinça e arrastar com um dedo no celular; botões próprios de zoom; sem zoom pela roda do mouse
  // (a página continua rolando por cima do mapa no desktop, como antes).
  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, {
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

    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(containerRef.current);

    return () => {
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
          if (hoverTooltips) {
            const content = document.createElement("div");
            content.style.whiteSpace = "pre-line";
            content.textContent = tooltipText(city);
            featureLayer.bindTooltip(content, { sticky: true, direction: "top" });
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
  }, [features, resolveCity, canInspect, tooltipText]);

  // Destaque da cidade selecionada sem refazer os polígonos.
  useEffect(() => {
    layerRef.current?.setStyle((geoFeature) => {
      const feature = geoFeature as unknown as TerritoryMunicipalityFeature;
      return territoryCityPathStyle(resolveCity(feature).status, isFeatureSelected(feature, selectedCity));
    });
  }, [selectedCity, resolveCity]);

  // Enquadramento: território do vendedor (ou PR, SC e MS sem território) ao trocar vendedor/mês.
  useEffect(() => {
    mapRef.current?.fitBounds(toLatLngBounds(focusRef.current));
  }, [viewKey]);

  return (
    <div className="relative">
      {/* z-0 cria um contexto próprio: os z-index internos do Leaflet (400+) não passam por cima do menu e dos modais. */}
      <div
        ref={containerRef}
        role="region"
        aria-label={ariaLabel}
        className="relative z-0 h-[420px] w-full bg-slate-100 sm:h-[560px] lg:h-[700px]"
      />
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
