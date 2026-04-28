/**
 * VehicleTracker - 차량 하나의 위치를 추적
 *
 * 위도(lat)와 경도(lng)에 각각 독립적인 KalmanFilter를 적용.
 * GPS 데이터가 들어올 때마다 update()를 호출하고,
 * 현재 위치가 필요할 때 getEstimate()를 호출하면 됨.
 */
import KalmanFilter from './KalmanFilter.js';

const STALE_THRESHOLD_SEC = 120; // 2분 이상 업데이트 없으면 stale 표시

export default class VehicleTracker {
  /**
   * @param {string} vehicleId     - 차량 고유 ID
   * @param {string} transitSystem - "MTA_SUBWAY" | "NJT_BUS" 등
   * @param {object} initialPosition - { lat, lng, timestamp, routeId, tripId, bearing }
   */
  constructor(vehicleId, transitSystem, initialPosition) {
    this.vehicleId = vehicleId;
    this.transitSystem = transitSystem;
    this.routeId = initialPosition.routeId || null;
    this.tripId = initialPosition.tripId || null;
    this.bearing = initialPosition.bearing || null;

    // 위도/경도 각각 별도의 칼만 필터
    this.latFilter = new KalmanFilter();
    this.lngFilter = new KalmanFilter();

    // 첫 측정값으로 초기화
    this.latFilter.update(initialPosition.lat);
    this.lngFilter.update(initialPosition.lng);

    this.lastUpdateTime = initialPosition.timestamp; // epoch 초
  }

  /**
   * 새 GPS 데이터로 위치 업데이트
   *
   * @param {number} lat       - 위도
   * @param {number} lng       - 경도
   * @param {number} timestamp - epoch 초
   * @param {number|null} bearing - 방향 (도)
   */
  update(lat, lng, timestamp, bearing = null) {
    // 경과 시간 계산
    const dt = timestamp - this.lastUpdateTime;
    if (dt <= 0) return; // 같은 시간이거나 과거 데이터는 무시

    // Step 1: 예측 - 시간이 지났으므로 불확실성 증가
    this.latFilter.predict(dt);
    this.lngFilter.predict(dt);

    // Step 2: 업데이트 - 새 측정값으로 보정
    this.latFilter.update(lat);
    this.lngFilter.update(lng);

    this.lastUpdateTime = timestamp;
    if (bearing !== null) this.bearing = bearing;
  }

  /**
   * 현재 시점의 추정 위치 반환
   * 마지막 업데이트 이후 시간이 지났다면 predict만 적용해서 불확실성 반영.
   *
   * @param {number} [nowEpochSec] - 현재 시간 (epoch 초), 생략시 Date.now()/1000
   * @returns {object} { vehicleId, lat, lng, bearing, routeId, tripId, transitSystem, uncertainty, stale, lastUpdateTime }
   */
  getEstimate(nowEpochSec = Math.floor(Date.now() / 1000)) {
    const dt = nowEpochSec - this.lastUpdateTime;

    // 시간이 지났으면 predict로 불확실성만 반영 (estimate 값은 안 바뀜)
    // 원본 필터를 변경하지 않기 위해 현재 uncertainty를 임시 계산
    const latUncertainty = this.latFilter.getUncertainty() + this.latFilter.processNoise * Math.max(0, dt);
    const lngUncertainty = this.lngFilter.getUncertainty() + this.lngFilter.processNoise * Math.max(0, dt);

    return {
      vehicleId: this.vehicleId,
      transitSystem: this.transitSystem,
      routeId: this.routeId,
      tripId: this.tripId,
      lat: this.latFilter.getEstimate(),
      lng: this.lngFilter.getEstimate(),
      bearing: this.bearing,
      uncertainty: Math.max(latUncertainty, lngUncertainty),
      stale: dt > STALE_THRESHOLD_SEC,
      lastUpdateTime: this.lastUpdateTime
    };
  }
}
