'use strict';

(function () {
  // ---- Section 1: Live vehicle tracking on map ----

  const vehicleCount = document.getElementById('vehicle-count');
  const vehicleUpdated = document.getElementById('vehicle-updated');
  const commuteFilter = document.getElementById('commute-filter');
  const mapLegend = document.getElementById('map-legend');

  // Map centered on NYC / NJ area
  const map = L.map('map').setView([40.75, -74.0], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18
  }).addTo(map);

  const ROUTE_COLORS = [
    '#0039A6', '#EE352E', '#00933C', '#B933AD',
    '#FF6319', '#6CBE45', '#996633', '#808183'
  ];

  // Vehicle marker: a colored dot placed on top of the route line
  function vehicleIcon(color) {
    return L.divIcon({
      className: '',
      html: `<div style="
        width: 18px; height: 18px;
        background: ${color};
        border: 3px solid #fff;
        border-radius: 50%;
        box-shadow: 0 0 6px rgba(0,0,0,0.5);
      "></div>`,
      iconSize: [24, 24], iconAnchor: [12, 12]
    });
  }

  function stopDot(color) {
    return L.circleMarker([0, 0], {
      radius: 4, color: '#fff', fillColor: color,
      fillOpacity: 1, weight: 2
    });
  }

  function endpointIcon(label) {
    return L.divIcon({
      className: '',
      html: `<div style="background:#fff;color:#000;border:2px solid #333;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:bold;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.3);">${label}</div>`,
      iconSize: null, iconAnchor: [4, 14]
    });
  }

  let vehicleMarkers = L.layerGroup().addTo(map);
  let stopMarkers = L.layerGroup().addTo(map);
  let routeLines = L.layerGroup().addTo(map);
  let commuteList = [];
  let selectedCommute = null;

  // Saved polyline coords per route. Used to snap vehicles to the route.
  // "system|routeId" -> [[lat, lng], [lat, lng], ...]
  let routePolylines = {};

  // ---- Math: snap a point to the closest place on a line ----

  // Find the closest point on segment AB to point P
  function closestPointOnSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { pt: a, dist: distance(p, a) };

    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const pt = [a[0] + t * dx, a[1] + t * dy];
    return { pt, dist: distance(p, pt) };
  }

  function distance(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Move the point to the nearest position on a polyline
  function snapToPolyline(lat, lng, polyCoords) {
    if (!polyCoords || polyCoords.length < 2) return [lat, lng];

    let best = null;
    for (let i = 0; i < polyCoords.length - 1; i++) {
      const result = closestPointOnSegment([lat, lng], polyCoords[i], polyCoords[i + 1]);
      if (!best || result.dist < best.dist) {
        best = result;
      }
    }
    return best ? best.pt : [lat, lng];
  }

  // ---- Commute loading ----

  async function loadCommutes() {
    try {
      const res = await fetch('/api/commutes');
      commuteList = await res.json();

      commuteFilter.innerHTML = '<option value="">Select a commute</option>';
      for (const c of commuteList) {
        const legs = c.legs || [];
        const summary = legs.map(l => l.routes?.map(r => r.routeId).join('/') || l.transitMode).join(' → ');
        const opt = document.createElement('option');
        opt.value = c._id;
        opt.textContent = `${c.name} (${summary})`;
        commuteFilter.appendChild(opt);
      }
    } catch (err) {
      commuteFilter.innerHTML = '<option value="">Error loading commutes</option>';
    }
  }

  commuteFilter.addEventListener('change', () => {
    selectedCommute = commuteList.find(c => c._id === commuteFilter.value) || null;
    stopMarkers.clearLayers();
    routeLines.clearLayers();
    vehicleMarkers.clearLayers();
    routePolylines = {};

    if (!selectedCommute) {
      vehicleCount.textContent = '';
      mapLegend.innerHTML = '';
      map.setView([40.75, -74.0], 12);
      return;
    }

    showCommuteRoute(selectedCommute);
  });

  // ---- Draw the route on the map ----

  async function showCommuteRoute(commute) {
    stopMarkers.clearLayers();
    routeLines.clearLayers();
    routePolylines = {};
    const allBounds = [];
    const { colorMap } = getCommuteRouteInfo();

    for (const leg of commute.legs) {
      const routes = leg.routes || [];
      if (routes.length === 0) continue;

      const route = routes[0];
      const directionId = route.directions?.[0]?.directionId || '0';
      const routeKey = `${leg.transitMode}|${route.routeId}`;
      const color = colorMap[routeKey] || '#888';

      try {
        const res = await fetch(`/api/route-shape/${leg.transitMode}/${route.routeId}?directionId=${directionId}`);
        const data = await res.json();
        const shapeStops = data.stops || [];
        if (shapeStops.length === 0) continue;

        // Cut the shape down to only the part the user actually rides
        const originIdx = shapeStops.findIndex(s => s.stopId === leg.originStopId);
        const destIdx = shapeStops.findIndex(s => s.stopId === leg.destinationStopId);

        let segmentStops;
        if (originIdx !== -1 && destIdx !== -1 && originIdx < destIdx) {
          segmentStops = shapeStops.slice(originIdx, destIdx + 1);
        } else {
          segmentStops = shapeStops;
        }

        const latlngs = segmentStops.map(s => [s.lat, s.lng]);
        if (latlngs.length < 2) continue;

        // Save the line so we can snap vehicles to it later
        routePolylines[routeKey] = latlngs;

        // Draw the route as a thick colored line
        L.polyline(latlngs, { color, weight: 14, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }).addTo(routeLines);

        // Put the route name on the middle of the line
        const midIdx = Math.floor(segmentStops.length / 2);
        const mid = segmentStops[midIdx];
        if (mid) {
          L.marker([mid.lat, mid.lng], {
            icon: L.divIcon({
              className: '',
              html: `<div style="background:${color};color:#fff;font-weight:bold;font-size:13px;padding:2px 8px;border-radius:10px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.4);">${route.routeId}</div>`,
              iconSize: null, iconAnchor: [14, 12]
            }),
            zIndexOffset: 800
          }).addTo(routeLines);
        }

        // Show middle stops as small white circles on the line
        for (let i = 1; i < segmentStops.length - 1; i++) {
          const s = segmentStops[i];
          const dot = L.circleMarker([s.lat, s.lng], {
            radius: 6, color, fillColor: '#fff',
            fillOpacity: 1, weight: 3
          }).addTo(stopMarkers);
          dot.bindPopup(`<strong>${s.stopName}</strong>`);
        }

        // Mark the first and last stop with name labels
        const first = segmentStops[0];
        const last = segmentStops[segmentStops.length - 1];
        L.marker([first.lat, first.lng], { icon: endpointIcon(first.stopName), zIndexOffset: 1000 })
          .bindPopup(`<strong>${first.stopName}</strong><br>Board here (Leg ${leg.legOrder + 1})`)
          .addTo(stopMarkers);
        L.marker([last.lat, last.lng], { icon: endpointIcon(last.stopName), zIndexOffset: 1000 })
          .bindPopup(`<strong>${last.stopName}</strong><br>Alight here (Leg ${leg.legOrder + 1})`)
          .addTo(stopMarkers);

        allBounds.push(...latlngs);
      } catch (err) {
        console.error(`Failed to load shape for ${routeKey}:`, err);
      }
    }

    if (allBounds.length >= 2) {
      map.fitBounds(allBounds, { padding: [50, 50] });
    }

    // Routes are drawn - now load the live vehicles
    loadVehicles();
  }

  // ---- Pull route info from the selected commute ----

  function getCommuteRouteInfo() {
    if (!selectedCommute) return { filters: [], colorMap: {} };

    const filters = [];
    const colorMap = {};
    let colorIdx = 0;

    for (const leg of selectedCommute.legs) {
      const system = leg.transitMode;
      for (const r of (leg.routes || [])) {
        const key = `${system}|${r.routeId}`;
        if (!colorMap[key]) {
          colorMap[key] = ROUTE_COLORS[colorIdx % ROUTE_COLORS.length];
          colorIdx++;
          filters.push({ transitSystem: system, routeId: r.routeId });
        }
      }
    }
    return { filters, colorMap };
  }

  // ---- Load vehicles from API and place them on the map ----

  async function loadVehicles() {
    if (!selectedCommute) return;

    const { filters, colorMap } = getCommuteRouteInfo();
    if (filters.length === 0) {
      vehicleCount.textContent = 'No tracked routes';
      return;
    }

    try {
      const systems = [...new Set(filters.map(f => f.transitSystem))];
      const allVehicles = [];

      for (const sys of systems) {
        const res = await fetch(`/api/vehicles?transitSystem=${sys}`);
        const data = await res.json();
        allVehicles.push(...(data.vehicles || []));
      }

      const routeIds = new Set(filters.map(f => f.routeId));
      const filtered = allVehicles.filter(v => routeIds.has(v.routeId));

      vehicleCount.textContent = `${filtered.length} vehicles on your routes`;
      vehicleUpdated.textContent = `Updated: ${new Date().toLocaleTimeString()}`;

      // Legend
      mapLegend.innerHTML = Object.entries(colorMap).map(([key, color]) => {
        const [sys, routeId] = key.split('|');
        const label = sys === 'MTA_SUBWAY' ? `🚇 ${routeId}` : `🚌 ${routeId}`;
        return `<span style="display:inline-flex;align-items:center;margin-right:14px;">` +
          `<span style="display:inline-block;width:12px;height:12px;background:${color};border-radius:50%;border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,0.3);margin-right:5px;"></span>${label}</span>`;
      }).join('');

      // Show each vehicle on the map, snapped to its route line
      vehicleMarkers.clearLayers();
      for (const v of filtered) {
        if (v.lat == null || v.lng == null) continue;

        const routeKey = `${v.transitSystem}|${v.routeId}`;
        const color = colorMap[routeKey] || '#888';
        const polyCoords = routePolylines[routeKey];

        // Move the vehicle onto the route line
        const [snappedLat, snappedLng] = polyCoords
          ? snapToPolyline(v.lat, v.lng, polyCoords)
          : [v.lat, v.lng];

        const marker = L.marker([snappedLat, snappedLng], {
          icon: vehicleIcon(color),
          zIndexOffset: 500
        });
        marker.bindPopup(
          `<strong>Route ${v.routeId}</strong><br>` +
          `${v.transitSystem}<br>` +
          `${v.stale ? '<span style="color:red;">Stale</span>' : '<span style="color:green;">Live</span>'}`
        );
        vehicleMarkers.addLayer(marker);
      }
    } catch (err) {
      vehicleCount.textContent = 'Error loading vehicles';
    }
  }

  loadCommutes();
  setInterval(() => { if (selectedCommute) loadVehicles(); }, 15000);

  // ---- Section 2: Route timing statistics ----

  const statsLoad = document.getElementById('stats-load');
  const statsTable = document.getElementById('stats-table');
  const statsBody = document.getElementById('stats-body');
  const statsEmpty = document.getElementById('stats-empty');
  const statsCount = document.getElementById('stats-count');

  statsLoad.addEventListener('click', async () => {
    const system = document.getElementById('stats-system').value;
    const route = document.getElementById('stats-route').value.trim();
    if (!route) return;

    try {
      const res = await fetch(`/api/stats/route/${system}/${route}`);
      const data = await res.json();
      const segments = data.segments || [];

      statsCount.textContent = `${segments.length} segments`;

      if (segments.length === 0) {
        statsTable.style.display = 'none';
        statsEmpty.textContent = 'No statistics found. Run collect_delays.js and compute_stats.js first.';
        statsEmpty.style.display = '';
        return;
      }

      statsEmpty.style.display = 'none';
      statsTable.style.display = '';

      statsBody.innerHTML = segments.map(s => `
        <tr style="border-bottom: 1px solid var(--border-primary);">
          <td style="padding: 4px 8px; font-size: 0.85em;">${s.fromStopName || s.fromStopId}</td>
          <td style="padding: 4px 8px; font-size: 0.85em;">${s.toStopName || s.toStopId}</td>
          <td style="padding: 4px 8px;">${s.timeBucket}</td>
          <td style="padding: 4px 8px;">${s.dayType}</td>
          <td style="padding: 4px 8px;">${s.sampleCount}</td>
          <td style="padding: 4px 8px;"><strong>${s.travelTime?.median ?? '-'}</strong></td>
          <td style="padding: 4px 8px;">${s.travelTime?.stddev ?? '-'}</td>
        </tr>
      `).join('');
    } catch (err) {
      statsEmpty.textContent = 'Error loading statistics.';
      statsEmpty.style.display = '';
    }
  });

})();
