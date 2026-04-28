/**
 * RAPTOR Algorithm - finds the fastest transit route between two stops.
 *
 * Each "round" = one more vehicle ride.
 *   Round 1: direct trips from origin
 *   Round 2: routes reached after 1 transfer
 *   ...up to MAX_ROUNDS
 *
 * Between rides, we can walk to nearby stops using precomputed transfers.
 */

import {
    timetablesCollection,
    calendarsCollection,
    transfersCollection,
    stopsCollection
} from '../config/mongoCollections.js';
import { loadTimingStats } from './timingAdjuster.js';

const MAX_ROUNDS = 4;  // up to 3 transfers

// Convert "08:30" -> 510 (minutes from midnight)
function parseTimeInput(timeStr) {
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

// Convert 510 -> "08:30"
function minutesToTimeStr(minutes) {
    const h = Math.floor(minutes / 60) % 24;
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Find which services run on the given date.
async function getActiveServices(date) {
    const calCol = await calendarsCollection();
    const allCalendars = await calCol.find({}).toArray();

    // Format date as "YYYYMMDD" for comparison with GTFS dates
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;

    // GTFS uses Monday=0, but JS uses Sunday=0, so we convert
    const jsDay = date.getDay();
    const dayIndex = jsDay === 0 ? 6 : jsDay - 1;

    const activeIds = new Set();

    for (const cal of allCalendars) {
        if (cal.type === "regular") {
            const inRange = dateStr >= cal.startDate && dateStr <= cal.endDate;
            const dayActive = cal.days && cal.days[dayIndex] === 1;

            if (inRange && dayActive) {
                activeIds.add(`${cal.transitSystem}|${cal.serviceId}`);
            }

            // Holiday or special date overrides
            for (const ex of cal.exceptions || []) {
                if (ex.date === dateStr) {
                    if (ex.type === 1) activeIds.add(`${cal.transitSystem}|${cal.serviceId}`);
                    if (ex.type === 2) activeIds.delete(`${cal.transitSystem}|${cal.serviceId}`);
                }
            }
        } else if (cal.type === "dates_only") {
            // NJT systems have no calendar.txt - service runs only on listed dates
            for (const ex of cal.exceptions || []) {
                if (ex.date === dateStr && ex.type === 1) {
                    activeIds.add(`${cal.transitSystem}|${cal.serviceId}`);
                }
            }
        }
    }

    return activeIds;
}

// Find the earliest trip on this route that we can catch.
function findEarliestTrip(trips, stopIndex, minTime, transitSystem, activeServices) {
    // Trips are sorted by start time, so the first match is the earliest
    for (const trip of trips) {
        const serviceKey = `${transitSystem}|${trip.serviceId}`;
        if (!activeServices.has(serviceKey)) continue;

        const time = trip.stopTimes[stopIndex];
        if (time === null || time === undefined) continue;  // trip skips this stop

        if (time >= minTime) {
            return trip;
        }
    }
    return null;
}

/**
 * Find the best route from origin to destination.
 *
 * @param {string} originStopId - e.g., "NJTB_20883"
 * @param {string} destStopId - e.g., "MTA_SUBWAY_101S"
 * @param {string} timeStr - departure time, e.g., "08:30"
 * @param {Date} date - travel date
 * @returns {Object} route with legs, or error
 */
export async function findRoute(originStopId, destStopId, timeStr, date, useHistorical = false) {
    const departureTime = parseTimeInput(timeStr);
    const ttCol = await timetablesCollection();
    const trCol = await transfersCollection();
    const stopsCol = await stopsCollection();

    // Optional: load past delay data to make estimates more realistic
    let historicalCache = null;
    if (useHistorical) {
        const departureHour = Math.floor(departureTime / 60);
        historicalCache = await loadTimingStats(departureHour, date);
    }

    const activeServices = await getActiveServices(date);
    if (activeServices.size === 0) {
        return { success: false, error: "No transit service available on this date" };
    }

    // Build a small index: stopId -> which routes serve it.
    // We avoid loading the heavy "trips" data here - only the stop list.
    const stopRouteIndex = new Map();
    const timetableCache = new Map();

    const allTimetables = await ttCol.find({}, {
        projection: { transitSystem: 1, routeId: 1, directionId: 1, stopSequence: 1 }
    }).toArray();

    for (const tt of allTimetables) {
        const routeKey = `${tt.transitSystem}|${tt.routeId}|${tt.directionId}`;
        for (let i = 0; i < tt.stopSequence.length; i++) {
            const stopId = tt.stopSequence[i];
            if (!stopRouteIndex.has(stopId)) {
                stopRouteIndex.set(stopId, []);
            }
            stopRouteIndex.get(stopId).push({ routeKey, stopIndex: i, ttId: tt._id });
        }
    }

    // Load full timetable (with trips) only when we need to scan it
    async function getFullTimetable(routeKey, ttId) {
        if (timetableCache.has(routeKey)) return timetableCache.get(routeKey);
        const tt = await ttCol.findOne({ _id: ttId });
        timetableCache.set(routeKey, tt);
        return tt;
    }

    const transferCache = new Map();
    async function getTransfersFrom(stopId) {
        if (transferCache.has(stopId)) return transferCache.get(stopId);
        const trs = await trCol.find({ fromStopId: stopId }).toArray();
        transferCache.set(stopId, trs);
        return trs;
    }

    // bestArrival[stopId] = earliest known arrival time
    const bestArrival = new Map();
    bestArrival.set(originStopId, departureTime);

    // For rebuilding the path at the end
    const journeyPointers = new Map();

    // Stops whose arrival time changed in the last round
    let markedStops = new Set([originStopId]);

    // Main RAPTOR loop
    for (let round = 1; round <= MAX_ROUNDS; round++) {
        if (markedStops.size === 0) break;

        const bestArrivalThisRound = new Map(bestArrival);
        const newMarked = new Set();

        // STEP A: collect routes we should scan
        const routesToScan = new Map();

        for (const stopId of markedStops) {
            const routeEntries = stopRouteIndex.get(stopId) || [];

            for (const { routeKey, stopIndex, ttId } of routeEntries) {
                const existing = routesToScan.get(routeKey);
                // We want to board at the earliest possible stop on this route
                if (!existing || stopIndex < existing.earliestStopIndex) {
                    routesToScan.set(routeKey, { ttId, earliestStopIndex: stopIndex });
                }
            }
        }

        // STEP B: scan each route
        for (const [routeKey, { ttId, earliestStopIndex }] of routesToScan) {
            const timetable = await getFullTimetable(routeKey, ttId);
            if (!timetable) continue;

            let currentTrip = null;
            let boardStopIndex = -1;

            for (let i = earliestStopIndex; i < timetable.stopSequence.length; i++) {
                const stopId = timetable.stopSequence[i];
                const myArrival = bestArrival.get(stopId);

                // Try to catch an earlier trip at this stop
                if (myArrival !== undefined) {
                    const earlierTrip = findEarliestTrip(
                        timetable.trips, i, myArrival,
                        timetable.transitSystem, activeServices
                    );

                    if (earlierTrip !== null) {
                        if (currentTrip === null ||
                            (earlierTrip.stopTimes[i] !== null &&
                             (currentTrip.stopTimes[i] === null ||
                              earlierTrip.stopTimes[i] < currentTrip.stopTimes[i]))) {
                            currentTrip = earlierTrip;
                            boardStopIndex = i;
                        }
                    }
                }

                // If we are on a trip, try to update arrival at this stop
                if (currentTrip !== null) {
                    let arrivalHere = currentTrip.stopTimes[i];
                    if (arrivalHere !== null && arrivalHere !== undefined) {
                        // Adjust with past delay data if available
                        if (historicalCache && boardStopIndex >= 0) {
                            const boardStopId = timetable.stopSequence[boardStopIndex];
                            const hist = historicalCache.get(`${boardStopId}|${stopId}`);
                            if (hist) {
                                const boardTime = currentTrip.stopTimes[boardStopIndex];
                                if (boardTime !== null) {
                                    arrivalHere = boardTime + hist.travelTime.median;
                                }
                            }
                        }

                        const currentBest = bestArrivalThisRound.get(stopId) ?? Infinity;
                        if (arrivalHere < currentBest) {
                            bestArrivalThisRound.set(stopId, arrivalHere);
                            newMarked.add(stopId);

                            journeyPointers.set(`${round}|${stopId}`, {
                                round,
                                type: 'transit',
                                transitSystem: timetable.transitSystem,
                                routeId: timetable.routeId,
                                tripId: currentTrip.tripId,
                                boardStopId: timetable.stopSequence[boardStopIndex],
                                boardStopIndex,
                                alightStopId: stopId,
                                alightStopIndex: i,
                                departureTime: currentTrip.stopTimes[boardStopIndex],
                                arrivalTime: arrivalHere
                            });
                        }
                    }
                }
            }
        }

        // STEP C: try walking transfers from newly reached stops
        const stopsToTransfer = [...newMarked];

        for (const stopId of stopsToTransfer) {
            const transfers = await getTransfersFrom(stopId);
            const arrivalAtStop = bestArrivalThisRound.get(stopId);
            if (arrivalAtStop === undefined) continue;

            for (const transfer of transfers) {
                const arrivalAfterWalk = arrivalAtStop + transfer.walkMinutes;
                const currentBest = bestArrivalThisRound.get(transfer.toStopId) ?? Infinity;

                if (arrivalAfterWalk < currentBest) {
                    bestArrivalThisRound.set(transfer.toStopId, arrivalAfterWalk);
                    newMarked.add(transfer.toStopId);

                    journeyPointers.set(`${round}|${transfer.toStopId}`, {
                        round,
                        type: 'walk',
                        fromStopId: stopId,
                        toStopId: transfer.toStopId,
                        walkMinutes: transfer.walkMinutes,
                        arrivalTime: arrivalAfterWalk
                    });
                }
            }
        }

        // Save updates back to the global best
        for (const [stopId, time] of bestArrivalThisRound) {
            const currentBest = bestArrival.get(stopId) ?? Infinity;
            if (time < currentBest) {
                bestArrival.set(stopId, time);
            }
        }

        markedStops = newMarked;
    }

    // Did we reach the destination?
    const arrivalAtDest = bestArrival.get(destStopId);
    if (arrivalAtDest === undefined || arrivalAtDest === Infinity) {
        return { success: false, error: "No route found between these stops" };
    }

    // Rebuild the journey by following pointers backwards
    const legs = [];
    let currentStopId = destStopId;

    // Find which round first reached the destination
    let destRound = -1;
    for (let r = MAX_ROUNDS; r >= 1; r--) {
        if (journeyPointers.has(`${r}|${destStopId}`)) {
            destRound = r;
            break;
        }
    }

    if (destRound === -1) {
        return { success: false, error: "Route found but could not reconstruct journey" };
    }

    // Walk back from destination to origin
    let currentRound = destRound;
    while (currentStopId !== originStopId && currentRound >= 1) {
        const pointer = journeyPointers.get(`${currentRound}|${currentStopId}`);
        if (!pointer) break;

        legs.unshift(pointer);

        if (pointer.type === 'transit') {
            currentStopId = pointer.boardStopId;
        } else if (pointer.type === 'walk') {
            currentStopId = pointer.fromStopId;
        }

        // Transit leg = previous round; walk = same round
        if (pointer.type === 'transit') {
            currentRound--;
        }
    }

    // Get stop names for the response
    const stopIds = new Set();
    for (const leg of legs) {
        if (leg.type === 'transit') {
            stopIds.add(leg.boardStopId);
            stopIds.add(leg.alightStopId);
        } else {
            stopIds.add(leg.fromStopId);
            stopIds.add(leg.toStopId);
        }
    }
    stopIds.add(originStopId);
    stopIds.add(destStopId);

    const stopDocs = await stopsCol.find(
        { stopId: { $in: Array.from(stopIds) } },
        { projection: { stopId: 1, stopName: 1 } }
    ).toArray();
    const stopNameMap = new Map(stopDocs.map(s => [s.stopId, s.stopName]));

    // Build the final response
    const formattedLegs = legs.map(leg => {
        if (leg.type === 'transit') {
            return {
                type: 'transit',
                transitSystem: leg.transitSystem,
                routeId: leg.routeId,
                boardAt: {
                    stopId: leg.boardStopId,
                    stopName: stopNameMap.get(leg.boardStopId) || leg.boardStopId
                },
                alightAt: {
                    stopId: leg.alightStopId,
                    stopName: stopNameMap.get(leg.alightStopId) || leg.alightStopId
                },
                departureTime: minutesToTimeStr(leg.departureTime),
                arrivalTime: minutesToTimeStr(leg.arrivalTime),
                durationMinutes: leg.arrivalTime - leg.departureTime
            };
        } else {
            return {
                type: 'walk',
                from: {
                    stopId: leg.fromStopId,
                    stopName: stopNameMap.get(leg.fromStopId) || leg.fromStopId
                },
                to: {
                    stopId: leg.toStopId,
                    stopName: stopNameMap.get(leg.toStopId) || leg.toStopId
                },
                walkMinutes: leg.walkMinutes
            };
        }
    });

    return {
        success: true,
        from: {
            stopId: originStopId,
            stopName: stopNameMap.get(originStopId) || originStopId
        },
        to: {
            stopId: destStopId,
            stopName: stopNameMap.get(destStopId) || destStopId
        },
        departureTime: timeStr,
        arrivalTime: minutesToTimeStr(arrivalAtDest),
        totalMinutes: arrivalAtDest - departureTime,
        historicallyAdjusted: useHistorical && historicalCache?.size > 0,
        legs: formattedLegs
    };
}
