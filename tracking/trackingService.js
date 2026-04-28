/**
 * trackingService - 차량 위치 추적 서비스
 *
 * 주기적으로 API에서 GPS 데이터를 가져와서 칼만 필터를 적용하고,
 * 필터링된 위치를 외부에 제공.
 *
 * 사용법:
 *   startTracking()   -> 15초마다 폴링 시작
 *   stopTracking()    -> 폴링 중지
 *   getFilteredPositions(transitSystem?, routeId?) -> 현재 추정 위치들
 *   getFilteredPosition(vehicleId) -> 특정 차량의 추정 위치
 */
import VehicleTracker from './VehicleTracker.js';
import { fetchAllPositions } from './positionFetchers.js';

const trackers = new Map();  // vehicleId -> VehicleTracker
let intervalId = null;

const DEFAULT_INTERVAL_MS = 15_000;  // 15초
const CLEANUP_THRESHOLD_SEC = 300;   // 5분 이상 업데이트 없으면 삭제

/**
 * API에서 데이터를 가져와서 모든 트래커를 업데이트
 */
async function fetchAndUpdate() {
  try {
    const positions = await fetchAllPositions();

    for (const pos of positions) {
      const existing = trackers.get(pos.vehicleId);

      if (existing) {
        existing.update(pos.lat, pos.lng, pos.timestamp, pos.bearing);
      } else {
        trackers.set(pos.vehicleId, new VehicleTracker(pos.vehicleId, pos.transitSystem, pos));
      }
    }

    // 오래된 트래커 정리
    const now = Math.floor(Date.now() / 1000);
    for (const [id, tracker] of trackers) {
      if (now - tracker.lastUpdateTime > CLEANUP_THRESHOLD_SEC) {
        trackers.delete(id);
      }
    }

    console.log(`[Tracking] Updated ${positions.length} vehicles, ${trackers.size} active trackers`);
  } catch (err) {
    console.error('[Tracking] fetchAndUpdate error:', err.message);
  }
}

/**
 * 추적 시작
 * @param {number} intervalMs - 폴링 간격 (밀리초, 기본 15초)
 */
export function startTracking(intervalMs = DEFAULT_INTERVAL_MS) {
  if (intervalId) return; // 이미 실행 중

  console.log(`[Tracking] Starting vehicle tracking (interval: ${intervalMs}ms)`);
  fetchAndUpdate(); // 즉시 한번 실행
  intervalId = setInterval(fetchAndUpdate, intervalMs);
}

/**
 * 추적 중지
 */
export function stopTracking() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Tracking] Stopped vehicle tracking');
  }
}

/**
 * 현재 추적 중인 모든 차량의 필터링된 위치 반환
 *
 * @param {string|null} transitSystem - "MTA_SUBWAY" 등으로 필터링 (null이면 전체)
 * @param {string|null} routeId       - "A", "119" 등으로 필터링 (null이면 전체)
 * @returns {Array<object>}
 */
export function getFilteredPositions(transitSystem = null, routeId = null) {
  const now = Math.floor(Date.now() / 1000);
  const results = [];

  for (const tracker of trackers.values()) {
    if (transitSystem && tracker.transitSystem !== transitSystem) continue;
    if (routeId && tracker.routeId !== routeId) continue;
    results.push(tracker.getEstimate(now));
  }

  return results;
}

/**
 * 특정 차량의 필터링된 위치 반환
 *
 * @param {string} vehicleId
 * @returns {object|null}
 */
export function getFilteredPosition(vehicleId) {
  const tracker = trackers.get(vehicleId);
  if (!tracker) return null;
  return tracker.getEstimate(Math.floor(Date.now() / 1000));
}
