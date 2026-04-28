import { stopsCollection, routesCollection } from '../config/mongoCollections.js';
import { getDistance } from 'geolib';
import { StatusError } from '../helpers/helpers.js';

const transit_systems = ["NJT_BUS","NJT_RAIL","MTA_BUS","MTA_SUBWAY","PATH"];

/**
 * Find routes that serve both the origin and destination stop.
 * Only keeps routes where the origin comes before the destination.
 *
 * @param {Object} originStop - origin stop document
 * @param {Object} destinationStop - destination stop document
 * @param {string} transitSystem - e.g. "NJT_BUS"
 * @returns {Promise<Array>} list of valid routes with directions
 * @throws {StatusError} 404 if no valid routes found
 */
export const findCommonRoutes = async (originStop, destinationStop, transitSystem) => {
    const routes = await routesCollection();
    const validRoutes = [];

    // Find route IDs shared by both stops
    const originRouteIds = originStop.routes.map(r => r.routeId);
    const destRouteIds = destinationStop.routes.map(r => r.routeId);
    const commonRouteIds = originRouteIds.filter(id => destRouteIds.includes(id));

    if (commonRouteIds.length === 0) {
        throw new StatusError(
            `No common routes found between ${originStop.stopName} and ${destinationStop.stopName}`,
            404
        );
    }

    // For each shared route, check which directions actually work
    for (const routeId of commonRouteIds) {
        const routeDoc = await routes.findOne({
            routeId: routeId,
            transitSystem
        });

        if (!routeDoc) continue;

        const validDirections = [];

        // A direction works if origin comes before destination on it
        for (const direction of routeDoc.directions) {
            const originStopInDir = direction.stops.find(s => s.stopId === originStop.stopId);
            const destStopInDir = direction.stops.find(s => s.stopId === destinationStop.stopId);

            if (originStopInDir && destStopInDir && originStopInDir.stopOrder < destStopInDir.stopOrder) {
                validDirections.push({
                    directionId: direction.directionId,
                    directionName: direction.directionName,
                    originStopOrder: originStopInDir.stopOrder,
                    destinationStopOrder: destStopInDir.stopOrder
                });
            }
        }

        if (validDirections.length > 0) {
            validRoutes.push({
                routeId: routeDoc.routeId,
                routeName: routeDoc.routeName,
                directions: validDirections
            });
        }
    }

    if (validRoutes.length === 0) {
        throw new StatusError(
            `No valid route directions found between ${originStop.stopName} and ${destinationStop.stopName}`,
            404
        );
    }

    return validRoutes;
};

// Get all stops for a transit system (used for the dropdown)
export const getStopsByTransitSystem = async (transitSystem) => {
    const stops = await stopsCollection();
    return await stops.find({ transitSystem }).toArray();
};

/**
 * Get all stops you can reach from this origin stop.
 * Only includes stops that come AFTER the origin on the same route.
 *
 * @param {string} originStopId - e.g. "NJTB_20883"
 * @returns {Object} { transitSystem, destinations: [{stopId, stopName}, ...] }
 */
export const getPossibleDestinations = async (originStopId) => {
    const stops = await stopsCollection();
    const routes = await routesCollection();

    const originStop = await stops.findOne({ stopId: originStopId });
    if (!originStop) return { transitSystem: null, destinations: [] };

    const destinationSet = new Set();
    const destinationDetails = new Map();

    // Look at every route that serves this stop
    for (const originRoute of originStop.routes) {
        const routeDoc = await routes.findOne({
            routeId: originRoute.routeId,
            transitSystem: originStop.transitSystem
        });

        if (!routeDoc) continue;

        for (const directionName of originRoute.directions) {
            const direction = routeDoc.directions.find(d => d.directionName === directionName);
            if (!direction) continue;

            const originInDirection = direction.stops.find(s => s.stopId === originStopId);
            if (!originInDirection) continue;

            // Add stops that come after the origin
            for (const stop of direction.stops) {
                if (stop.stopOrder > originInDirection.stopOrder) {
                    if (!destinationSet.has(stop.stopId)) {
                        destinationSet.add(stop.stopId);
                        destinationDetails.set(stop.stopId, {
                            stopId: stop.stopId,
                            stopName: stop.stopName
                        });
                    }
                }
            }
        }
    }

    return {
        transitSystem: originStop.transitSystem,
        destinations: Array.from(destinationDetails.values())
    };
};

/**
 * Get all stops that can reach this destination stop.
 * Only includes stops that come BEFORE the destination on the same route.
 *
 * @param {string} destinationStopId - e.g. "NJTB_26229"
 * @returns {Object} { transitSystem, origins: [{stopId, stopName}, ...] }
 */
export const getPossibleOrigins = async (destinationStopId) => {
    const stops = await stopsCollection();
    const routes = await routesCollection();

    const destStop = await stops.findOne({ stopId: destinationStopId });
    if (!destStop) return { transitSystem: null, origins: [] };

    const originSet = new Set();
    const originDetails = new Map();

    for (const destRoute of destStop.routes) {
        const routeDoc = await routes.findOne({
            routeId: destRoute.routeId,
            transitSystem: destStop.transitSystem
        });

        if (!routeDoc) continue;

        for (const directionName of destRoute.directions) {
            const direction = routeDoc.directions.find(d => d.directionName === directionName);
            if (!direction) continue;

            const destInDirection = direction.stops.find(s => s.stopId === destinationStopId);
            if (!destInDirection) continue;

            // Add stops that come before the destination
            for (const stop of direction.stops) {
                if (stop.stopOrder < destInDirection.stopOrder) {
                    if (!originSet.has(stop.stopId)) {
                        originSet.add(stop.stopId);
                        originDetails.set(stop.stopId, {
                            stopId: stop.stopId,
                            stopName: stop.stopName
                        });
                    }
                }
            }
        }
    }

    return {
        transitSystem: destStop.transitSystem,
        origins: Array.from(originDetails.values())
    };
};

/**
 * Frontend usage:
 *   1. Pick a transit system -> GET /api/stops/:system
 *   2. Pick "From" stop -> GET /api/destinations/:fromStopId
 *   3. Pick "To" stop -> GET /api/origins/:toStopId
 *   4. Submit form -> POST /commutes (server validates and re-renders if needed)
 */

/**
 * Calculate walking time between two GPS coordinates.
 * Uses ~1 m/s walking speed to allow for path detours.
 *
 * @param {Array} coords1 - [longitude, latitude] (GeoJSON format)
 * @param {Array} coords2 - [longitude, latitude]
 * @returns {number} walking time in minutes (rounded up)
 */
export const calculateWalkTime = (coords1, coords2) => {
    const distance = getDistance(
        { latitude: coords1[0], longitude: coords1[1] },
        { latitude: coords2[0], longitude: coords2[1] }
    );
    return Math.ceil(distance / 60);
};
