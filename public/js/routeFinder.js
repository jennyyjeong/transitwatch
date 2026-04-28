'use strict';

(function () {
  // ---- Station search with autocomplete ----

  let allStations = []; // { stopName, transitSystem, stopIds[] }

  async function loadStations() {
    const res = await fetch('/api/stations');
    allStations = await res.json();
  }

  const SYSTEM_LABELS = {
    MTA_SUBWAY: 'MTA Subway',
    MTA_BUS: 'MTA Bus',
    NJT_BUS: 'NJT Bus',
    NJT_RAIL: 'NJT Rail',
    PATH: 'PATH'
  };

  function setupAutocomplete(inputId, hiddenId, dropdownId) {
    const input = document.getElementById(inputId);
    const hidden = document.getElementById(hiddenId);
    const dropdown = document.getElementById(dropdownId);

    input.addEventListener('input', () => {
      const query = input.value.trim().toLowerCase();
      hidden.value = '';
      if (query.length < 2) { dropdown.style.display = 'none'; return; }

      const matches = allStations
        .filter(s => s.stopName.toLowerCase().includes(query))
        .slice(0, 15);

      if (matches.length === 0) { dropdown.style.display = 'none'; return; }

      dropdown.innerHTML = matches.map(s => {
        const label = SYSTEM_LABELS[s.transitSystem] || s.transitSystem;
        // Join stop IDs with commas (a station may have several platforms)
        const ids = s.stopIds.join(',');
        return `<div class="ac-item" data-ids="${ids}" data-name="${s.stopName}"
          style="padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--border-primary);font-size:0.9em;"
          onmouseover="this.style.background='var(--bg-tertiary)'"
          onmouseout="this.style.background=''"
        ><strong>${s.stopName}</strong> <span style="color:var(--text-tertiary);font-size:0.8em;">${label}</span></div>`;
      }).join('');

      dropdown.style.display = '';

      dropdown.querySelectorAll('.ac-item').forEach(item => {
        item.addEventListener('click', () => {
          input.value = item.dataset.name;
          hidden.value = item.dataset.ids;
          dropdown.style.display = 'none';
        });
      });
    });

    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });
  }

  // ---- Route finding ----

  const findBtn = document.getElementById('find-route');
  const loading = document.getElementById('route-loading');
  const error = document.getElementById('route-error');
  const results = document.getElementById('route-results');
  const scheduledDiv = document.getElementById('result-scheduled');
  const historicalDiv = document.getElementById('result-historical');

  const dateInput = document.getElementById('depart-date');
  dateInput.value = new Date().toISOString().slice(0, 10);

  const timeInput = document.getElementById('depart-time');
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(Math.floor(now.getMinutes() / 5) * 5).padStart(2, '0');
  timeInput.value = `${h}:${m}`;

  findBtn.addEventListener('click', async () => {
    const from = document.getElementById('from-stop-id').value;
    const to = document.getElementById('to-stop-id').value;
    const time = timeInput.value;
    const date = dateInput.value;

    if (!from || !to) {
      error.textContent = 'Please select both origin and destination stops from the dropdown.';
      error.style.display = '';
      return;
    }

    error.style.display = 'none';
    results.style.display = 'none';
    loading.style.display = '';

    try {
      // Backend will try all stop ID combos and pick the best one
      const params = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&time=${time}&date=${date}`;

      const [scheduledRes, historicalRes] = await Promise.all([
        fetch(`/api/route?${params}`),
        fetch(`/api/route?${params}&historical=true`)
      ]);

      const scheduled = await scheduledRes.json();
      const historical = await historicalRes.json();

      loading.style.display = 'none';

      if (!scheduled.success) {
        error.textContent = scheduled.error || 'No route found between these stops.';
        error.style.display = '';
        return;
      }

      results.style.display = '';
      scheduledDiv.innerHTML = renderRoute(scheduled, false);
      historicalDiv.innerHTML = historical.success
        ? renderRoute(historical, true)
        : `<p style="color: var(--text-tertiary);">Same as scheduled (not enough historical data yet)</p>`;

    } catch (err) {
      loading.style.display = 'none';
      error.textContent = 'Error finding route. Please try again.';
      error.style.display = '';
    }
  });

  function renderRoute(data, isHistorical) {
    const adjusted = isHistorical && data.historicallyAdjusted;
    const badge = adjusted
      ? '<span style="background:#2ecc71;color:#fff;padding:2px 8px;border-radius:4px;font-size:0.8em;margin-left:6px;">historically adjusted</span>'
      : '';

    let html = `
      <div style="margin-bottom: var(--space-sm);">
        <div style="font-size: 1.3em; font-weight: bold;">
          ${data.departureTime} &rarr; ${data.arrivalTime} ${badge}
        </div>
        <div style="color: var(--text-secondary);">
          ${data.totalMinutes} min total &middot; ${data.legs.filter(l => l.type === 'transit').length} ride(s)
        </div>
      </div>
    `;

    for (const leg of data.legs) {
      if (leg.type === 'transit') {
        html += `
          <div style="padding: 8px 0; border-left: 4px solid var(--color-primary); padding-left: 12px; margin: 6px 0;">
            <div style="font-weight: bold; margin-bottom: 2px;">${leg.routeId} &middot; ${leg.transitSystem.replace('_', ' ')}</div>
            <div>${leg.boardAt.stopName}</div>
            <div style="color: var(--text-tertiary); font-size: 0.85em; padding: 2px 0;">
              ${leg.departureTime} &rarr; ${leg.arrivalTime} (${leg.durationMinutes} min)
            </div>
            <div>${leg.alightAt.stopName}</div>
          </div>`;
      } else {
        html += `
          <div style="padding: 6px 0; padding-left: 12px; margin: 4px 0; color: var(--text-secondary); font-size: 0.9em;">
            Walk ${leg.walkMinutes} min &middot; ${leg.from.stopName} &rarr; ${leg.to.stopName}
          </div>`;
      }
    }

    return html;
  }

  // ---- Init ----

  loadStations().then(() => {
    setupAutocomplete('from-search', 'from-stop-id', 'from-dropdown');
    setupAutocomplete('to-search', 'to-stop-id', 'to-dropdown');
  });
})();
