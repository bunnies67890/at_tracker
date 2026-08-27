let allBusesData = [];
const busMarkers = {};

const map = L.map('map').setView([-36.8485, 174.7633], 12);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Prevent Leaflet from intercepting clicks/scrolls on UI overlays
const searchWrapper = document.querySelector('.search-wrapper');
if (searchWrapper) {
  L.DomEvent.disableClickPropagation(searchWrapper);
  L.DomEvent.disableScrollPropagation(searchWrapper);
}

const searchDropdown = document.getElementById('search-results');
if (searchDropdown) {
  L.DomEvent.disableClickPropagation(searchDropdown);
  L.DomEvent.disableScrollPropagation(searchDropdown);
}

// Special and express route prefixes that must be treated as ROUTES (not vehicle fleet IDs)
const KNOWN_EXPRESS_ROUTES = new Set([
  'NX1', 'NX2', 'WX1', 'CTY', 'TMK', 'AIR', 'INN', 'OUT', 'STH', 'EAST', 'WEST', 'ONE', 'DEV', 'RANG', 'MTIA', 'HOBS', 'GULF', 'HMB', 'PINE', 'MTID', 'BAYS', 'BIRK', 'TIRI', 'F', 'WSTH', 'S-C', 'E-W', 'O-W'
]);

/**
 * Converts 12-hour/24-hour time strings (e.g. "4:28 PM", "10:48 PM", "08:15 AM") 
 * into total minutes from midnight for sorting.
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const match = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!match) return 0;
  
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = match[3] ? match[3].toUpperCase() : null;

  if (ampm === 'PM' && hours < 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;

  return hours * 60 + minutes;
}

/**
 * Parses user input to reliably distinguish Routes from Fleet/Vehicle IDs
 */
function parseSearchQuery(rawInput) {
  const query = String(rawInput || '').trim().toUpperCase();
  if (!query) return { type: 'empty', query: '' };

  if (KNOWN_EXPRESS_ROUTES.has(query) || /^(NX|WX|AIR|TMK)\d+$/i.test(query)) {
    return { type: 'route', query };
  }

  if (/^\d{1,3}[A-Z]?$/i.test(query)) {
    return { type: 'route', query };
  }

  return { type: 'vehicle', query };
}

function formatFleetLabel(vehicleId) {
  if (!vehicleId) return 'Unknown';
  return String(vehicleId).trim();
}

function formatCleanDestination(destination) {
  let cleanDest = String(destination || '').trim();
  cleanDest = cleanDest.replace(/^route\s*\w+\s*:?\s*/i, '').trim();

  const parts = cleanDest.split(/\s+to\s+/i);
  if (parts.length > 1) {
    cleanDest = parts.slice(1).join(' to ');
  } else {
    cleanDest = cleanDest.replace(/^to\s+/i, '').trim();
  }
  return cleanDest;
}

function formatTripTitle(routeDisplay, origin, destination) {
  if (!routeDisplay || routeDisplay === 'NIS') return 'Not In Service';

  const cleanDest = formatCleanDestination(destination);
  if (cleanDest) {
    return `${routeDisplay} to ${cleanDest}`;
  }
  return `${routeDisplay}`;
}

function createBusIcon(routeDisplay) {
  const isNis = !routeDisplay || routeDisplay === 'NIS';
  const displayLabel = isNis ? 'NIS' : routeDisplay;

  return L.divIcon({
    className: 'custom-bus-icon',
    html: `<div class="bus-marker-badge ${isNis ? 'nis' : ''}">${displayLabel}</div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19]
  });
}

async function fetchAndRenderBuses() {
  try {
    const res = await fetch('/api/buses/live');
    if (!res.ok) return;
    allBusesData = await res.json();
    renderAllBusesOnMap();
  } catch (err) {
    console.error('Error fetching live bus locations:', err);
  }
}

function renderAllBusesOnMap() {
  allBusesData.forEach((bus) => {
    const fleetLabel = formatFleetLabel(bus.vehicle_id);
    const tripTitle = formatTripTitle(bus.route_display, bus.origin, bus.destination);
    const routeDisplay = bus.route_display || 'NIS';

    const popupContent = `
      <div class="popup-container">
        <h3>${fleetLabel}</h3>
        <p><strong>Trip:</strong> ${tripTitle}</p>
        <p><strong>Departure Time:</strong> ${bus.start_time || 'N/A'}</p>
        <p><strong>Status:</strong> ${bus.tardiness}</p>
        <p><strong>Occupancy:</strong> ${bus.occupancy}</p>
        <button class="btn-history" onclick="openShiftHistory('${bus.vehicle_id}')">View Shift History</button>
      </div>
    `;

    if (busMarkers[bus.vehicle_id]) {
      busMarkers[bus.vehicle_id].setLatLng([bus.latitude, bus.longitude]);
      busMarkers[bus.vehicle_id].setIcon(createBusIcon(routeDisplay));
      busMarkers[bus.vehicle_id].getPopup().setContent(popupContent);
      if (!map.hasLayer(busMarkers[bus.vehicle_id])) {
        busMarkers[bus.vehicle_id].addTo(map);
      }
    } else {
      const icon = createBusIcon(routeDisplay);
      const marker = L.marker([bus.latitude, bus.longitude], { icon }).addTo(map);
      marker.bindPopup(popupContent);
      busMarkers[bus.vehicle_id] = marker;
    }
  });
}

const searchInputBox = document.getElementById('bus-search');
if (searchInputBox) {
  searchInputBox.addEventListener('input', handleSearch);
}

function handleSearch() {
  const rawQuery = (document.getElementById('bus-search')?.value || '').trim();
  const dropdown = document.getElementById('search-results');

  if (!rawQuery) {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    return;
  }

  const parsed = parseSearchQuery(rawQuery);
  const queryLower = rawQuery.toLowerCase();
  let html = '';

  if (parsed.type === 'route') {
    html += `<div class="search-route-header" onclick="openRouteHistoryModal('${parsed.query}')">View Full Route History for ${parsed.query}</div>`;
  } else if (parsed.type === 'vehicle') {
    html += `<div class="search-route-header" onclick="openShiftHistory('${parsed.query}')">View Vehicle History for ${parsed.query}</div>`;
  }

  const matches = allBusesData.filter((bus) => {
    const fleetLabel = formatFleetLabel(bus.vehicle_id).toLowerCase();
    const rawId = String(bus.vehicle_id).toLowerCase();
    const route = String(bus.route_display || '').toLowerCase();
    const dest = String(bus.destination || '').toLowerCase();
    const orig = String(bus.origin || '').toLowerCase();

    return fleetLabel.includes(queryLower) || rawId.includes(queryLower) || route.includes(queryLower) || dest.includes(queryLower) || orig.includes(queryLower);
  }).slice(0, 15);

  matches.forEach((bus) => {
    const fleetLabel = formatFleetLabel(bus.vehicle_id);
    const tripTitle = formatTripTitle(bus.route_display, bus.origin, bus.destination);
    const badgeText = bus.route_display || 'NIS';

    html += `
      <div class="search-result-item" onclick="selectBusFromSearch('${bus.vehicle_id}')">
        <div>
          <div class="result-fleet">${fleetLabel}</div>
          <div class="result-trip">${tripTitle}</div>
        </div>
        <div class="result-badge">${badgeText}</div>
      </div>
    `;
  });

  dropdown.innerHTML = html;
  dropdown.style.display = 'block';
}

function selectBusFromSearch(vehicleId) {
  const bus = allBusesData.find(b => String(b.vehicle_id) === String(vehicleId));
  const dropdown = document.getElementById('search-results');
  
  if (dropdown) dropdown.style.display = 'none';

  if (bus && busMarkers[vehicleId]) {
    map.setView([bus.latitude, bus.longitude], 16);
    busMarkers[vehicleId].openPopup();
  }
}

async function openShiftHistory(vehicleId) {
  try {
    const fleetLabel = formatFleetLabel(vehicleId);
    const res = await fetch(`/api/history/bus/${encodeURIComponent(vehicleId)}`);
    let history = await res.json();

    // Sort vehicle shift history from latest to earliest
    if (history && history.length > 0) {
      history.sort((a, b) => parseTimeToMinutes(b.start_time) - parseTimeToMinutes(a.start_time));
    }

    const modalTitle = document.getElementById('modal-title');
    const modalBody = document.getElementById('modal-body');
    const modalContainer = document.getElementById('modal-container');

    if (modalTitle) modalTitle.innerText = `${fleetLabel} — 7-Day Shift History`;

    if (modalBody) {
      if (!history || history.length === 0) {
        modalBody.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">No recorded shift history available for this vehicle in the last 7 days.</p>';
      } else {
        modalBody.innerHTML = `
          <div class="shift-timeline">
            ${history.map((shift) => {
              const tripTitle = formatTripTitle(shift.route_display, shift.origin, shift.destination);
              return `
                <div class="shift-card">
                  <div class="shift-card-top">
                    <span class="shift-date-badge">${shift.day}</span>
                    <span class="shift-time">Departure: <strong>${shift.start_time}</strong></span>
                  </div>
                  <div class="shift-title">${tripTitle}</div>
                  <div class="shift-status-pill"><strong>${shift.tardiness}</strong></div>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }
    }

    if (modalContainer) modalContainer.style.display = 'block';
  } catch (err) {
    console.error('Error opening shift history:', err);
  }
}

let activeRouteDisplay = '';
let targetTripContext = null;

async function openRouteHistoryModal(routeDisplay, specificTrip = null) {
  activeRouteDisplay = routeDisplay;
  targetTripContext = specificTrip;
  
  const dropdown = document.getElementById('search-results');
  if (dropdown) dropdown.style.display = 'none';

  const modalTitle = document.getElementById('modal-route-title');
  if (modalTitle) modalTitle.innerText = `${routeDisplay} History`;

  const dateSelect = document.getElementById('route-date-select');
  try {
    const res = await fetch(`/api/history/route-days/${encodeURIComponent(routeDisplay)}`);
    const days = await res.json();

    if (dateSelect) {
      if (!days || days.length === 0) {
        const today = new Date().toISOString().split('T')[0];
        dateSelect.innerHTML = `<option value="${today}">${today}</option>`;
      } else {
        dateSelect.innerHTML = days.map(d => `<option value="${d}">${d}</option>`).join('');
      }
    }

    const routeModal = document.getElementById('route-history-modal');
    if (routeModal) routeModal.style.display = 'block';

    loadRouteHistoryForSelectedDate();
  } catch (e) {
    console.error('Error opening route history modal:', e);
  }
}

function getDayOfWeekName(dateStr) {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long' });
  } catch (e) {
    return '';
  }
}

async function loadRouteHistoryForSelectedDate() {
  const dateSelect = document.getElementById('route-date-select');
  const selectedDate = dateSelect ? dateSelect.value : new Date().toISOString().split('T')[0];
  
  const dayOfWeek = getDayOfWeekName(selectedDate);
  const dayNameEl = document.getElementById('selected-day-name');
  if (dayNameEl) dayNameEl.innerText = dayOfWeek ? `(${dayOfWeek})` : '';

  const departuresList = document.getElementById('route-departures-list');
  if (!departuresList) return;

  try {
    const res = await fetch(`/api/history/route/${encodeURIComponent(activeRouteDisplay)}?day=${encodeURIComponent(selectedDate)}`);
    let shifts = await res.json();

    if (!shifts || shifts.length === 0) {
      departuresList.innerHTML = `<p style="color: #666; text-align: center; padding: 20px;">No recorded history for ${activeRouteDisplay} on ${selectedDate}.</p>`;
      return;
    }

    // Sort route departures from latest start time to earliest
    shifts.sort((a, b) => parseTimeToMinutes(b.start_time) - parseTimeToMinutes(a.start_time));

    departuresList.innerHTML = shifts.map((shift) => {
      const tripTitle = formatTripTitle(shift.route_display, shift.origin, shift.destination);
      
      const isTarget = targetTripContext && 
                       String(shift.vehicle_id) === String(targetTripContext.vehicle_id) && 
                       String(shift.start_time) === String(targetTripContext.start_time);

      return `
        <div class="departure-row ${isTarget ? 'highlighted-target-trip' : ''}">
          ${isTarget ? '<span class="target-badge">Selected Route Trip</span>' : ''}
          <div class="departure-main-info">
            <span>Start: <strong>${shift.start_time}</strong> | Fleet: <strong>${formatFleetLabel(shift.vehicle_id)}</strong></span>
            <span><strong>${shift.tardiness}</strong></span>
          </div>
          <div style="font-size: 13px; font-weight: 600; color: #222;">${tripTitle}</div>
          <button class="btn-shift-check" onclick="toggleShiftCheck(this, '${shift.vehicle_id}', '${shift.start_time}', '${shift.route_display}')">Check Shift</button>
          <div class="shift-details-box"></div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Error loading route history:', err);
  }
}

async function toggleShiftCheck(btnEl, vehicleId, targetStartTime, targetRouteDisplay) {
  const row = btnEl.closest('.departure-row');
  const detailsBox = row.querySelector('.shift-details-box');

  if (detailsBox.style.display === 'block') {
    detailsBox.style.display = 'none';
    return;
  }

  try {
    const res = await fetch(`/api/history/bus/${encodeURIComponent(vehicleId)}`);
    let history = await res.json();

    if (!history || history.length === 0) {
      detailsBox.innerHTML = 'No recent shift details found for this vehicle.';
    } else {
      // Sort vehicle shift details from latest to earliest
      history.sort((a, b) => parseTimeToMinutes(b.start_time) - parseTimeToMinutes(a.start_time));

      detailsBox.innerHTML = `
        <div style="font-weight: 700; margin-bottom: 6px; color: #111;">This Shift:</div>
        <ul style="margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px;">
          ${history.slice(0, 5).map(h => {
            const isThisRun = (String(h.start_time) === String(targetStartTime) && String(h.route_display) === String(targetRouteDisplay));
            
            let destText = formatCleanDestination(h.destination);
            let destDisplay = destText ? ` to <strong>${destText}</strong>` : '';

            return `
              <li style="${isThisRun ? 'color: #d9381e;' : ''}">
                ${h.start_time} - ${h.route_display}${destDisplay} (${h.tardiness})
                ${isThisRun ? '<span style="color: #d9381e; font-weight: 700; margin-left: 6px;">(this run)</span>' : ''}
              </li>
            `;
          }).join('')}
        </ul>
      `;
    }
    detailsBox.style.display = 'block';

    detailsBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    detailsBox.innerHTML = 'Could not load shift details.';
    detailsBox.style.display = 'block';
    detailsBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function closeModal() {
  const modalContainer = document.getElementById('modal-container');
  if (modalContainer) modalContainer.style.display = 'none';
}

function closeRouteHistory() {
  const routeModal = document.getElementById('route-history-modal');
  if (routeModal) routeModal.style.display = 'none';
}

window.addEventListener('click', (event) => {
  const modalContainer = document.getElementById('modal-container');
  const routeModal = document.getElementById('route-history-modal');
  const searchWrapper = document.querySelector('.search-wrapper');

  if (event.target === modalContainer) closeModal();
  if (event.target === routeModal) closeRouteHistory();
  if (searchWrapper && !searchWrapper.contains(event.target)) {
    const dropdown = document.getElementById('search-results');
    if (dropdown) dropdown.style.display = 'none';
  }
});

fetchAndRenderBuses();
setInterval(fetchAndRenderBuses, 15000);