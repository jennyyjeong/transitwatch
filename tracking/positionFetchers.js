/**
 * positionFetchers - 각 대중교통 API에서 차량 GPS 위치를 가져와서 통일된 형태로 변환
 *
 * 각 API는 다른 형식으로 데이터를 주지만,
 * 여기서 하나의 공통 형식으로 바꿔서 칼만 필터에 넘김.
 */
import * as mtaSubwayApi from '../api/mta/subway/APICalls.js';
import * as njtBusApi from '../api/njtransit/bus/APICalls.js';
import { safeToEpochSeconds } from '../helpers/MTASubwayHelpers.js';
import { stopsCollection } from '../config/mongoCollections.js';

const SUBWAY_GROUPS = ['gtfs', 'ace', 'bdfm', 'g', 'jz', 'nqrw', 'l', '7', 'si'];

// 정류장 좌표 캐시 (stopId -> { lat, lng })
// MTA 지하철은 GPS가 없어서 정류장 좌표를 대신 사용
let stopCoordCache = new Map();
let stopCacheLoadedAt = 0;
const STOP_CACHE_TTL = 60 * 60 * 1000; // 1시간

async function getStopCoords(stopId) {
  // 캐시가 오래됐으면 다시 로드
  if (Date.now() - stopCacheLoadedAt > STOP_CACHE_TTL) {
    stopCoordCache = new Map();
    stopCacheLoadedAt = Date.now();
  }

  if (stopCoordCache.has(stopId)) return stopCoordCache.get(stopId);

  try {
    const stops = await stopsCollection();
    const stop = await stops.findOne(
      { stopId: `MTA_SUBWAY_${stopId}` },
      { projection: { 'location.coordinates': 1 } }
    );
    if (stop?.location?.coordinates) {
      // MongoDB GeoJSON: [lng, lat]
      const coords = { lat: stop.location.coordinates[1], lng: stop.location.coordinates[0] };
      stopCoordCache.set(stopId, coords);
      return coords;
    }
  } catch { /* ignore */ }

  stopCoordCache.set(stopId, null);
  return null;
}

/**
 * MTA 지하철 차량 위치 가져오기
 * 지하철은 GPS가 없어서 현재 정류장(stopId)의 좌표를 차량 위치로 사용
 *
 * @returns {Array<object>} 정규화된 차량 위치 배열
 */
export async function fetchMtaSubwayPositions() {
  const positions = [];

  for (const group of SUBWAY_GROUPS) {
    try {
      const feed = await mtaSubwayApi.getMtaSubwayRealtime(group);
      const vehicles = feed.vehicles || [];

      for (const v of vehicles) {
        const timestamp = safeToEpochSeconds(v.timestamp);
        if (!timestamp) continue;

        const tripId = v.trip?.tripId || null;
        const routeId = v.trip?.routeId || null;
        const vehicleId = v.vehicle?.id || tripId;
        if (!vehicleId) continue;

        // GPS 좌표가 있으면 그대로 사용
        let lat = v.position?.latitude ?? null;
        let lng = v.position?.longitude ?? null;

        // GPS가 없으면 현재 정류장 좌표를 사용
        if (lat == null && v.stopId) {
          const coords = await getStopCoords(v.stopId);
          if (!coords) continue;
          lat = coords.lat;
          lng = coords.lng;
        }

        if (lat == null || lng == null) continue;

        positions.push({
          vehicleId: `MTA_SUBWAY_${routeId || 'UNK'}:${vehicleId}`,
          tripId,
          routeId,
          lat,
          lng,
          bearing: v.position?.bearing ?? null,
          speed: v.position?.speed ?? null,
          timestamp,
          transitSystem: 'MTA_SUBWAY'
        });
      }
    } catch (err) {
      console.error(`[Tracking] MTA Subway fetch failed for group=${group}:`, err.message);
    }
  }

  return positions;
}

/**
 * NJT 버스 차량 위치 가져오기
 * 기존 getVehiclePositions()이 반환하는 GTFS-RT FeedMessage를 활용
 *
 * @returns {Array<object>} 정규화된 차량 위치 배열
 */
export async function fetchNjtBusPositions() {
  const positions = [];

  try {
    const feed = await njtBusApi.getVehiclePositions();
    const entities = feed?.entity || [];

    for (const entity of entities) {
      const v = entity.vehicle;
      if (!v || !v.position || v.position.latitude == null || v.position.longitude == null) continue;

      const timestamp = safeToEpochSeconds(v.timestamp);
      if (!timestamp) continue;

      const tripId = v.trip?.tripId || null;
      const routeId = v.trip?.routeId || null;
      const vehicleId = v.vehicle?.id || tripId;
      if (!vehicleId) continue;

      positions.push({
        vehicleId: `NJT_BUS_${routeId || 'UNK'}:${vehicleId}`,
        tripId,
        routeId,
        lat: v.position.latitude,
        lng: v.position.longitude,
        bearing: v.position.bearing ?? null,
        speed: v.position.speed ?? null,
        timestamp,
        transitSystem: 'NJT_BUS'
      });
    }
  } catch (err) {
    console.error('[Tracking] NJT Bus fetch failed:', err.message);
  }

  return positions;
}

/**
 * 모든 지원되는 시스템에서 차량 위치를 한꺼번에 가져오기
 * @returns {Array<object>}
 */
export async function fetchAllPositions() {
  const [subway, bus] = await Promise.all([
    fetchMtaSubwayPositions(),
    fetchNjtBusPositions()
  ]);
  return [...subway, ...bus];
}
