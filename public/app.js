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
 * Robustly converts any time format into total minutes from midnight for accurate sorting
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0;
  let s = String(timeStr).trim();
  
  if (s.includes('T') || (s.includes(' ') && s.includes('-'))) {
    const parts = s.split(/[\sT]/);
    s = parts[parts.length - 1];
  }

  const match = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!match) return 0;
  
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = match[3] ? match[3].toUpperCase() : null;

  if (ampm) {
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
  } else {
    if (hours >= 7 && hours <= 11) {
      hours += 12;
    }
  }

  return hours * 60 + minutes;
}

/**
 * Ensures 24-hour time strings or raw timestamps format properly in 12-hour AM/PM format,
 * fixing 00:xx showing up as 12 PM.
 */
function format12HourTime(timeStr) {
  if (!timeStr) return 'N/A';
  let s = String(timeStr).trim();

  // Return directly if already formatted with AM/PM
  if (/AM|PM/i.test(s)) return s;

  // Extract HH:MM from ISO string or HH:MM:SS format
  if (s.includes('T') || s.includes(' ')) {
    const parts = s.split(/[\sT]/);
    s = parts[parts.length - 1];
  }

  const match = s.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return s;

  let hours = parseInt(match[1], 10);
  const minutes = match[2];

  const period = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;

  return `${hours}:${minutes} ${period}`;
}

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
  return `${routeDisplay} — Scheduled Trip`;
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
    const departureTimeFormatted = format12HourTime(bus.start_time);

    const popupContent = `
      <div class="popup-container">
        <h3>${fleetLabel}</h3>
        <p><strong>Trip:</strong> ${tripTitle}</p>
        <p><strong>Departure Time:</strong> ${departureTimeFormatted}</p>
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

let allSevenDayShifts = [];

async function openShiftHistory(vehicleId) {
  try {
    const fleetLabel = formatFleetLabel(vehicleId);
    const modalTitle = document.getElementById('modal-title');
    const modalBody = document.getElementById('modal-body');
    const modalContainer = document.getElementById('modal-container');

    if (modalTitle) modalTitle.innerText = `${fleetLabel} — 7-Day Shift History`;

    if (modalBody) {
      modalBody.innerHTML = `
        <div class="history-controls" style="display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 180px;">
            <label for="shift-history-date-select" style="font-size: 12px; font-weight: 600; display: block; margin-bottom: 4px;">Select Date:</label>
            <select id="shift-history-date-select" onchange="renderSevenDayShiftHistory()" style="width: 100%; padding: 6px; border-radius: 6px; border: 1px solid #ccc; font-size: 13px;">
              <!-- Populated dynamically -->
            </select>
          </div>
          <div style="flex: 2; min-width: 200px;">
            <label for="shift-history-search" style="font-size: 12px; font-weight: 600; display: block; margin-bottom: 4px;">Search:</label>
            <input type="text" id="shift-history-search" oninput="renderSevenDayShiftHistory()" placeholder="Filter by route, destination, time..." style="width: 100%; padding: 6px; border-radius: 6px; border: 1px solid #ccc; box-sizing: border-box; font-size: 13px;">
          </div>
        </div>
        <div id="seven-day-shifts-list" style="max-height: 400px; overflow-y: auto;">
          <p style="color: #666; text-align: center; padding: 20px;">Loading shift history...</p>
        </div>
      `;
    }

    if (modalContainer) modalContainer.style.display = 'block';

    initSevenDayDateDropdown();

    const res = await fetch(`/api/history/bus/${encodeURIComponent(vehicleId)}`);
    let history = await res.json();

    if (history && history.length > 0) {
      history.sort((a, b) => parseTimeToMinutes(b.start_time) - parseTimeToMinutes(a.start_time));
    }
    
    allSevenDayShifts = history || [];
    renderSevenDayShiftHistory();
  } catch (err) {
    console.error('Error opening shift history:', err);
    const modalBody = document.getElementById('modal-body');
    if (modalBody) {
      modalBody.innerHTML = '<p style="color: #d9381e; text-align: center; padding: 20px;">Failed to load shift history for this vehicle.</p>';
    }
  }
}

function initSevenDayDateDropdown() {
  const select = document.getElementById('shift-history-date-select');
  if (!select) return;

  select.innerHTML = '';
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    
    const dayName = d.toLocaleDateString('en-NZ', { weekday: 'long' });

    const option = document.createElement('option');
    option.value = dateStr;
    option.textContent = `${dateStr} (${dayName})`;
    select.appendChild(option);
  }
}

function renderSevenDayShiftHistory() {
  const container = document.getElementById('seven-day-shifts-list');
  if (!container) return;

  const dateSelect = document.getElementById('shift-history-date-select');
  const selectedDate = dateSelect ? dateSelect.value : '';

  const searchInput = document.getElementById('shift-history-search');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

  let selectedDayName = '';
  if (selectedDate) {
    try {
      selectedDayName = new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-NZ', { weekday: 'long' }).toLowerCase();
    } catch (e) {}
  }

  const filtered = allSevenDayShifts.filter((shift) => {
    const shiftDay = String(shift.day || '').trim();
    const shiftDate = String(shift.date || shift.trip_date || shift.timestamp || '').split('T')[0];
    const shiftDayLower = shiftDay.toLowerCase();

    const matchesDate = !selectedDate || 
      shiftDate === selectedDate || 
      shiftDay === selectedDate || 
      shiftDayLower === selectedDate.toLowerCase() ||
      (selectedDayName && shiftDayLower === selectedDayName);

    if (!matchesDate) return false;

    if (!query) return true;
    const route = String(shift.route_display || '').toLowerCase();
    const dest = String(shift.destination || '').toLowerCase();
    const time = format12HourTime(shift.start_time).toLowerCase();
    const tardiness = String(shift.tardiness || '').toLowerCase();
    const tripTitle = formatTripTitle(shift.route_display, shift.origin, shift.destination).toLowerCase();

    return route.includes(query) || dest.includes(query) || time.includes(query) || tardiness.includes(query) || tripTitle.includes(query);
  });

  if (filtered.length === 0) {
    container.innerHTML = `<p style="color: #666; text-align: center; padding: 20px;">No shifts found for this date.</p>`;
    return;
  }

  container.innerHTML = filtered.map((shift) => {
    const tripTitle = formatTripTitle(shift.route_display, shift.origin, shift.destination);
    const isScheduled = !shift.vehicle_id || String(shift.vehicle_id).toUpperCase() === 'SCHEDULED';
    const tardinessDisplay = shift.tardiness || (isScheduled ? 'Scheduled' : 'On Time');
    const timeDisplay = format12HourTime(shift.start_time);

    return `
      <div class="departure-row" style="background: #fff; border: 1px solid #e1e4e8; border-radius: 8px; padding: 12px; margin-bottom: 8px;">
        <div class="departure-main-info" style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px;">
          <span>Start: <strong>${timeDisplay}</strong></span>
          <span><strong>${tardinessDisplay}</strong></span>
        </div>
        <div style="font-size: 13px; font-weight: 600; color: #222;">
          ${tripTitle}
        </div>
      </div>
    `;
  }).join('');
}

let activeRouteDisplay = '';
let targetTripContext = null;
let activeRouteShifts = [];

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
    let days = await res.json();

    const todayStr = new Date().toISOString().split('T')[0];

    // Ensure today's date is ALWAYS injected as an option after midnight
    if (!days || days.length === 0) {
      days = [todayStr];
    } else if (!days.includes(todayStr)) {
      days.unshift(todayStr);
    }

    if (dateSelect) {
      dateSelect.innerHTML = days.map(d => `<option value="${d}">${d}</option>`).join('');
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

  let searchInput = document.getElementById('route-departure-search');
  if (!searchInput && departuresList.parentNode) {
    const searchContainer = document.createElement('div');
    searchContainer.style.marginBottom = '12px';
    searchContainer.innerHTML = `
      <input type="text" id="route-departure-search" placeholder="Search departures (time, fleet, destination)..." 
        style="width: 100%; padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; box-sizing: border-box;"
        oninput="renderFilteredRouteDepartures()" />
    `;
    departuresList.parentNode.insertBefore(searchContainer, departuresList);
  } else if (searchInput) {
    searchInput.value = '';
  }

  try {
    const res = await fetch(`/api/history/route/${encodeURIComponent(activeRouteDisplay)}?day=${encodeURIComponent(selectedDate)}`);
    activeRouteShifts = await res.json();

    if (!activeRouteShifts || activeRouteShifts.length === 0) {
      departuresList.innerHTML = `<p style="color: #666; text-align: center; padding: 20px;">No recorded history for ${activeRouteDisplay} on ${selectedDate}.</p>`;
      return;
    }

    activeRouteShifts.sort((a, b) => parseTimeToMinutes(b.start_time) - parseTimeToMinutes(a.start_time));

    renderFilteredRouteDepartures();
  } catch (err) {
    console.error('Error loading route history:', err);
  }
}

function renderFilteredRouteDepartures() {
  const departuresList = document.getElementById('route-departures-list');
  if (!departuresList) return;

  const searchInput = document.getElementById('route-departure-search');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

  const filtered = activeRouteShifts.filter((shift) => {
    if (!query) return true;
    const startTime = format12HourTime(shift.start_time).toLowerCase();
    const fleet = formatFleetLabel(shift.vehicle_id).toLowerCase();
    const route = String(shift.route_display || '').toLowerCase();
    const dest = formatCleanDestination(shift.destination).toLowerCase();
    const tardiness = String(shift.tardiness || '').toLowerCase();

    return startTime.includes(query) || 
           fleet.includes(query) || 
           route.includes(query) || 
           dest.includes(query) || 
           tardiness.includes(query);
  });

  if (filtered.length === 0) {
    departuresList.innerHTML = `<p style="color: #666; text-align: center; padding: 20px;">No matching departures found.</p>`;
    return;
  }

  departuresList.innerHTML = filtered.map((shift) => {
    const tripTitle = formatTripTitle(shift.route_display, shift.origin, shift.destination);
    const formattedStartTime = format12HourTime(shift.start_time);
    
    const isTarget = targetTripContext && 
                     String(shift.vehicle_id) === String(targetTripContext.vehicle_id) && 
                     String(shift.start_time) === String(targetTripContext.start_time);

    const isScheduled = String(shift.vehicle_id).toUpperCase() === 'SCHEDULED';
    const fleetDisplay = isScheduled 
      ? `<span style="color: #888; font-style: italic;">Scheduled</span>` 
      : `<strong>${formatFleetLabel(shift.vehicle_id)}</strong>`;

    return `
      <div class="departure-row ${isTarget ? 'highlighted-target-trip' : ''}">
        ${isTarget ? '<span class="target-badge">Selected Route Trip</span>' : ''}
        <div class="departure-main-info">
          <span>Start: <strong>${formattedStartTime}</strong> | Fleet: ${fleetDisplay}</span>
          <span><strong>${shift.tardiness}</strong></span>
        </div>
        <div style="font-size: 13px; font-weight: 600; color: #222;">${tripTitle}</div>
        ${isScheduled ? '' : `<button class="btn-shift-check" onclick="toggleShiftCheck(this, '${shift.vehicle_id}', '${shift.start_time}', '${shift.route_display}')">Check Shift</button>`}
        <div class="shift-details-box"></div>
      </div>
    `;
  }).join('');
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
      detailsBox.style.display = 'block';
      return;
    }

    history.sort((a, b) => parseTimeToMinutes(b.start_time) - parseTimeToMinutes(a.start_time));

    row._vehicleHistory = history;
    row._targetStartTime = targetStartTime;
    row._targetRouteDisplay = targetRouteDisplay;

    detailsBox.innerHTML = `
      <div style="font-weight: 700; margin-bottom: 6px; color: #111;">This Shift:</div>
      <input type="text" placeholder="Filter shift trips..." 
        style="width: 100%; padding: 6px 10px; margin-bottom: 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; box-sizing: border-box;"
        oninput="filterShiftDetails(this)" />
      <ul class="shift-details-list" style="margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px;">
        ${renderShiftListItems(history, targetStartTime, targetRouteDisplay)}
      </ul>
    `;
    detailsBox.style.display = 'block';

    detailsBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    detailsBox.innerHTML = 'Could not load shift details.';
    detailsBox.style.display = 'block';
    detailsBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function renderShiftListItems(history, targetStartTime, targetRouteDisplay) {
  return history.map(h => {
    const isThisRun = (String(h.start_time) === String(targetStartTime) && String(h.route_display) === String(targetRouteDisplay));
    const formattedTime = format12HourTime(h.start_time);
    
    let destText = formatCleanDestination(h.destination);
    let destDisplay = destText ? ` to <strong>${destText}</strong>` : '';

    return `
      <li style="${isThisRun ? 'color: #d9381e;' : ''}">
        ${formattedTime} - ${h.route_display}${destDisplay} (${h.tardiness})
        ${isThisRun ? '<span style="color: #d9381e; font-weight: 700; margin-left: 6px;">(this run)</span>' : ''}
      </li>
    `;
  }).join('');
}

function filterShiftDetails(inputEl) {
  const row = inputEl.closest('.departure-row');
  if (!row || !row._vehicleHistory) return;

  const query = inputEl.value.toLowerCase().trim();
  const listEl = row.querySelector('.shift-details-list');
  if (!listEl) return;

  const filtered = row._vehicleHistory.filter(h => {
    if (!query) return true;
    const startTime = format12HourTime(h.start_time).toLowerCase();
    const route = String(h.route_display || '').toLowerCase();
    const dest = formatCleanDestination(h.destination).toLowerCase();
    const tardiness = String(h.tardiness || '').toLowerCase();

    return startTime.includes(query) || 
           route.includes(query) || 
           dest.includes(query) || 
           tardiness.includes(query);
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `<li style="list-style: none; color: #666; font-style: italic;">No matching trips found.</li>`;
    return;
  }

  listEl.innerHTML = renderShiftListItems(filtered, row._targetStartTime, row._targetRouteDisplay);
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