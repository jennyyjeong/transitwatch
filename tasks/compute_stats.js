/**
 * 통계 분석: historical_delays -> route_timing_stats
 *
 * 수집된 지연 데이터를 구간별/시간대별/요일별로 집계해서
 * 평균, 중앙값, 표준편차 등의 통계를 계산.
 *
 * 사용법: node tasks/compute_stats.js
 */
import '../config.js';
import { dbConnection, closeConnection } from '../config/mongoConnection.js';
import { delaysCollection, timingStatsCollection } from '../config/mongoCollections.js';

// ============================================================
// 통계 함수 (라이브러리 없이 순수 산술)
// ============================================================

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stddev(arr) {
  const m = mean(arr);
  const squareDiffs = arr.map(x => (x - m) ** 2);
  return Math.sqrt(mean(squareDiffs));
}

function computeStats(values) {
  if (values.length === 0) return null;
  return {
    mean: Math.round(mean(values) * 100) / 100,
    median: Math.round(median(values) * 100) / 100,
    p25: Math.round(percentile(values, 25) * 100) / 100,
    p75: Math.round(percentile(values, 75) * 100) / 100,
    stddev: Math.round(stddev(values) * 100) / 100
  };
}

// ============================================================
// 시간대 / 요일 분류
// ============================================================

function getTimeBucket(hour) {
  if (hour < 6)  return 'EARLY';     // 0-6시
  if (hour < 10) return 'AM_PEAK';   // 6-10시 (아침 러시아워)
  if (hour < 16) return 'MIDDAY';    // 10-16시
  if (hour < 20) return 'PM_PEAK';   // 16-20시 (저녁 러시아워)
  return 'EVENING';                   // 20-24시
}

function getDayType(dayOfWeek) {
  // dayOfWeek: 0=월 ... 4=금 -> weekday, 5=토 6=일 -> weekend
  return dayOfWeek <= 4 ? 'weekday' : 'weekend';
}

// ============================================================
// 메인: 집계 + 통계 계산
// ============================================================

async function computeAllStats() {
  const delaysCol = await delaysCollection();
  const statsCol = await timingStatsCollection();

  // 인덱스 생성
  await statsCol.createIndex(
    { transitSystem: 1, fromStopId: 1, toStopId: 1, timeBucket: 1, dayType: 1 },
    { unique: true }
  );
  await statsCol.createIndex({ transitSystem: 1, routeId: 1 });

  console.log('[Stats] Reading historical delay data...');

  // 모든 지연 데이터를 커서로 읽으면서 그룹별로 집계
  // groupKey -> { travelTimes: [], delays: [], routeId, transitSystem }
  const groups = new Map();

  const cursor = delaysCol.find({}, { projection: { segments: 1, stops: 1, transitSystem: 1, routeId: 1, hour: 1, dayOfWeek: 1 } });
  let docCount = 0;

  for await (const doc of cursor) {
    docCount++;
    const timeBucket = getTimeBucket(doc.hour);
    const dayType = getDayType(doc.dayOfWeek);

    for (const seg of doc.segments) {
      const key = `${doc.transitSystem}|${seg.fromStopId}|${seg.toStopId}|${timeBucket}|${dayType}`;

      if (!groups.has(key)) {
        groups.set(key, {
          transitSystem: doc.transitSystem,
          routeId: doc.routeId,
          fromStopId: seg.fromStopId,
          toStopId: seg.toStopId,
          timeBucket,
          dayType,
          travelTimes: [],
          delays: []
        });
      }

      const group = groups.get(key);
      group.travelTimes.push(seg.actualTravelMin);
      if (seg.scheduledTravelMin !== null) {
        group.delays.push(seg.actualTravelMin - seg.scheduledTravelMin);
      }
    }
  }

  console.log(`[Stats] Processed ${docCount} documents, ${groups.size} unique segments`);

  // 각 그룹에 대해 통계 계산 + upsert
  let upsertCount = 0;
  for (const group of groups.values()) {
    const travelStats = computeStats(group.travelTimes);
    if (!travelStats) continue;

    const delayStats = group.delays.length > 0 ? computeStats(group.delays) : null;

    await statsCol.updateOne(
      {
        transitSystem: group.transitSystem,
        fromStopId: group.fromStopId,
        toStopId: group.toStopId,
        timeBucket: group.timeBucket,
        dayType: group.dayType
      },
      {
        $set: {
          routeId: group.routeId,
          sampleCount: group.travelTimes.length,
          travelTime: travelStats,
          delay: delayStats,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
    upsertCount++;
  }

  console.log(`[Stats] Upserted ${upsertCount} timing statistics`);
}

// 직접 실행: node tasks/compute_stats.js
const isDirectRun = process.argv[1]?.includes('compute_stats');
if (isDirectRun) {
  await dbConnection();
  await computeAllStats();
  await closeConnection();
  process.exit(0);
}

export { computeAllStats };
