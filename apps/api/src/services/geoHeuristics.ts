export type GeoPoint = {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
};

export const hasValidCoordinates = (point: GeoPoint) =>
  typeof point.latitude === "number" &&
  typeof point.longitude === "number" &&
  Number.isFinite(point.latitude) &&
  Number.isFinite(point.longitude) &&
  Math.abs(point.latitude) <= 90 &&
  Math.abs(point.longitude) <= 180;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

export const calculateHaversineLineDistanceKm = (
  from: GeoPoint,
  to: GeoPoint,
): number | null => {
  if (!hasValidCoordinates(from) || !hasValidCoordinates(to)) return null;
  const earthRadiusKm = 6371;
  const dLat = toRadians(to.latitude! - from.latitude!);
  const dLng = toRadians(to.longitude! - from.longitude!);
  const lat1 = toRadians(from.latitude!);
  const lat2 = toRadians(to.latitude!);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return (
    Math.round(
      earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10,
    ) / 10
  );
};
