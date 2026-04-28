/**
 * timingAdjuster - loads past timing stats for RAPTOR.
 *
 * It loads all stats for the current time bucket and day type into a Map
 * once, so RAPTOR can look them up quickly.
 */
import { timingStatsCollection } from '../config/mongoCollections.js';

// Group hours into 5 buckets so we have enough samples per bucket
function getTimeBucket(hour) {
  if (hour < 6)  return 'EARLY';
  if (hour < 10) return 'AM_PEAK';
  if (hour < 16) return 'MIDDAY';
  if (hour < 20) return 'PM_PEAK';
  return 'EVENING';
}

function getDayType(date) {
  const day = date.getDay(); // 0=Sun, 6=Sat
  return (day === 0 || day === 6) ? 'weekend' : 'weekday';
}

// If we have fewer samples than this, fall back to the schedule
const MIN_SAMPLE_COUNT = 10;

/**
 * Load timing stats for the given time bucket and day type.
 *
 * @param {number} departureHour - departure hour (0-23)
 * @param {Date} date - travel date
 * @returns {Map<string, object>} "fromStopId|toStopId" -> stats
 */
export async function loadTimingStats(departureHour, date) {
  const statsCol = await timingStatsCollection();
  const timeBucket = getTimeBucket(departureHour);
  const dayType = getDayType(date);

  const docs = await statsCol.find({ timeBucket, dayType }).toArray();

  const cache = new Map();
  for (const doc of docs) {
    if (doc.sampleCount >= MIN_SAMPLE_COUNT) {
      cache.set(`${doc.fromStopId}|${doc.toStopId}`, doc);
    }
  }

  return cache;
}
