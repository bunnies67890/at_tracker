let allBusesData = [];
const busMarkers = {};

const map = L.map('map').setView([-36.8485, 174.7633], 12);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

function formatFleetLabel(vehicleId) {
  if (!vehicleId) return 'Unknown';
  return String(vehicleId).trim();
}

function formatTripTitle(routeDisplay, destination) {
  if (!routeDisplay || routeDisplay === 'NIS') return 'Not In Service';

  let cleanDest = String(destination || '').trim();
  cleanDest = cleanDest.replace(/^route\s*\w+\s*:?\s*/i, '').trim();
  cleanDest = cleanDest.replace(/^to\s+/i, '').trim();

  if (!cleanDest) return `Route ${routeDisplay}`;
  return `Route ${routeDisplay} to ${cleanDest}`;
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
    const tripTitle = formatTripTitle(bus.route_display, bus.destination);
    const routeDisplay = bus.route_display || 'NIS';

    const popupContent = `
      <div class="popup-container">
        <h3>Fleet: ${fleetLabel}</h3>
        <p><strong>Trip:</strong> ${tripTitle}</p>
        <p><strong>Departure Time:</strong> ${bus.start_time || 'N/A'}</p>
        <p><strong>Status:</strong> ${bus.stop_id}</p>
        <p><strong>Tardiness:</strong> ${bus.tardiness}</p>
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

function handleSearch() {
  const query = (document.getElementById('bus-search')?.value || '').toLowerCase().trim();
  const dropdown = document.getElementById('search-results');

  if (!query) {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    return;
  }

  const matches = allBusesData.filter((bus) => {
    const fleetLabel = formatFleetLabel(bus.vehicle_id).toLowerCase();
    const rawId = String(bus.vehicle_id).toLowerCase();
    const route = String(bus.route_display || '').toLowerCase();
    const dest = String(bus.destination || '').toLowerCase();

    return fleetLabel.includes(query) || rawId.includes(query) || route.includes(query) || dest.includes(query);
  }).slice(0, 15);

  if (matches.length === 0) {
    dropdown.innerHTML = '<div class="search-result-item" style="color: #777;">No matching buses found</div>';
    dropdown.style.display = 'block';
    return;
  }

  dropdown.innerHTML = matches.map((bus) => {
    const fleetLabel = formatFleetLabel(bus.vehicle_id);
    const tripTitle = formatTripTitle(bus.route_display, bus.destination);
    const badgeText = bus.route_display || 'NIS';

    return `
      <div class="search-result-item" onclick="selectBusFromSearch('${bus.vehicle_id}')">
        <div>
          <div class="result-fleet">${fleetLabel}</div>
          <div class="result-trip">${tripTitle}</div>
        </div>
        <div class="result-badge">${badgeText}</div>
      </div>
    `;
  }).join('');

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
    const history = await res.json();

    const modalTitle = document.getElementById('modal-title');
    const modalBody = document.getElementById('modal-body');
    const modalContainer = document.getElementById('modal-container');

    if (modalTitle) modalTitle.innerText = `Fleet ${fleetLabel} — 7-Day Shift History`;

    if (modalBody) {
      if (!history || history.length === 0) {
        modalBody.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">No recorded shift history available for this vehicle in the last 7 days.</p>';
      } else {
        modalBody.innerHTML = `
          <div class="shift-timeline">
            ${history.map((shift) => {
              return `
                <div class="shift-card">
                  <div class="shift-card-top">
                    <span class="shift-date-badge">${shift.day}</span>
                    <span class="shift-time">Start: <strong>${shift.start_time}</strong></span>
                  </div>
                  <div class="shift-title">${shift.route_display !== 'NIS' ? `Route ${shift.route_display}` : 'NIS'} — ${shift.destination}</div>
                  <div class="shift-status-pill">Status: <strong>${shift.tardiness}</strong></div>
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

function closeModal() {
  const modalContainer = document.getElementById('modal-container');
  if (modalContainer) modalContainer.style.display = 'none';
}

window.addEventListener('click', (event) => {
  const modalContainer = document.getElementById('modal-container');
  const searchWrapper = document.querySelector('.search-wrapper');

  if (event.target === modalContainer) closeModal();
  if (searchWrapper && !searchWrapper.contains(event.target)) {
    const dropdown = document.getElementById('search-results');
    if (dropdown) dropdown.style.display = 'none';
  }
});

fetchAndRenderBuses();
setInterval(fetchAndRenderBuses, 15000);