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

const KNOWN_EXPRESS_ROUTES = new Set([
  'NX1', 'NX2', 'WX1', 'CTY', 'TMK', 'AIR', 'INN', 'OUT', 'STH', 'EAST', 'WEST', 'ONE', 'DEV', 'RANG', 'MTIA', 'HOBS', 'GULF', 'HMB', 'PINE', 'MTID', 'BAYS', 'BIRK', 'TIRI', 'F', 'WSTH', 'S-C', 'E-W', 'O-W'
]);

/**
 * Helper: Safely extracts departure/start time across flexible API field names.
 */
function getTripStartTime(trip) {
  if (!trip || typeof trip !== 'object') return '';
  return trip.start_time || 
         trip.departure_time || 
         trip.scheduled_departure || 
         trip.start_time_iso || 
         trip.time || 
         trip.origin_departure_time || '';
}

/**
 * Helper: Safely extracts vehicle ID across flexible API field names.
 */
function getTripVehicleId(trip) {
  if (!trip || typeof trip !== 'object') return '';
  return trip.vehicle_id || trip.fleet_id || trip.bus_id || trip.vehicle || '';
}

/**
 * Helper: Escapes HTML strings to prevent rendering issues and attribute syntax breakage.
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Helper: Normalizes a date into YYYY-MM-DD string using Auckland local time.
 */
function toDateStr(dateObj) {
  if (!(dateObj instanceof Date) || isNaN(dateObj.getTime())) return '';
  return dateObj.toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
}

/**
 * Parses time into minutes from midnight (0 to 1439).
 * Handles HH:MM, HH:MM:SS, 12-hour AM/PM, and ISO string variations.
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0;
  let s = String(timeStr).trim();
  
  if (s.includes('T')) {
    const parsedDate = new Date(s);
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate.getHours() * 60 + parsedDate.getMinutes();
    }
    s = s.split('T')[1];
  } else if (s.includes(' ') && s.includes('-')) {
    const parts = s.split(/\s+/);
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
    if (hours >= 24) hours = hours % 24;
  }

  return hours * 60 + minutes;
}

/**
 * Formats time into clean 12-hour AM/PM format.
 */
function format12HourTime(rawTime) {
  if (!rawTime) return 'N/A';
  let s = String(rawTime).trim();

  if (s.includes('T')) {
    const parsedDate = new Date(s);
    if (!isNaN(parsedDate.getTime())) {
      let h = parsedDate.getHours();
      const m = String(parsedDate.getMinutes()).padStart(2, '0');
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${h}:${m} ${ampm}`;
    }
    s = s.split('T')[1];
  }

  if (s.includes(' ') && s.includes('-')) {
    const parts = s.split(/\s+/);
    s = parts[parts.length - 1];
  }

  const match = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!match) return s || 'N/A';

  let hours = parseInt(match[1], 10);
  const minutes = match[2];
  const ampm = match[3] ? match[3].toUpperCase() : null;

  if (ampm) {
    if (hours === 0) hours = 12;
    return `${hours}:${minutes} ${ampm}`;
  }

  if (hours >= 24) hours = hours % 24;

  const period = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;

  return `${hours}:${minutes} ${period}`;
}

/**
 * Helper: Determines if a start time is early morning (12:00 AM - 3:59 AM / 0 - 239 mins).
 */
function isEarlyMorningTrip(timeStr) {
  const mins = parseTimeToMinutes(timeStr);
  return mins >= 0 && mins < 240;
}

/**
 * Converts ISO timestamps or raw dates into local YYYY-MM-DD strings.
 */
function getShiftLocalDate(shift) {
  if (!shift || typeof shift !== 'object') return '';

  const rawDate = shift.day || 
                  shift.date || 
                  shift.service_date || 
                  shift.timestamp || 
                  shift.start_time_iso || 
                  getTripStartTime(shift) ||
                  shift.operating_date || 
                  shift.start_date || 
                  shift.departure_date || '';

  if (!rawDate) return '';
  const str = String(rawDate).trim();

  if (str.includes('T')) {
    return str.split('T')[0];
  }

  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(str)) {
    const [d, m, y] = str.split('/');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return toDateStr(parsed);
  }

  return '';
}

function isTripOverdue(startTimeStr, selectedDay) {
  const todayNZ = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
  if (selectedDay !== todayNZ) return false;

  const now = new Date();
  const nzTimeString = now.toLocaleTimeString('en-GB', { timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit' });
  const [currentHours, currentMinutes] = nzTimeString.split(':').map(Number);
  const nowInMinutes = currentHours * 60 + currentMinutes;

  const tripMinutes = parseTimeToMinutes(startTimeStr);
  return nowInMinutes > tripMinutes;
}

/**
 * Filters shift trips for a target selected date.
 */
function processShiftTrips(shiftTrips, selectedDateStr) {
  if (!Array.isArray(shiftTrips) || shiftTrips.length === 0) return [];
  if (!selectedDateStr) return shiftTrips;

  return shiftTrips
    .filter(trip => {
      const tripDate = getShiftLocalDate(trip);
      if (!tripDate) return true;
      return tripDate === selectedDateStr;
    })
    .map(trip => {
      const startTime = getTripStartTime(trip);
      const isEarly = isEarlyMorningTrip(startTime);

      return {
        ...trip,
        commencedYesterday: isEarly
      };
    });
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
    html: `<div class="bus-marker-badge ${isNis ? 'nis' : ''}">${escapeHtml(displayLabel)}</div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19]
  });
}

async function fetchAndRenderBuses() {
  try {
    const res = await fetch('/api/buses/live');
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data)) {
      allBusesData = data;
      renderAllBusesOnMap();
    }
  } catch (err) {
    console.error('Error fetching live bus locations:', err);
  }
}

function renderAllBusesOnMap() {
  const currentVehicleIds = new Set();

  allBusesData.forEach((bus) => {
    const lat = parseFloat(bus.latitude);
    const lng = parseFloat(bus.longitude);
    if (isNaN(lat) || isNaN(lng)) return;

    const vehicleId = String(getTripVehicleId(bus));
    currentVehicleIds.add(vehicleId);

    const fleetLabel = formatFleetLabel(vehicleId);
    const tripTitle = formatTripTitle(bus.route_display, bus.origin, bus.destination);
    const routeDisplay = bus.route_display || 'NIS';
    const departureTimeFormatted = format12HourTime(getTripStartTime(bus));
    const tardinessDisplay = bus.tardiness || 'On Time';
    const occupancyDisplay = bus.occupancy || 'Unknown';

    const popupContent = `
      <div class="popup-container">
        <h3>${escapeHtml(fleetLabel)}</h3>
        <p><strong>Trip:</strong> ${escapeHtml(tripTitle)}</p>
        <p><strong>Departure Time:</strong> ${escapeHtml(departureTimeFormatted)}</p>
        <p><strong>Status:</strong> ${escapeHtml(tardinessDisplay)}</p>
        <p><strong>Occupancy:</strong> ${escapeHtml(occupancyDisplay)}</p>
        <button class="btn-history" onclick="openShiftHistory('${escapeHtml(vehicleId)}')">View Shift History</button>
      </div>
    `;

    if (busMarkers[vehicleId]) {
      busMarkers[vehicleId].setLatLng([lat, lng]);
      busMarkers[vehicleId].setIcon(createBusIcon(routeDisplay));
      busMarkers[vehicleId].getPopup().setContent(popupContent);
      if (!map.hasLayer(busMarkers[vehicleId])) {
        busMarkers[vehicleId].addTo(map);
      }
    } else {
      const icon = createBusIcon(routeDisplay);
      const marker = L.marker([lat, lng], { icon }).addTo(map);
      marker.bindPopup(popupContent);
      busMarkers[vehicleId] = marker;
    }
  });

  Object.keys(busMarkers).forEach((vId) => {
    if (!currentVehicleIds.has(vId)) {
      map.removeLayer(busMarkers[vId]);
      delete busMarkers[vId];
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

  if (!dropdown) return;

  if (!rawQuery) {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    return;
  }

  const parsed = parseSearchQuery(rawQuery);
  const queryLower = rawQuery.toLowerCase();
  let html = '';

  if (parsed.type === 'route') {
    html += `<div class="search-route-header" onclick="openRouteHistoryModal('${escapeHtml(parsed.query)}')">View Full Route History for ${escapeHtml(parsed.query)}</div>`;
  } else if (parsed.type === 'vehicle') {
    html += `<div class="search-route-header" onclick="openShiftHistory('${escapeHtml(parsed.query)}')">View Vehicle History for ${escapeHtml(parsed.query)}</div>`;
  }

  const matches = allBusesData.filter((bus) => {
    const vId = getTripVehicleId(bus);
    const fleetLabel = formatFleetLabel(vId).toLowerCase();
    const rawId = String(vId).toLowerCase();
    const route = String(bus.route_display || '').toLowerCase();
    const dest = String(bus.destination || '').toLowerCase();
    const orig = String(bus.origin || '').toLowerCase();

    return fleetLabel.includes(queryLower) || rawId.includes(queryLower) || route.includes(queryLower) || dest.includes(queryLower) || orig.includes(queryLower);
  }).slice(0, 15);

  matches.forEach((bus) => {
    const vId = getTripVehicleId(bus);
    const fleetLabel = formatFleetLabel(vId);
    const tripTitle = formatTripTitle(bus.route_display, bus.origin, bus.destination);
    const badgeText = bus.route_display || 'NIS';

    html += `
      <div class="search-result-item" onclick="selectBusFromSearch('${escapeHtml(vId)}')">
        <div>
          <div class="result-fleet">${escapeHtml(fleetLabel)}</div>
          <div class="result-trip">${escapeHtml(tripTitle)}</div>
        </div>
        <div class="result-badge">${escapeHtml(badgeText)}</div>
      </div>
    `;
  });

  dropdown.innerHTML = html;
  dropdown.style.display = 'block';
}

function selectBusFromSearch(vehicleId) {
  const bus = allBusesData.find(b => String(getTripVehicleId(b)) === String(vehicleId));
  const dropdown = document.getElementById('search-results');
  
  if (dropdown) dropdown.style.display = 'none';

  if (bus && busMarkers[vehicleId]) {
    const lat = parseFloat(bus.latitude);
    const lng = parseFloat(bus.longitude);
    if (!isNaN(lat) && !isNaN(lng)) {
      map.setView([lat, lng], 16);
      busMarkers[vehicleId].openPopup();
    }
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
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    
    let history = await res.json();
    if (!Array.isArray(history)) history = [];

    history.sort((a, b) => parseTimeToMinutes(getTripStartTime(b)) - parseTimeToMinutes(getTripStartTime(a)));
    
    allSevenDayShifts = history;
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
  const now = new Date();

  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    
    const dateStr = toDateStr(d);
    const dayName = d.toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland', weekday: 'long' });

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

  const dateFiltered = processShiftTrips(allSevenDayShifts, selectedDate);

  const filtered = dateFiltered.filter((shift) => {
    if (!query) return true;
    const startTime = getTripStartTime(shift);
    const route = String(shift.route_display || '').toLowerCase();
    const dest = String(shift.destination || '').toLowerCase();
    const time = format12HourTime(startTime).toLowerCase();
    const tardiness = String(shift.tardiness || '').toLowerCase();
    const tripTitle = formatTripTitle(shift.route_display, shift.origin, shift.destination).toLowerCase();

    return route.includes(query) || dest.includes(query) || time.includes(query) || tardiness.includes(query) || tripTitle.includes(query);
  });

  if (filtered.length === 0) {
    container.innerHTML = `<p style="color: #666; text-align: center; padding: 20px;">No shifts found for this date.</p>`;
    return;
  }

  container.innerHTML = filtered.map((shift) => {
    const startTime = getTripStartTime(shift);
    const vId = getTripVehicleId(shift);
    const tripTitle = formatTripTitle(shift.route_display, shift.origin, shift.destination);
    const isScheduled = !vId || String(vId).toUpperCase() === 'SCHEDULED';
    const tardinessDisplay = isScheduled ? 'Scheduled' : (shift.tardiness || 'On Time');
    const timeDisplay = format12HourTime(startTime);
    const commencedTag = getCommencedTag(startTime, selectedDate);

    return `
      <div class="departure-row" style="background: #fff; border: 1px solid #e1e4e8; border-radius: 8px; padding: 12px; margin-bottom: 8px;">
        <div class="departure-main-info" style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px;">
          <span>Start: <strong>${escapeHtml(timeDisplay)}</strong>${commencedTag}</span>
          <span><strong>${escapeHtml(tardinessDisplay)}</strong></span>
        </div>
        <div style="font-size: 13px; font-weight: 600; color: #222;">
          ${escapeHtml(tripTitle)}
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
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    
    let days = await res.json();
    if (!Array.isArray(days)) days = [];

    const now = new Date();
    const todayStr = toDateStr(now);

    days = days.filter(d => d <= todayStr);

    if (!days.includes(todayStr)) {
      days.unshift(todayStr);
    }

    if (dateSelect) {
      dateSelect.innerHTML = days.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
      dateSelect.value = todayStr;
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
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { timeZone: 'Pacific/Auckland', weekday: 'long' });
  } catch (e) {
    return '';
  }
}

async function loadRouteHistoryForSelectedDate() {
  const dateSelect = document.getElementById('route-date-select');
  const now = new Date();
  const defaultToday = toDateStr(now);
  const selectedDate = dateSelect ? dateSelect.value : defaultToday;
  
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
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    
    let shifts = await res.json();
    if (!Array.isArray(shifts)) shifts = [];

    activeRouteShifts = shifts;

    if (!activeRouteShifts || activeRouteShifts.length === 0) {
      departuresList.innerHTML = `<p style="color: #666; text-align: center; padding: 20px;">No recorded history for ${escapeHtml(activeRouteDisplay)} on ${escapeHtml(selectedDate)}.</p>`;
      return;
    }

    activeRouteShifts.sort((a, b) => {
      let aMins = parseTimeToMinutes(getTripStartTime(a));
      let bMins = parseTimeToMinutes(getTripStartTime(b));
      return bMins - aMins;
    });

    renderFilteredRouteDepartures();
  } catch (err) {
    console.error('Error loading route history:', err);
    departuresList.innerHTML = `<p style="color: #d9381e; text-align: center; padding: 20px;">Failed to load route departures.</p>`;
  }
}

/**
 * Generates "(commenced on DD/MM/YYYY)" tag for early morning runs.
 */
function getCommencedTag(startTimeStr, selectedDateStr) {
  if (!isEarlyMorningTrip(startTimeStr) || !selectedDateStr) return '';

  const [y, m, d] = selectedDateStr.split('-').map(Number);
  if (!y || !m || !d) return '';

  const actualDate = new Date(y, m - 1, d);
  if (isNaN(actualDate.getTime())) return '';

  const day = String(actualDate.getDate()).padStart(2, '0');
  const month = String(actualDate.getMonth() + 1).padStart(2, '0');
  const year = actualDate.getFullYear();

  return ` <span style="font-size: 11px; color: #555; font-weight: 500;">(commenced on ${day}/${month}/${year})</span>`;
}

function renderFilteredRouteDepartures() {
  const departuresList = document.getElementById('route-departures-list');
  if (!departuresList) return;

  const dateSelect = document.getElementById('route-date-select');
  const now = new Date();
  const todayStr = toDateStr(now);
  const selectedDate = dateSelect ? dateSelect.value : todayStr;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const searchInput = document.getElementById('route-departure-search');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

  const filtered = activeRouteShifts.filter((shift) => {
    const startTime = getTripStartTime(shift);
    const vId = getTripVehicleId(shift);
    
    if (!startTime && !vId) return false;

    const shiftMinutes = parseTimeToMinutes(startTime);

    if (selectedDate === todayStr && shiftMinutes > currentMinutes) {
      return false;
    }

    if (!query) return true;
    const formattedStartTime = format12HourTime(startTime).toLowerCase();
    const fleet = formatFleetLabel(vId).toLowerCase();
    const route = String(shift.route_display || '').toLowerCase();
    const dest = formatCleanDestination(shift.destination).toLowerCase();

    return formattedStartTime.includes(query) || 
           fleet.includes(query) || 
           route.includes(query) || 
           dest.includes(query);
  });

  if (filtered.length === 0) {
    departuresList.innerHTML = `<p style="color: #666; text-align: center; padding: 20px;">No matching departures found.</p>`;
    return;
  }

  departuresList.innerHTML = filtered.map((shift) => {
    const startTime = getTripStartTime(shift);
    const vId = getTripVehicleId(shift);
    const tripTitle = formatTripTitle(shift.route_display, shift.origin, shift.destination);
    const formattedStartTime = format12HourTime(startTime);
    const shiftMinutes = parseTimeToMinutes(startTime);
    let commencedTag = getCommencedTag(startTime, selectedDate);
    
    const targetVId = targetTripContext ? getTripVehicleId(targetTripContext) : '';
    const targetStartTime = targetTripContext ? getTripStartTime(targetTripContext) : '';

    const isTarget = targetTripContext && 
                     String(vId) === String(targetVId) && 
                     String(startTime) === String(targetStartTime);

    const isScheduled = !vId || String(vId).toUpperCase() === 'SCHEDULED';
    const fleetDisplay = isScheduled 
      ? `<span style="color: #888; font-style: italic;">Scheduled</span>` 
      : `<strong>${escapeHtml(formatFleetLabel(vId))}</strong>`;

    let tardinessDisplay = shift.tardiness || 'Scheduled';
    if (isScheduled || selectedDate > todayStr || (selectedDate === todayStr && shiftMinutes > currentMinutes)) {
      tardinessDisplay = 'Scheduled';
    }

    if (shiftMinutes === 0) {
      const actualDate = new Date(selectedDate + 'T00:00:00');
      actualDate.setDate(actualDate.getDate() + 1);

      const dd = String(actualDate.getDate()).padStart(2, '0');
      const mm = String(actualDate.getMonth() + 1).padStart(2, '0');
      const yyyy = actualDate.getFullYear();

      commencedTag = ` <span style="color: #666; font-weight: normal; font-size: 12px;">(commenced on ${dd}/${mm}/${yyyy})</span>`;
    }

    const isOverdue = isScheduled && (selectedDate === todayStr) && (shiftMinutes < currentMinutes);

    return `
      <div class="departure-row ${isTarget ? 'highlighted-target-trip' : ''}">
        ${isTarget ? '<span class="target-badge">Selected Route Trip</span>' : ''}
        <div class="departure-main-info">
          <span>Start: <strong>${escapeHtml(formattedStartTime)}</strong>${commencedTag} | Fleet: ${fleetDisplay}</span>
          <span><strong>${escapeHtml(tardinessDisplay)}</strong></span>
        </div>
        ${isOverdue ? `
          <div style="background-color: #fee2e2; border: 1px solid #ef4444; color: #991b1b; padding: 6px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; margin-top: 6px; display: flex; align-items: center; gap: 6px;">
            <span>⚠️</span>
            <span>No Tracking Available. This bus is either delayed or cancelled</span>
          </div>
        ` : ''}
        <div style="font-size: 13px; font-weight: 600; color: #222;">${escapeHtml(tripTitle)}</div>
        ${isScheduled ? '' : `
          <button class="btn-shift-check" 
                  data-vehicle-id="${escapeHtml(vId)}" 
                  data-start-time="${escapeHtml(startTime)}" 
                  data-route="${escapeHtml(shift.route_display || '')}" 
                  onclick="handleShiftCheckClick(this)">Check Shift</button>
        `}
        <div class="shift-details-box"></div>
      </div>
    `;
  }).join('');
}

async function handleShiftCheckClick(btnEl) {
  const vehicleId = btnEl.getAttribute('data-vehicle-id');
  const targetStartTime = btnEl.getAttribute('data-start-time');
  const targetRouteDisplay = btnEl.getAttribute('data-route');

  const row = btnEl.closest('.departure-row');
  if (!row) return;

  const detailsBox = row.querySelector('.shift-details-box');
  if (!detailsBox) return;

  if (detailsBox.style.display === 'block') {
    detailsBox.style.display = 'none';
    return;
  }

  const dateSelect = document.getElementById('route-date-select');
  const targetDate = dateSelect ? dateSelect.value : '';

  try {
    const res = await fetch(`/api/history/bus/${encodeURIComponent(vehicleId)}`);
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    
    let history = await res.json();
    if (!Array.isArray(history)) history = [];

    if (history.length === 0) {
      detailsBox.innerHTML = '<p style="margin: 0; color: #666;">No recent shift details found for this vehicle.</p>';
      detailsBox.style.display = 'block';
      return;
    }

    const filteredHistory = processShiftTrips(history, targetDate);

    filteredHistory.sort((a, b) => {
      let aM = parseTimeToMinutes(getTripStartTime(a));
      let bM = parseTimeToMinutes(getTripStartTime(b));
      return bM - aM;
    });

    const historyToUse = filteredHistory.length > 0 ? filteredHistory : history;

    row._vehicleHistory = historyToUse;
    row._targetStartTime = targetStartTime;
    row._targetRouteDisplay = targetRouteDisplay;

    detailsBox.innerHTML = `
      <div style="font-weight: 700; margin-bottom: 6px; color: #111;">Shift Details (${escapeHtml(targetDate)}):</div>
      <input type="text" placeholder="Filter shift trips..." 
        style="width: 100%; padding: 6px 10px; margin-bottom: 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; box-sizing: border-box;"
        oninput="filterShiftDetails(this)" />
      <ul class="shift-details-list" style="margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px;">
        ${renderShiftListItems(historyToUse, targetStartTime, targetRouteDisplay, targetDate)}
      </ul>
    `;
    detailsBox.style.display = 'block';

    detailsBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    detailsBox.innerHTML = '<p style="margin: 0; color: #d9381e;">Could not load shift details.</p>';
    detailsBox.style.display = 'block';
    detailsBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function renderShiftListItems(history, targetStartTime, targetRouteDisplay, targetDate) {
  const targetMins = parseTimeToMinutes(targetStartTime);

  return history.map(h => {
    const hStartTime = getTripStartTime(h);
    const hMins = parseTimeToMinutes(hStartTime);

    const isThisRun = (hMins === targetMins && String(h.route_display || '').trim().toUpperCase() === String(targetRouteDisplay || '').trim().toUpperCase());
    const formattedTime = format12HourTime(hStartTime);
    const commencedTag = getCommencedTag(hStartTime, targetDate);

    let destText = formatCleanDestination(h.destination);
    let destDisplay = destText ? ` to <strong>${escapeHtml(destText)}</strong>` : '';

    return `
      <li style="${isThisRun ? 'color: #d9381e; font-weight: 600;' : ''}">
        ${escapeHtml(formattedTime)} - ${escapeHtml(h.route_display || '')}${destDisplay} (${escapeHtml(h.tardiness || 'On Time')})${commencedTag}
        ${isThisRun ? ' <span style="color: #d9381e; font-weight: 700; margin-left: 6px;">(this run)</span>' : ''}
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

  const dateSelect = document.getElementById('route-date-select');
  const targetDate = dateSelect ? dateSelect.value : '';

  const filtered = row._vehicleHistory.filter(h => {
    if (!query) return true;
    const startTime = getTripStartTime(h);
    const timeFormatted = format12HourTime(startTime).toLowerCase();
    const route = String(h.route_display || '').toLowerCase();
    const dest = formatCleanDestination(h.destination).toLowerCase();
    const tardiness = String(h.tardiness || '').toLowerCase();

    return timeFormatted.includes(query) ||
           route.includes(query) ||
           dest.includes(query) ||
           tardiness.includes(query);
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `<li style="list-style: none; color: #666; font-style: italic;">No matching trips found.</li>`;
    return;
  }

  listEl.innerHTML = renderShiftListItems(filtered, row._targetStartTime, row._targetRouteDisplay, targetDate);
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