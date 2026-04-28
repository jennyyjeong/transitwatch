import { Router } from 'express';
const router = Router();
import * as userData from '../data/userCommutes.js';
import * as transitData from '../data/transitData.js';
import * as NJTBusHelpers from '../helpers/NJTBusHelpers.js';
import * as NJTRailHelpers from '../helpers/NJTRailHelpers.js'
import * as MTASubwayHelpers from '../helpers/MTASubwayHelpers.js'
import * as MTABusHelpers from '../helpers/MTABusHelpers.js'
import { stopsCollection, reportsCollection, usersCollection } from '../config/mongoCollections.js';
import { findRoute } from '../data/raptor.js';
import { ObjectId } from 'mongodb';
import { getFilteredPositions, getFilteredPosition } from '../tracking/trackingService.js';
import { timingStatsCollection, timetablesCollection } from '../config/mongoCollections.js';

const helpers = { "NJT_BUS": NJTBusHelpers, "NJT_RAIL": NJTRailHelpers, "MTA_SUBWAY": MTASubwayHelpers, "MTA_BUS": MTABusHelpers };

/* ============================================================================
 * ROUTES FOR ADD COMMUTE PAGE - DROPDOWN FILTERING
 * ============================================================================ */

/**
 * GET /api/stops
 * Get all stops (for searching without transit system selected)
 */
// Times Sq-42 St
// → Times Sq-42 St (7 • Flushing-Main St, 7 • Times Sq, 
//                   3 • Harlem-148 St, 3 • New Lots Ave)
function makeSubwayDisplayName(stop) {
  // if there are no routes, return the same name
  if (!stop.routes || stop.routes.length === 0) return stop.stopName;
  const labels = [];
  for (const route of stop.routes) {
    const routeId = route.routeId;
    if (!routeId) continue;

    // add all the directions available
    if (route.directions && route.directions.length > 0) {
      for (const dir of route.directions) {
        labels.push(`${routeId} • ${dir}`);
      }
    } else {
      labels.push(routeId);
    }
  }

  // if both route and dir do not exist, return the same name
  if (labels.length===0) return stop.stopName;

  // if there is any of them, append it
  return `${stop.stopName} (${labels.join(', ')})`;
}
router.get('/stops', async (req, res) => {
    try {
        const stops = await stopsCollection();
        const allStops = await stops.find(
            {},
            { projection: { stopId: 1, stopName: 1, transitSystem: 1, location: 1,
                routes:1
             } }
        ).sort({ stopName: 1 }).toArray();
        const shaped = allStops.map(s => ({
            ...s,
            displayName: s.transitSystem === 'MTA_SUBWAY' 
            ? makeSubwayDisplayName(s) 
            : s.stopName
        }));
        res.json(shaped);
    } catch (e) {
        console.error('Error fetching all stops:', e);
        res.status(500).json({ error: 'Failed to fetch stops' });
    }
});

/**
 * GET /api/stations
 * Get deduplicated stations (grouped by name + transit system).
 * Each station has an array of all underlying stop IDs.
 * Used for Route Finder and anywhere users shouldn't pick a direction.
 */
router.get('/stations', async (req, res) => {
    try {
        const stops = await stopsCollection();
        const allStops = await stops.find(
            {},
            { projection: { stopId: 1, stopName: 1, transitSystem: 1, location: 1 } }
        ).sort({ stopName: 1 }).toArray();

        // Group by "transitSystem|stopName"
        const grouped = new Map();
        for (const s of allStops) {
            const key = `${s.transitSystem}|${s.stopName}`;
            if (!grouped.has(key)) {
                grouped.set(key, {
                    stopName: s.stopName,
                    transitSystem: s.transitSystem,
                    stopIds: [],
                    location: s.location
                });
            }
            grouped.get(key).stopIds.push(s.stopId);
        }

        res.json([...grouped.values()]);
    } catch (e) {
        console.error('Error fetching stations:', e);
        res.status(500).json({ error: 'Failed to fetch stations' });
    }
});

/**
 * GET /api/stops/:transitSystem
 * Get all stops for a transit system (for initial dropdown)
 */
router.get('/stops/:transitSystem', async (req, res) => {
    try {
        const stops = await transitData.getStopsByTransitSystem(req.params.transitSystem);
        res.json(stops);
    } catch (e) {
        console.error('Error fetching stops:', e);
        res.status(e.status || 500).json({ error: e.message || 'Failed to fetch stops' });
    }
});

/**
 * GET /dashboard-api/destinations/:originStopId
 * Get possible destination stops from an origin
 */
router.get('/destinations/:originStopId', async (req, res) => {
    try {
        const result = await transitData.getPossibleDestinations(req.params.originStopId);
        res.json(result);
    } catch (e) {
        console.error('Error fetching destinations:', e);
        res.status(e.status || 500).json({ error: e.message || 'Failed to fetch destinations' });
    }
});

/**
 * GET /dashboard-api/origins/:destinationStopId
 * Get possible origin stops for a destination
 */
router.get('/origins/:destinationStopId', async (req, res) => {
    try {
        const result = await transitData.getPossibleOrigins(req.params.destinationStopId);
        res.json(result);
    } catch (error) {
        console.error('Error fetching origins:', error);
        res.status(500).json({ error: 'Failed to fetch origins' });
    }
});

/**
 * GET /api/walk-time
 * Calculate walking time between two stops
 * Query params: from (stopId), to (stopId)
 */
router.get('/walk-time', async (req, res) => {
    try {
        const { from, to } = req.query;
        
        if (!from || !to) {
            return res.status(400).json({ error: 'Missing from or to parameter' });
        }
        
        const stops = await stopsCollection();
        const [fromStop, toStop] = await Promise.all([
            stops.findOne({ stopId: from }),
            stops.findOne({ stopId: to })
        ]);
        
        if (!fromStop || !toStop) {
            return res.status(404).json({ error: 'Stop not found' });
        }
        
        const fromCoords = fromStop.location?.coordinates;
        const toCoords = toStop.location?.coordinates;
        
        if (!fromCoords || !toCoords) {
            return res.json({ walkTimeMinutes: 5, estimated: true });
        }
        
        const walkTimeMinutes = transitData.calculateWalkTime(fromCoords, toCoords);
        
        res.json({
            walkTimeMinutes: Math.max(1, Math.min(30, walkTimeMinutes)),
            estimated: false
        });
        
    } catch (error) {
        console.error('Error calculating walk time:', error);
        res.status(500).json({ error: 'Failed to calculate walk time' });
    }
});

/* ============================================================================
 * ROUTES FOR DASHBOARD - REAL-TIME TRIP LOOKUPS
 * ============================================================================ */

/**
 * GET /dashboard-api/commute/:commuteId/leg-options/:legOrder
 * Get available trip options for a specific leg
 * 
 * Used when:
 * - User first loads dashboard (legOrder 0)
 * - User marks a leg as "taken" and moves to next leg
 * - User wants to see options for any leg
 */
router.get('/commute/:commuteId/leg-options/:legOrder', async (req, res) => {
    try {
        const userId = req.session.user.userId;
        const { commuteId, legOrder } = req.params;
        const legIndex = parseInt(legOrder);
        
        // Fetch the commute
        const commute = await userData.getCommuteById(userId, commuteId);
        
        if (isNaN(legIndex) || legIndex < 0 || legIndex >= commute.legs.length) {
            return res.status(400).json({ error: 'Invalid leg order' });
        }
        
        const leg = commute.legs[legIndex];
        const helper = helpers[leg.transitMode];
        
        if (!helper) {
            return res.status(400).json({ error: 'Unsupported transit mode' });
        }
        
        // Get available trips starting from now (or could accept minTime as query param)
        const minTime = req.query.minTime ? new Date(req.query.minTime) : new Date();
        const trips = await helper.getAvailableTrips(leg, minTime);
        
        if (trips.length === 0) {
            return res.json({
                available: false,
                message: 'No trips currently available. Service may have ended for the day.',
                legOrder: legIndex
            });
        }
        
        // Update lastUsed timestamp
        await userData.updateCommuteLastUsed(userId, commuteId);
        
        res.json({
            available: true,
            legOrder: legIndex,
            trips: trips
        });
        
    } catch (error) {
        console.error('Error fetching leg options:', error);
        res.status(500).json({ error: error.message || 'Failed to fetch trip options' });
    }
});

/**
 * POST /dashboard-api/commute/:commuteId/calculate
 * Calculate full commute timing from a specific leg onwards
 * 
 * Body:
 * {
 *   beginningLegOrder: number,                 // Which leg to start calculating from (0 = all legs)
 *   selectedTrips: [                           // Array matching leg indices, null = auto-select
 *     null,                                    // Leg 0: auto-select
 *     { tripId: "123", routeInfo: {...} },     // Leg 1: user selected this trip
 *     null,                                    // Leg 2: auto-select
 *     ...
 *   ],
 *   customWalkTimes: [number | null],          // Override walk times [null, 5, null, ...] (index = leg that FOLLOWS the walk)
 *   startTime: ISO string (optional)           // When to start calculating (e.g., arrival time of in-transit leg + walk)
 * }
 * 
 * Response includes the actual walk times used (from custom, stored, or calculated)
 */
router.post('/commute/:commuteId/calculate', async (req, res) => {
    try {
        const userId = req.session.user.userId;
        const { commuteId } = req.params;
        const { beginningLegOrder = 0, selectedTrips = [], customWalkTimes = [], startTime } = req.body;
        
        // Fetch the commute
        const commute = await userData.getCommuteById(userId, commuteId);
        
        if (beginningLegOrder < 0 || beginningLegOrder >= commute.legs.length) {
            return res.status(400).json({ error: 'Invalid beginning leg order' });
        }
        
        const legsToCalculate = commute.legs.slice(beginningLegOrder);
        
        // Fetch all stops we'll need for walk time calculations
        const stops = await stopsCollection();
        const stopIds = legsToCalculate.flatMap(leg => [leg.originStopId, leg.destinationStopId]);
        const stopObjects = await stops.find({ stopId: { $in: [...new Set(stopIds)] } }).toArray();
        const stopMap = Object.fromEntries(stopObjects.map(s => [s.stopId, s]));
        
        const legDetails = [];
        const walkTimesUsed = [];
        let currentMinTime = startTime ? new Date(startTime) : new Date();
        
        for (let i = 0; i < legsToCalculate.length; i++) {
            const leg = legsToCalculate[i];
            const actualLegOrder = beginningLegOrder + i;
            const helper = helpers[leg.transitMode];
            
            if (!helper) {
                // Return partial results with unsupported mode info
                legDetails.push({
                    legOrder: actualLegOrder,
                    transitMode: leg.transitMode,
                    originStopId: leg.originStopId,
                    originStopName: leg.originStopName,
                    destinationStopId: leg.destinationStopId,
                    destinationStopName: leg.destinationStopName,
                    error: `Live data unavailable for ${leg.transitMode}`,
                    unsupported: true
                });
                
                // Still calculate walk time for next leg if applicable
                if (i < legsToCalculate.length - 1) {
                    const walkTimeIndex = actualLegOrder + 1;
                    let walkTime;
                    if (customWalkTimes && customWalkTimes[walkTimeIndex] != null) {
                        walkTime = customWalkTimes[walkTimeIndex];
                    } else {
                        walkTime = legsToCalculate[i+1].preferences?.walkingTimeAfterMinutes ?? legsToCalculate[i+1].walkingTimeAfterMinutes ?? 5;
                    }
                    walkTimesUsed.push({ legIndex: walkTimeIndex, minutes: walkTime, source: customWalkTimes[walkTimeIndex] != null ? 'custom' : 'stored' });
                }
                continue;
            }
            
            try {
                let details;

                // Check if user selected a specific trip for this leg
                const selectedTrip = selectedTrips[actualLegOrder];
                
                if (selectedTrip && selectedTrip.tripId) {
                    // User selected a specific trip for this leg
                    details = await helper.getTripDetails(leg, currentMinTime, selectedTrip.tripId);
                    // Override with the route info from the selection
                    details.routeId = selectedTrip.routeInfo.routeId;
                    details.routeName = selectedTrip.routeInfo.routeName;
                    details.direction = selectedTrip.routeInfo.direction;
                } else {
                    // Auto-select earliest available trip
                    details = await helper.getTripDetails(leg, currentMinTime, null);
                }
                
                legDetails.push({
                    ...details,
                    legOrder: actualLegOrder,
                    transitMode: leg.transitMode
                });
                
                // Calculate walk time to next leg (if there is one)
                if (i < legsToCalculate.length - 1) {
                    // Priority: custom > stored preference > GPS calculation
                    const walkTimeIndex = actualLegOrder + 1;
                    let walkTime;
                    let walkSource;

                    if (customWalkTimes && customWalkTimes[walkTimeIndex] != null)
                    {
                        walkTime = customWalkTimes[walkTimeIndex];
                        walkSource = 'custom';
                    }
                    else
                    {
                        walkTime = legsToCalculate[i+1].preferences?.walkingTimeAfterMinutes ?? legsToCalculate[i+1].walkingTimeAfterMinutes ?? 5;
                        walkSource = 'stored';
                    }
                    
                    walkTimesUsed.push({ 
                        legIndex: walkTimeIndex, 
                        minutes: walkTime, 
                        source: walkSource 
                    });
                    
                    // Update minimum start time for next leg
                    currentMinTime = new Date(details.arrivalTime);
                    currentMinTime.setMinutes(currentMinTime.getMinutes() + walkTime);
                }
                
            } catch (error) {
                // No trips available for this leg
                legDetails.push({
                    legOrder: actualLegOrder,
                    transitMode: leg.transitMode,
                    originStopId: leg.originStopId,
                    originStopName: leg.originStopName,
                    destinationStopId: leg.destinationStopId,
                    destinationStopName: leg.destinationStopName,
                    error: error.message || `No trips available`,
                    unavailable: true
                });

                // Mark subsequent legs as dependent on this unavailable leg
                for (let j = i + 1; j < legsToCalculate.length; j++) {
                    const futureLeg = legsToCalculate[j];
                    legDetails.push({
                        legOrder: beginningLegOrder + j,
                        transitMode: futureLeg.transitMode,
                        originStopId: futureLeg.originStopId,
                        originStopName: futureLeg.originStopName,
                        destinationStopId: futureLeg.destinationStopId,
                        destinationStopName: futureLeg.destinationStopName,
                        error: 'Previous leg unavailable',
                        dependencyError: true
                    });
                }

                return res.json({
                    success: false,
                    error: error.message || `No trips available for leg ${actualLegOrder}`,
                    errorLegOrder: actualLegOrder,
                    beginningLegOrder: beginningLegOrder,
                    legs: legDetails,
                    walkTimes: walkTimesUsed
                });
            }
        }

        const successfulLegs = legDetails.filter(l => !l.error);

        if (successfulLegs.length === 0) {
            return res.json({
                success: false,
                error: 'No legs could be calculated',
                beginningLegOrder: beginningLegOrder,
                legs: legDetails,
                walkTimes: walkTimesUsed
            });
        }
        
        // Calculate totals from successful legs
        const firstDeparture = new Date(successfulLegs[0].departureTime);
        const lastArrival = new Date(successfulLegs[successfulLegs.length - 1].arrivalTime);
        const totalDuration = Math.round((lastArrival - firstDeparture) / (1000 * 60));
        
        // Update lastUsed timestamp
        await userData.updateCommuteLastUsed(userId, commuteId);
        
        res.json({
            success: true,
            beginningLegOrder: beginningLegOrder,
            legs: legDetails,
            walkTimes: walkTimesUsed,
            totalDuration: totalDuration,
            totalTransitTime: successfulLegs.reduce((sum, leg) => sum + (leg.duration || 0), 0),
            totalWalkTime: walkTimesUsed.reduce((sum, w) => sum + w.minutes, 0),
            departureTime: successfulLegs[0].departureTime,
            arrivalTime: successfulLegs[successfulLegs.length - 1].arrivalTime,
            feasibilityScore: 10 // TODO: Calculate from reports subcollection
        });
        
    } catch (error) {
        console.error('Error calculating commute:', error);
        res.status(500).json({ error: error.message || 'Failed to calculate commute' });
    }
});

/**
 * GET /dashboard-api/commutes
 * Get all commutes for the logged-in user
 * (In case we need this for initial page load)
 */
router.get('/commutes', async (req, res) => {
    try {
        const userId = req.session.user.userId;
        const commutes = await userData.getUserCommutes(userId);
        res.json(commutes);
    } catch (error) {
        console.error('Error fetching commutes:', error);
        res.status(500).json({ error: 'Failed to fetch commutes' });
    }
});

/**
 * GET /api/commute/:commuteId/feasibility
 * Get feasibility score for a commute based on reports at its stations
 * 
 * Returns:
 * {
 *   score: number (1-10),
 *   level: 'good' | 'moderate' | 'poor',
 *   message: string
 * }
 * 
 * Score calculation (TODO - implement properly):
 * - 7-10: Good (green) - few or no issues reported
 * - 4-6: Moderate (yellow) - some issues reported
 * - 1-3: Poor (red) - many issues reported
 */
router.get('/commute/:commuteId/feasibility', async (req, res) => {
    try {
        const userId = req.session.user.userId;
        const { commuteId } = req.params;
        
        // Verify the commute exists and belongs to user
        const commute = await userData.getCommuteById(userId, commuteId);
        
        // Get all unique stop IDs from the commute
        const stopIds = new Set();
        commute.legs.forEach(leg => {
            if (leg.originStopId) stopIds.add(leg.originStopId);
            if (leg.destinationStopId) stopIds.add(leg.destinationStopId);
        });
        
        // Get stops with their reports
        const stops = await stopsCollection();
        const reports = await reportsCollection();
        
        const stopDocs = await stops.find({ stopId: { $in: [...stopIds] } }).toArray();
        
        // Collect all report IDs from stops
        const allReportIds = [];
        stopDocs.forEach(stop => {
            if (stop.reports && Array.isArray(stop.reports)) {
                allReportIds.push(...stop.reports);
            }
        });
        
        // If no reports at all, perfect feasibility
        if (allReportIds.length === 0) {
            return res.json({
                score: 10,
                level: 'good',
                message: 'No issues reported on this route'
            });
        }
        
        // Get all reports with netVotes >= 0 and status active
        const validReports = await reports.find({
            _id: { $in: allReportIds },
            netVotes: { $gte: 0 },
            status: 'active'
        }).toArray();
        
        // If no valid reports, perfect feasibility
        if (validReports.length === 0) {
            return res.json({
                score: 10,
                level: 'good',
                message: 'No active issues on this route'
            });
        }
        
        // Calculate feasibility per stop, then average
        const stopFeasibilities = [];
        
        for (const stopId of stopIds) {
            // Find reports that include this stop
            const stopReports = validReports.filter(r => 
                r.stops && r.stops.some(s => s.stopId === stopId)
            );
            
            if (stopReports.length === 0) {
                stopFeasibilities.push(10); // No issues at this stop
            } else {
                // Average (10 - severity) for all reports at this stop
                const feasibilityScores = stopReports.map(r => 10 - (r.severity || 5));
                const avgFeasibility = feasibilityScores.reduce((a, b) => a + b, 0) / feasibilityScores.length;
                stopFeasibilities.push(avgFeasibility);
            }
        }
        
        // Final score is average of all stop feasibilities
        const score = Math.round(stopFeasibilities.reduce((a, b) => a + b, 0) / stopFeasibilities.length);
        
        let level, message;
        if (score >= 7) {
            level = 'good';
            message = 'Route conditions are good';
        } else if (score >= 4) {
            level = 'moderate';
            message = 'Some issues reported on this route';
        } else {
            level = 'poor';
            message = 'Multiple issues reported on this route';
        }
        
        res.json({
            score,
            level,
            message,
            reportCount: validReports.length
        });
        
    } catch (error) {
        console.error('Error fetching feasibility:', error);
        res.status(500).json({ error: error.message || 'Failed to fetch feasibility score' });
    }
});

/**
 * DELETE /dashboard-api/commute/:commuteId
 * Delete a commute
 */
router.delete('/commute/:commuteId', async (req, res) => {
    try {
        const userId = req.session.user.userId;
        await userData.deleteCommute(userId, req.params.commuteId);
        res.json({ success: true, message: 'Commute deleted' });
    } catch (error) {
        console.error('Error deleting commute:', error);
        res.status(500).json({ error: error.message || 'Failed to delete commute' });
    }
});

/* ============================================================================
 * REPORTS APIs - For commute details page
 * ============================================================================ */

/**
 * GET /api/reports/by-stops
 * Get reports for specific stops (used by commute details page)
 * 
 * Query params:
 * - stopIds: JSON array of stop IDs
 * - popular: 'true' to only show reports with netVotes >= 0 (default true)
 */
router.get('/reports/by-stops', async (req, res) => {
    try {
        const { stopIds: stopIdsParam, popular = 'true' } = req.query;
        const userId = req.session.user.userId;
        
        if (!stopIdsParam) {
            return res.status(400).json({ error: 'stopIds parameter required' });
        }
        
        let stopIds;
        try {
            stopIds = JSON.parse(stopIdsParam);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid stopIds format' });
        }
        
        if (!Array.isArray(stopIds) || stopIds.length === 0) {
            return res.status(400).json({ error: 'stopIds must be a non-empty array' });
        }
        
        // Get stops to find their report IDs
        const stops = await stopsCollection();
        const stopDocs = await stops.find({ stopId: { $in: stopIds } }).toArray();
        
        // Collect all report IDs
        const reportIds = new Set();
        stopDocs.forEach(stop => {
            if (stop.reports && Array.isArray(stop.reports)) {
                stop.reports.forEach(id => reportIds.add(id.toString()));
            }
        });
        
        if (reportIds.size === 0) {
            return res.json({ reports: [] });
        }
        
        // Build query
        const query = {
            _id: { $in: [...reportIds].map(id => new ObjectId(id)) }
        };
        
        // Filter by popularity if requested
        if (popular === 'true') {
            query.netVotes = { $gte: 0 };
            query.status = 'active';
        }
        
        // Fetch reports
        const reports = await reportsCollection();
        const reportDocs = await reports.find(query)
            .sort({ netVotes: -1, createdAt: -1 })
            .toArray();
        
        // Get user's vote status for each report
        const users = await usersCollection();
        const user = await users.findOne(
            { userId: userId },
            { projection: { upvotedReports: 1, downvotedReports: 1 } }
        );
        
        const upvotedSet = new Set((user?.upvotedReports || []).map(id => id.toString()));
        const downvotedSet = new Set((user?.downvotedReports || []).map(id => id.toString()));
        
        // Add userVote field to each report
        const reportsWithVotes = reportDocs.map(report => {
            const reportIdStr = report._id.toString();
            let userVote = 0;
            if (upvotedSet.has(reportIdStr)) userVote = 1;
            else if (downvotedSet.has(reportIdStr)) userVote = -1;
            
            return {
                ...report,
                userVote
            };
        });
        
        res.json({ reports: reportsWithVotes });
        
    } catch (error) {
        console.error('Error fetching reports by stops:', error);
        res.status(500).json({ error: error.message || 'Failed to fetch reports' });
    }
});

/**
 * POST /api/reports/:reportId/vote
 * Vote on a report (upvote, downvote, or remove vote)
 * 
 * Body: { vote: 1 | -1 | 0 }
 * - 1 = upvote
 * - -1 = downvote
 * - 0 = remove vote
 */
router.post('/reports/:reportId/vote', async (req, res) => {
    try {
        const { reportId } = req.params;
        const { vote } = req.body;
        const userId = req.session.user.userId;
        
        if (!ObjectId.isValid(reportId)) {
            return res.status(400).json({ error: 'Invalid report ID' });
        }
        
        if (![1, -1, 0].includes(vote)) {
            return res.status(400).json({ error: 'Vote must be 1, -1, or 0' });
        }
        
        const reportObjectId = new ObjectId(reportId);
        const reports = await reportsCollection();
        const users = await usersCollection();
        
        // Get the report
        const report = await reports.findOne({ _id: reportObjectId });
        if (!report) {
            return res.status(404).json({ error: 'Report not found' });
        }
        
        // Get user
        const user = await users.findOne({ userId: userId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Determine current vote status
        const upvotedSet = new Set((user.upvotedReports || []).map(id => id.toString()));
        const downvotedSet = new Set((user.downvotedReports || []).map(id => id.toString()));
        const reportIdStr = reportId;
        
        const hadUpvoted = upvotedSet.has(reportIdStr);
        const hadDownvoted = downvotedSet.has(reportIdStr);
        
        // Calculate vote changes
        let upvoteChange = 0;
        let downvoteChange = 0;
        
        // Remove existing vote first
        if (hadUpvoted) {
            upvoteChange -= 1;
            await users.updateOne(
                { _id: user._id },
                { $pull: { upvotedReports: reportObjectId } }
            );
        }
        if (hadDownvoted) {
            downvoteChange -= 1;
            await users.updateOne(
                { _id: user._id },
                { $pull: { downvotedReports: reportObjectId } }
            );
        }
        
        // Add new vote if not 0
        if (vote === 1) {
            upvoteChange += 1;
            await users.updateOne(
                { _id: user._id },
                { $addToSet: { upvotedReports: reportObjectId } }
            );
        } else if (vote === -1) {
            downvoteChange += 1;
            await users.updateOne(
                { _id: user._id },
                { $addToSet: { downvotedReports: reportObjectId } }
            );
        }
        
        // Update report vote counts
        const newUpvotes = (report.upvotes || 0) + upvoteChange;
        const newDownvotes = (report.downvotes || 0) + downvoteChange;
        const newNetVotes = newUpvotes - newDownvotes;
        
        // Update voters array in report
        let votersUpdate = {};
        if (vote === 0) {
            // Remove from voters
            votersUpdate = { $pull: { voters: { userId: user._id } } };
        } else {
            // First remove old vote, then add new
            await reports.updateOne(
                { _id: reportObjectId },
                { $pull: { voters: { userId: user._id } } }
            );
            votersUpdate = { 
                $push: { voters: { userId: user._id, vote: vote } }
            };
        }
        
        await reports.updateOne(
            { _id: reportObjectId },
            {
                $set: {
                    upvotes: newUpvotes,
                    downvotes: newDownvotes,
                    netVotes: newNetVotes,
                    updatedAt: new Date()
                },
                ...votersUpdate
            }
        );
        
        res.json({
            success: true,
            upvotes: newUpvotes,
            downvotes: newDownvotes,
            netVotes: newNetVotes,
            userVote: vote
        });
        
    } catch (error) {
        console.error('Error voting on report:', error);
        res.status(500).json({ error: error.message || 'Failed to vote' });
    }
});

/* ============================================================================
 * ROUTE FINDING - RAPTOR Algorithm
 * ============================================================================ */

/**
 * GET /api/route
 * Find the best route between two stops using RAPTOR algorithm.
 *
 * Query params:
 *   from  - origin stop ID (e.g., "NJTB_20883")
 *   to    - destination stop ID (e.g., "MTA_SUBWAY_101S")
 *   time  - departure time in HH:MM format (e.g., "08:30")
 *   date  - travel date in YYYY-MM-DD format (e.g., "2026-03-29")
 */
router.get('/route', async (req, res) => {
    try {
        const { from, to, time, date } = req.query;

        // Validate required params
        if (!from || !to || !time || !date) {
            return res.status(400).json({
                error: 'Missing required parameters. Need: from, to, time, date'
            });
        }

        // Validate time format (HH:MM)
        if (!/^\d{1,2}:\d{2}$/.test(time)) {
            return res.status(400).json({ error: 'Invalid time format. Use HH:MM' });
        }

        // Validate date format (YYYY-MM-DD)
        const dateObj = new Date(date + 'T00:00:00');
        if (isNaN(dateObj.getTime())) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }

        if (from === to) {
            return res.status(400).json({ error: 'Origin and destination cannot be the same' });
        }

        const useHistorical = req.query.historical === 'true';

        // Expand stop IDs: if "from" or "to" is a comma-separated list
        // (sent by frontend when a station has multiple stop IDs), try all combos
        const fromIds = from.split(',');
        const toIds = to.split(',');

        let bestResult = null;
        for (const f of fromIds) {
            for (const t of toIds) {
                if (f === t) continue;
                try {
                    const result = await findRoute(f.trim(), t.trim(), time, dateObj, useHistorical);
                    if (result.success) {
                        if (!bestResult || result.totalMinutes < bestResult.totalMinutes) {
                            bestResult = result;
                        }
                    }
                } catch { /* skip failed combos */ }
            }
        }

        if (bestResult) {
            res.json(bestResult);
        } else {
            // Fallback: try original values for error message
            const result = await findRoute(fromIds[0].trim(), toIds[0].trim(), time, dateObj, useHistorical);
            res.json(result);
        }

    } catch (error) {
        console.error('Error finding route:', error);
        res.status(500).json({ error: error.message || 'Failed to find route' });
    }
});

/* ============================================================================
 * VEHICLE TRACKING - Kalman-filtered positions
 * ============================================================================ */

/**
 * GET /api/vehicles
 * Get all tracked vehicle positions (Kalman-filtered)
 * Query params:
 *   - transitSystem: "MTA_SUBWAY" | "NJT_BUS" (optional)
 *   - routeId: e.g. "A", "119" (optional)
 */
router.get('/vehicles', (req, res) => {
    try {
        const { transitSystem, routeId } = req.query;
        const vehicles = getFilteredPositions(transitSystem || null, routeId || null);
        res.json({ vehicles, count: vehicles.length });
    } catch (error) {
        console.error('Error fetching vehicle positions:', error);
        res.status(500).json({ error: 'Failed to fetch vehicle positions' });
    }
});

/**
 * GET /api/vehicles/:vehicleId
 * Get a single vehicle's Kalman-filtered position
 */
router.get('/vehicles/:vehicleId', (req, res) => {
    try {
        const position = getFilteredPosition(req.params.vehicleId);
        if (!position) {
            return res.status(404).json({ error: 'Vehicle not found' });
        }
        res.json(position);
    } catch (error) {
        console.error('Error fetching vehicle position:', error);
        res.status(500).json({ error: 'Failed to fetch vehicle position' });
    }
});

/* ============================================================================
 * TIMING STATISTICS - Historical route timing data
 * ============================================================================ */

/**
 * GET /api/stats/route/:transitSystem/:routeId
 * Get timing statistics for all segments of a route
 * Query params: dayType (weekday|weekend), timeBucket (AM_PEAK|PM_PEAK|...)
 */
router.get('/stats/route/:transitSystem/:routeId', async (req, res) => {
    try {
        const { transitSystem, routeId } = req.params;
        const { dayType, timeBucket } = req.query;

        const query = { transitSystem, routeId };
        if (dayType) query.dayType = dayType;
        if (timeBucket) query.timeBucket = timeBucket;

        const statsCol = await timingStatsCollection();
        const segments = await statsCol.find(query).sort({ fromStopId: 1 }).toArray();

        // Resolve stop names
        const stopIds = new Set();
        segments.forEach(s => { stopIds.add(s.fromStopId); stopIds.add(s.toStopId); });
        const stops = await stopsCollection();
        const stopDocs = await stops.find(
            { stopId: { $in: [...stopIds] } },
            { projection: { stopId: 1, stopName: 1 } }
        ).toArray();
        const nameMap = new Map(stopDocs.map(s => [s.stopId, s.stopName]));

        const enriched = segments.map(s => ({
            ...s,
            fromStopName: nameMap.get(s.fromStopId) || s.fromStopId,
            toStopName: nameMap.get(s.toStopId) || s.toStopId
        }));

        res.json({ transitSystem, routeId, segments: enriched, count: enriched.length });
    } catch (error) {
        console.error('Error fetching route stats:', error);
        res.status(500).json({ error: 'Failed to fetch route statistics' });
    }
});

/**
 * GET /api/stats/segment
 * Get timing statistics for a specific stop pair
 * Query params: from (stopId), to (stopId), dayType, timeBucket
 */
router.get('/stats/segment', async (req, res) => {
    try {
        const { from, to, dayType, timeBucket } = req.query;
        if (!from || !to) {
            return res.status(400).json({ error: 'Missing from or to parameter' });
        }

        const query = { fromStopId: from, toStopId: to };
        if (dayType) query.dayType = dayType;
        if (timeBucket) query.timeBucket = timeBucket;

        const statsCol = await timingStatsCollection();
        const stats = await statsCol.find(query).toArray();

        res.json({ from, to, stats });
    } catch (error) {
        console.error('Error fetching segment stats:', error);
        res.status(500).json({ error: 'Failed to fetch segment statistics' });
    }
});

/* ============================================================================
 * ROUTE SHAPE - Stop coordinates along a route
 * ============================================================================ */

/**
 * GET /api/route-shape/:transitSystem/:routeId
 * Returns ordered stop coordinates for a route (for drawing polylines)
 * Query params: directionId (optional, defaults to "0")
 */
router.get('/route-shape/:transitSystem/:routeId', async (req, res) => {
    try {
        const { transitSystem, routeId } = req.params;
        const directionId = req.query.directionId || '0';

        const ttCol = await timetablesCollection();
        const timetable = await ttCol.findOne(
            { transitSystem, routeId, directionId },
            { projection: { stopSequence: 1 } }
        );

        if (!timetable || !timetable.stopSequence) {
            return res.json({ stops: [] });
        }

        // Look up coordinates for each stop in sequence
        const stops = await stopsCollection();
        const stopDocs = await stops.find(
            { stopId: { $in: timetable.stopSequence } },
            { projection: { stopId: 1, stopName: 1, 'location.coordinates': 1 } }
        ).toArray();

        const stopMap = new Map(stopDocs.map(s => [s.stopId, s]));

        // Return in sequence order with coordinates
        const shape = timetable.stopSequence
            .map(id => {
                const s = stopMap.get(id);
                if (!s?.location?.coordinates) return null;
                return {
                    stopId: id,
                    stopName: s.stopName,
                    lat: s.location.coordinates[1],
                    lng: s.location.coordinates[0]
                };
            })
            .filter(Boolean);

        res.json({ stops: shape });
    } catch (error) {
        console.error('Error fetching route shape:', error);
        res.status(500).json({ error: 'Failed to fetch route shape' });
    }
});

export default router;