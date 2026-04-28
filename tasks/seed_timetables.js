/**
 * Seed timetables, calendars, and transfers for RAPTOR routing.
 *
 * Reads GTFS data already extracted in ./downloads/.
 * (Run the regular seeds first to download the GTFS zips.)
 *
 * Creates 3 collections:
 *   - calendars: which services run on which days
 *   - timetables: trip schedules grouped by route + direction
 *   - transfers: pairs of stops you can walk between
 *
 * Usage: node tasks/seed_timetables.js
 */

import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { getDistance } from 'geolib';
import { dbConnection, closeConnection } from '../config/mongoConnection.js';
import {
    timetablesCollection,
    calendarsCollection,
    transfersCollection,
    stopsCollection
} from '../config/mongoCollections.js';

// ============================================================
// CONFIG - one entry per transit system
// ============================================================

const SYSTEMS = [
    {
        name: "NJT_BUS",
        folder: "./downloads/njt_bus_gtfs",
        // NJT uses stop_code (the public number), not stop_id
        useStopCode: true,
        stopPrefix: "NJTB_",
        routeIdFn: (routeId) => routeId,
        hasCalendarTxt: false
    },
    {
        name: "NJT_RAIL",
        folder: "./downloads/njt_rail_gtfs",
        useStopCode: true,
        stopPrefix: "NJTR_",
        routeIdFn: (routeId) => routeId,
        hasCalendarTxt: false
    },
    {
        name: "MTA_SUBWAY",
        folder: "./downloads/MTA_SUBWAY_gtfs",
        useStopCode: false,
        stopPrefix: "MTA_SUBWAY_",
        routeIdFn: (routeId) => routeId,
        hasCalendarTxt: true
    },
    {
        name: "MTA_BUS",
        // MTA Bus has 6 subfolders
        folders: [
            "./downloads/MTA_BUS_gtfs/bx",
            "./downloads/MTA_BUS_gtfs/b",
            "./downloads/MTA_BUS_gtfs/m",
            "./downloads/MTA_BUS_gtfs/q",
            "./downloads/MTA_BUS_gtfs/si",
            "./downloads/MTA_BUS_gtfs/busco"
        ],
        useStopCode: false,
        stopPrefix: "MTA_BUS_",
        // MTA Bus uses SIRI format for route IDs
        routeIdFn: (routeId, routeRow) => {
            const agency = (routeRow?.agency_id || 'MTA NYCT').trim();
            return `${agency}_${routeId}`;
        },
        hasCalendarTxt: true,
        isMultiFolder: true
    },
    {
        name: "PATH",
        folder: "./downloads/path_gtfs",
        useStopCode: false,
        stopPrefix: "PATH_",
        routeIdFn: (routeId) => routeId,
        hasCalendarTxt: true
    }
];

const WALK_RADIUS_METERS = 400;
const WALK_SPEED_MPS = 1.0;  // ~3.6 km/h, slightly slow to allow for path detours

// ============================================================
// HELPERS
// ============================================================

// Convert GTFS time string to minutes from midnight.
// GTFS allows hours >= 24 for service running past midnight.
// "08:05:00" -> 485, "25:30:00" -> 1530
function timeToMinutes(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.trim().split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

// Read a CSV file and return all rows
function readCsv(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        if (!fs.existsSync(filePath)) {
            resolve([]);
            return;
        }
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => results.push(row))
            .on('end', () => resolve(results))
            .on('error', (err) => reject(err));
    });
}

// Read a CSV from multiple folders and combine. Used for MTA Bus.
async function readCsvMulti(folders, fileName) {
    let allRows = [];
    for (const folder of folders) {
        const filePath = path.join(folder, fileName);
        const rows = await readCsv(filePath);
        // Don't use spread (...) here - it crashes on huge arrays
        allRows = allRows.concat(rows);
    }
    return allRows;
}

async function readCsvForSystem(system, fileName) {
    if (system.isMultiFolder) {
        return readCsvMulti(system.folders, fileName);
    }
    return readCsv(path.join(system.folder, fileName));
}

function systemExists(system) {
    if (system.isMultiFolder) {
        return system.folders.some(f => fs.existsSync(f));
    }
    return fs.existsSync(system.folder);
}

// ============================================================
// STEP 1: SEED CALENDARS
// ============================================================

async function seedCalendars() {
    console.log("\n=== STEP 1: Seeding calendars ===");
    const calCol = await calendarsCollection();
    await calCol.deleteMany({});

    for (const system of SYSTEMS) {
        if (!systemExists(system)) {
            console.log(`  [${system.name}] GTFS folder not found, skipping`);
            continue;
        }

        console.log(`  [${system.name}] Reading calendar data...`);

        // Build a map: serviceId -> document
        const calendarMap = new Map();

        // Read calendar.txt if it exists (MTA, PATH)
        if (system.hasCalendarTxt) {
            const calendarRows = await readCsvForSystem(system, 'calendar.txt');
            for (const row of calendarRows) {
                calendarMap.set(row.service_id, {
                    serviceId: row.service_id,
                    transitSystem: system.name,
                    type: "regular",
                    days: [
                        parseInt(row.monday),
                        parseInt(row.tuesday),
                        parseInt(row.wednesday),
                        parseInt(row.thursday),
                        parseInt(row.friday),
                        parseInt(row.saturday),
                        parseInt(row.sunday)
                    ],
                    startDate: row.start_date,
                    endDate: row.end_date,
                    exceptions: []
                });
            }
        }

        // Read calendar_dates.txt (every system has this)
        const datesRows = await readCsvForSystem(system, 'calendar_dates.txt');
        for (const row of datesRows) {
            if (!calendarMap.has(row.service_id)) {
                // NJT systems: no calendar.txt - create dates_only entry
                calendarMap.set(row.service_id, {
                    serviceId: row.service_id,
                    transitSystem: system.name,
                    type: "dates_only",
                    days: null,
                    startDate: null,
                    endDate: null,
                    exceptions: []
                });
            }
            calendarMap.get(row.service_id).exceptions.push({
                date: row.date,
                type: parseInt(row.exception_type)
            });
        }

        const docs = Array.from(calendarMap.values());
        if (docs.length > 0) {
            await calCol.insertMany(docs);
            console.log(`  [${system.name}] Inserted ${docs.length} calendar entries`);
        }
    }

    await calCol.createIndex({ transitSystem: 1, serviceId: 1 });
    console.log("  Calendars done!");
}

// ============================================================
// STEP 2: SEED TIMETABLES
// ============================================================

async function seedTimetables() {
    console.log("\n=== STEP 2: Seeding timetables ===");
    const ttCol = await timetablesCollection();
    await ttCol.deleteMany({});

    for (const system of SYSTEMS) {
        if (!systemExists(system)) {
            console.log(`  [${system.name}] GTFS folder not found, skipping`);
            continue;
        }

        console.log(`  [${system.name}] Reading GTFS files...`);

        const [tripsData, stopTimesData, stopsData, routesData] = await Promise.all([
            readCsvForSystem(system, 'trips.txt'),
            readCsvForSystem(system, 'stop_times.txt'),
            readCsvForSystem(system, 'stops.txt'),
            readCsvForSystem(system, 'routes.txt')
        ]);

        console.log(`  [${system.name}] ${tripsData.length} trips, ${stopTimesData.length} stop_times`);

        // Lookup map for NJT stop_code translation
        const stopInfoMap = new Map();
        stopsData.forEach(s => {
            stopInfoMap.set(s.stop_id, { code: s.stop_code, name: s.stop_name });
        });

        // Lookup for MTA Bus SIRI route ID
        const routeRowMap = new Map();
        routesData.forEach(r => {
            routeRowMap.set(r.route_id, r);
        });

        // tripId -> { routeId, directionId, serviceId }
        const tripMap = new Map();
        tripsData.forEach(t => {
            const routeRow = routeRowMap.get(t.route_id);
            tripMap.set(t.trip_id, {
                routeId: system.routeIdFn(t.route_id, routeRow),
                directionId: t.direction_id || "0",
                serviceId: t.service_id
            });
        });

        // Convert GTFS stop_id to our stopId format
        function toOurStopId(gtfsStopId) {
            if (system.useStopCode) {
                const info = stopInfoMap.get(gtfsStopId);
                if (!info || !info.code) return null;
                return system.stopPrefix + info.code;
            }
            return system.stopPrefix + gtfsStopId;
        }

        // Group stop_times rows by trip_id
        console.log(`  [${system.name}] Grouping stop times by trip...`);
        const tripStopTimes = new Map();

        for (const st of stopTimesData) {
            const tripMeta = tripMap.get(st.trip_id);
            if (!tripMeta) continue;

            const stopId = toOurStopId(st.stop_id);
            if (!stopId) continue;

            if (!tripStopTimes.has(st.trip_id)) {
                tripStopTimes.set(st.trip_id, []);
            }
            tripStopTimes.get(st.trip_id).push({
                stopId,
                arrival: timeToMinutes(st.arrival_time),
                departure: timeToMinutes(st.departure_time),
                sequence: parseInt(st.stop_sequence)
            });
        }

        // Sort each trip's stops by sequence number
        for (const [, stops] of tripStopTimes) {
            stops.sort((a, b) => a.sequence - b.sequence);
        }

        // Group trips by route + direction
        console.log(`  [${system.name}] Grouping by route+direction...`);
        const routeDirGroups = new Map();

        for (const [tripId, stops] of tripStopTimes) {
            const meta = tripMap.get(tripId);
            if (!meta) continue;

            const key = `${meta.routeId}|${meta.directionId}`;
            if (!routeDirGroups.has(key)) {
                routeDirGroups.set(key, []);
            }
            routeDirGroups.get(key).push({
                tripId,
                serviceId: meta.serviceId,
                stops
            });
        }

        // Build timetable documents (one per route + direction)
        console.log(`  [${system.name}] Building ${routeDirGroups.size} timetable documents...`);
        const timetableDocs = [];

        for (const [key, trips] of routeDirGroups) {
            const [routeId, directionId] = key.split('|');

            // Use the longest trip as the canonical stop list
            // (some trips may skip stops, e.g., express service)
            let longestTrip = trips[0];
            for (const trip of trips) {
                if (trip.stops.length > longestTrip.stops.length) {
                    longestTrip = trip;
                }
            }
            const stopSequence = longestTrip.stops.map(s => s.stopId);

            // Align each trip's times to the canonical sequence
            const alignedTrips = [];

            for (const trip of trips) {
                const stopTimeMap = new Map();
                for (const s of trip.stops) {
                    stopTimeMap.set(s.stopId, { arrival: s.arrival, departure: s.departure });
                }

                // null = this trip skips this stop
                const stopTimes = stopSequence.map(stopId => {
                    const times = stopTimeMap.get(stopId);
                    return times ? times.arrival : null;
                });

                alignedTrips.push({
                    tripId: trip.tripId,
                    serviceId: trip.serviceId,
                    stopTimes
                });
            }

            // Sort trips by departure time at the first stop
            alignedTrips.sort((a, b) => {
                const aFirst = a.stopTimes.find(t => t !== null) ?? Infinity;
                const bFirst = b.stopTimes.find(t => t !== null) ?? Infinity;
                return aFirst - bFirst;
            });

            timetableDocs.push({
                transitSystem: system.name,
                routeId,
                directionId,
                stopSequence,
                trips: alignedTrips
            });
        }

        // Insert in batches to avoid memory spikes
        if (timetableDocs.length > 0) {
            const BATCH_SIZE = 100;
            for (let i = 0; i < timetableDocs.length; i += BATCH_SIZE) {
                const batch = timetableDocs.slice(i, i + BATCH_SIZE);
                await ttCol.insertMany(batch);
            }
            console.log(`  [${system.name}] Inserted ${timetableDocs.length} timetable documents`);
        }

        // Free memory before the next system
        tripStopTimes.clear();
        routeDirGroups.clear();
    }

    await ttCol.createIndex({ transitSystem: 1, routeId: 1, directionId: 1 });
    await ttCol.createIndex({ stopSequence: 1 });
    console.log("  Timetables done!");
}

// ============================================================
// STEP 3: SEED TRANSFERS
// ============================================================

async function seedTransfers() {
    console.log("\n=== STEP 3: Seeding transfers ===");
    const trCol = await transfersCollection();
    await trCol.deleteMany({});

    const stopsCol = await stopsCollection();

    // Geo index lets us run $near queries efficiently
    await stopsCol.createIndex({ location: "2dsphere" });

    const allStops = await stopsCol.find(
        {},
        { projection: { stopId: 1, location: 1, transitSystem: 1 } }
    ).toArray();

    console.log(`  Processing ${allStops.length} stops for nearby transfers...`);

    const transfers = [];
    let processed = 0;

    for (const stop of allStops) {
        if (!stop.location?.coordinates) continue;

        // Find stops within walking radius
        const nearby = await stopsCol.find({
            stopId: { $ne: stop.stopId },
            location: {
                $near: {
                    $geometry: stop.location,
                    $maxDistance: WALK_RADIUS_METERS
                }
            }
        }, {
            projection: { stopId: 1, location: 1, transitSystem: 1 }
        }).toArray();

        for (const nearStop of nearby) {
            if (!nearStop.location?.coordinates) continue;

            const distance = getDistance(
                { latitude: stop.location.coordinates[1], longitude: stop.location.coordinates[0] },
                { latitude: nearStop.location.coordinates[1], longitude: nearStop.location.coordinates[0] }
            );
            const walkMinutes = Math.ceil(distance / (WALK_SPEED_MPS * 60));

            if (walkMinutes > 0 && walkMinutes <= 8) {
                transfers.push({
                    fromStopId: stop.stopId,
                    toStopId: nearStop.stopId,
                    walkMinutes
                });
            }
        }

        processed++;
        if (processed % 5000 === 0) {
            console.log(`  Processed ${processed}/${allStops.length} stops, ${transfers.length} transfers found so far`);
        }

        // Insert in batches to keep memory usage low
        if (transfers.length >= 10000) {
            await trCol.insertMany(transfers);
            transfers.length = 0;
        }
    }

    if (transfers.length > 0) {
        await trCol.insertMany(transfers);
    }

    await trCol.createIndex({ fromStopId: 1 });

    const totalCount = await trCol.countDocuments();
    console.log(`  Transfers done! Total: ${totalCount} transfer pairs`);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    console.log("Starting timetable seed...\n");

    await dbConnection();

    await seedCalendars();
    await seedTimetables();
    await seedTransfers();

    console.log("\n=== All done! ===");
    await closeConnection();
}

main().catch(err => {
    console.error("Seed failed:", err);
    process.exit(1);
});
