/**
 * ETL Job: 실시간 GTFS-RT TripUpdate 피드에서 지연 데이터 수집
 *
 * GTFS-RT 피드에서 실제 도착/출발 시간을 가져와서
 * 정적 스케줄(timetables)과 비교한 뒤 지연 데이터를 저장.
 *
 * 사용법:
 *   node tasks/collect_delays.js        (1회 실행)
 *   또는 app.js에서 setInterval로 반복 실행
 */
import '../config.js';
import { dbConnection, closeConnection } from '../config/mongoConnection.js';
import { delaysCollection, timetablesCollection } from '../config/mongoCollections.js';
import * as mtaSubwayApi from '../api/mta/subway/APICalls.js';
import * as njtBusApi from '../api/njtransit/bus/APICalls.js';
import * as njtRailApi from '../api/njtransit/rail/APICalls.js';
import { safeToEpochSeconds } from '../helpers/MTASubwayHelpers.js';

// 시스템별 stop ID 접두사 (seed_timetables.js와 동일)
const STOP_PREFIXES = {
  MTA_SUBWAY: 'MTA_SUBWAY_',
  NJT_BUS: 'NJTB_',
  NJT_RAIL: 'NJTR_'
};

const SUBWAY_GROUPS = ['gtfs', 'ace', 'bdfm', 'g', 'jz', 'nqrw', 'l', '7', 'si'];

// ============================================================
// 헬퍼: epoch 초 -> 자정 기준 분 변환
// ============================================================

function epochToMinutesFromMidnight(epochSec) {
  const d = new Date(epochSec * 1000);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

// ============================================================
// 헬퍼: 타임테이블에서 스케줄 시간 조회
// ============================================================

// 캐시: "MTA_SUBWAY|A|0" -> { stopSequence, trips }
const timetableCache = new Map();

async function lookupScheduledTimes(transitSystem, routeId, tripId, stopIds) {
  const ttCol = await timetablesCollection();

  // 해당 route의 모든 direction 타임테이블을 캐시에서 찾기
  const cacheKey = `${transitSystem}|${routeId}`;
  let timetables = timetableCache.get(cacheKey);

  if (!timetables) {
    timetables = await ttCol.find(
      { transitSystem, routeId },
      { projection: { stopSequence: 1, trips: 1, directionId: 1 } }
    ).toArray();
    timetableCache.set(cacheKey, timetables);
  }

  if (timetables.length === 0) return null;

  // tripId로 정확히 매칭되는 trip 찾기
  for (const tt of timetables) {
    const trip = tt.trips.find(t => t.tripId === tripId);
    if (trip) {
      // stopSequence[i] <-> trip.stopTimes[i] 매핑
      const result = new Map();
      for (let i = 0; i < tt.stopSequence.length; i++) {
        if (trip.stopTimes[i] !== null && trip.stopTimes[i] !== undefined) {
          result.set(tt.stopSequence[i], trip.stopTimes[i]);
        }
      }
      return result;
    }
  }

  // 정확한 tripId가 없으면 null (스케줄 매칭 불가)
  return null;
}

// ============================================================
// 시스템별 수집 함수
// ============================================================

/**
 * GTFS-RT tripUpdate 배열에서 지연 데이터 추출 (공통 로직)
 */
async function processTripUpdates(tripUpdates, transitSystem, prefix) {
  const records = [];
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const dayOfWeek = (now.getDay() + 6) % 7; // 0=월 ... 6=일

  for (const tu of tripUpdates) {
    const trip = tu.trip;
    if (!trip?.routeId) continue;

    const stus = tu.stopTimeUpdate;
    if (!Array.isArray(stus) || stus.length < 2) continue;

    const routeId = trip.routeId;
    const tripId = trip.tripId || null;

    // 각 stop의 실제 시간 추출
    const stopData = [];
    for (const stu of stus) {
      if (!stu.stopId) continue;

      const arrEpoch = safeToEpochSeconds(stu.arrival?.time);
      const depEpoch = safeToEpochSeconds(stu.departure?.time);
      const epoch = arrEpoch || depEpoch;
      if (!epoch) continue;

      stopData.push({
        stopId: prefix + stu.stopId,
        actualEpoch: epoch,
        actualMin: epochToMinutesFromMidnight(epoch)
      });
    }

    if (stopData.length < 2) continue;

    // 스케줄 매칭 시도
    const scheduleMap = await lookupScheduledTimes(
      transitSystem, routeId, tripId,
      stopData.map(s => s.stopId)
    );

    // stops 배열 생성 (스케줄 vs 실제)
    const stops = stopData.map(sd => {
      const scheduledMin = scheduleMap?.get(sd.stopId) ?? null;
      return {
        stopId: sd.stopId,
        scheduledMin,
        actualMin: Math.round(sd.actualMin * 10) / 10,
        delayMin: scheduledMin !== null
          ? Math.round((sd.actualMin - scheduledMin) * 10) / 10
          : null
      };
    });

    // segments 배열 생성 (연속 정류장 간 실제 이동 시간)
    const segments = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i];
      const to = stops[i + 1];
      const actualTravelMin = Math.round((to.actualMin - from.actualMin) * 10) / 10;

      // 음수 이동시간은 데이터 오류 -> 건너뜀
      if (actualTravelMin <= 0) continue;

      const scheduledTravelMin = (from.scheduledMin !== null && to.scheduledMin !== null)
        ? to.scheduledMin - from.scheduledMin
        : null;

      segments.push({
        fromStopId: from.stopId,
        toStopId: to.stopId,
        scheduledTravelMin,
        actualTravelMin
      });
    }

    if (segments.length === 0) continue;

    records.push({
      transitSystem,
      routeId,
      tripId,
      date: dateStr,
      dayOfWeek,
      hour: Math.floor(stops[0].actualMin / 60),
      collectedAt: now,
      stops,
      segments
    });
  }

  return records;
}

async function collectMtaSubway() {
  const allRecords = [];
  for (const group of SUBWAY_GROUPS) {
    try {
      const feed = await mtaSubwayApi.getMtaSubwayRealtime(group);
      const records = await processTripUpdates(
        feed.tripUpdates || [], 'MTA_SUBWAY', STOP_PREFIXES.MTA_SUBWAY
      );
      allRecords.push(...records);
    } catch (err) {
      console.error(`[ETL] MTA Subway group=${group} failed:`, err.message);
    }
  }
  return allRecords;
}

async function collectNjtBus() {
  try {
    const feed = await njtBusApi.getTripUpdates();
    const tripUpdates = [];
    for (const entity of (feed?.entity || [])) {
      if (entity.tripUpdate) tripUpdates.push(entity.tripUpdate);
    }
    return await processTripUpdates(tripUpdates, 'NJT_BUS', STOP_PREFIXES.NJT_BUS);
  } catch (err) {
    console.error('[ETL] NJT Bus failed:', err.message);
    return [];
  }
}

async function collectNjtRail() {
  try {
    const feed = await njtRailApi.getTripUpdates();
    const tripUpdates = [];
    for (const entity of (feed?.entity || [])) {
      if (entity.tripUpdate) tripUpdates.push(entity.tripUpdate);
    }
    return await processTripUpdates(tripUpdates, 'NJT_RAIL', STOP_PREFIXES.NJT_RAIL);
  } catch (err) {
    console.error('[ETL] NJT Rail failed:', err.message);
    return [];
  }
}

// ============================================================
// 메인: 수집 + 저장
// ============================================================

export async function collectAll() {
  const [subway, bus, rail] = await Promise.all([
    collectMtaSubway(),
    collectNjtBus(),
    collectNjtRail()
  ]);

  const allRecords = [...subway, ...bus, ...rail];

  if (allRecords.length === 0) {
    console.log('[ETL] No delay records collected');
    return 0;
  }

  const delaysCol = await delaysCollection();
  await delaysCol.insertMany(allRecords);
  console.log(`[ETL] Inserted ${allRecords.length} delay records (subway:${subway.length} bus:${bus.length} rail:${rail.length})`);
  return allRecords.length;
}

/**
 * 반복 수집 시작 (app.js에서 호출)
 */
let collectionInterval = null;
export function startDelayCollection(intervalMs = 5 * 60 * 1000) {
  if (collectionInterval) return;
  console.log(`[ETL] Starting delay collection (interval: ${intervalMs / 1000}s)`);
  collectAll(); // 즉시 1회
  collectionInterval = setInterval(collectAll, intervalMs);
}

export function stopDelayCollection() {
  if (collectionInterval) {
    clearInterval(collectionInterval);
    collectionInterval = null;
  }
}

// 인덱스 생성
async function ensureIndexes() {
  const delaysCol = await delaysCollection();
  await delaysCol.createIndex({ transitSystem: 1, routeId: 1, date: 1 });
  await delaysCol.createIndex({ 'segments.fromStopId': 1, 'segments.toStopId': 1 });
  await delaysCol.createIndex({ collectedAt: 1 }, { expireAfterSeconds: 90 * 86400 }); // 90일 TTL
  console.log('[ETL] Indexes created');
}

// 직접 실행: node tasks/collect_delays.js
const isDirectRun = process.argv[1]?.includes('collect_delays');
if (isDirectRun) {
  await dbConnection();
  await ensureIndexes();
  await collectAll();
  await closeConnection();
  process.exit(0);
}
