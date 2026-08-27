const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { parse } = require('csv-parse/sync');
const sqlite3 = require('sqlite3').verbose();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AT_API_KEY = process.env.AT_API_KEY || '488b10f0562c40b593cbd739d7659fd8';

const dbPath = path.join(__dirname, 'bus_history.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS shift_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id TEXT,
      trip_id TEXT UNIQUE,
      route_display TEXT,
      destination TEXT,
      day TEXT,
      start_time TEXT,
      tardiness TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

function purgeOldHistory() {
  db.run(`DELETE FROM shift_history WHERE created_at < datetime('now', '-7 days')`, (err) => {
    if (err) console.error('[DB] Error purging old history:', err.message);
    else console.log('[DB] Auto-purged records older than 7 days.');
  });
}
purgeOldHistory();
setInterval(purgeOldHistory, 1000 * 60 * 60 * 6);

let tripDestinationMap = {};
let routeIdToShortNameMap = {};
let delaysByTrip = {};

function cleanHeadsign(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  return s.replace(/^route\s*\w+\s*:?\s*/i, '').trim();
}

function parseRouteDisplay(routeId) {
  if (!routeId) return 'NIS';
  const clean = String(routeId).split('-')[0].replace(/^0+/, '');
  return clean || 'NIS';
}

function extractBaseTripId(rawTripId) {
  if (!rawTripId) return '';
  return String(rawTripId).trim().split('-')[0];
}

async function loadOrFetchGtfsData() {
  const dirPath = path.join(__dirname, 'gtfs-static');
  const zipPath = path.join(dirPath, 'gtfs.zip');

  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

  if (fs.existsSync(zipPath)) {
    const stats = fs.statSync(zipPath);
    if (stats.size < 50000) fs.unlinkSync(zipPath);
  }

  if (!fs.existsSync(zipPath)) {
    try {
      const res = await fetch('https://gtfs.at.govt.nz/gtfs.zip');
      if (res.ok) {
        const buffer = await res.arrayBuffer();
        fs.writeFileSync(zipPath, Buffer.from(buffer));
      }
    } catch (e) {
      console.error('[GTFS] Download failed:', e.message);
    }
  }

  if (fs.existsSync(zipPath)) {
    try {
      const zip = new AdmZip(zipPath);
      const stopNames = {};
      const stopsEntry = zip.getEntry('stops.txt');
      if (stopsEntry) {
        const stopRows = parse(stopsEntry.getData().toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
        stopRows.forEach((s) => { if (s.stop_id && s.stop_name) stopNames[s.stop_id.trim()] = s.stop_name.trim(); });
      }

      const routesEntry = zip.getEntry('routes.txt');
      if (routesEntry) {
        const routeRows = parse(routesEntry.getData().toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
        routeRows.forEach((r) => {
          if (r.route_id && r.route_short_name) {
            routeIdToShortNameMap[r.route_id.trim()] = r.route_short_name.trim();
            routeIdToShortNameMap[r.route_id.trim().split('-')[0]] = r.route_short_name.trim();
          }
        });
      }

      const tripLastStopMap = {};
      const stopTimesEntry = zip.getEntry('stop_times.txt');
      if (stopTimesEntry) {
        const stopTimeRows = parse(stopTimesEntry.getData().toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
        const tripMaxSeq = {};
        stopTimeRows.forEach((st) => {
          const tId = st.trip_id?.trim();
          const seq = parseInt(st.stop_sequence, 10);
          const sId = st.stop_id?.trim();
          if (tId && !isNaN(seq) && sId && stopNames[sId]) {
            if (!tripMaxSeq[tId] || seq > tripMaxSeq[tId].seq) tripMaxSeq[tId] = { seq, stopName: stopNames[sId] };
          }
        });
        for (const tId in tripMaxSeq) {
          const destName = cleanHeadsign(tripMaxSeq[tId].stopName);
          tripLastStopMap[tId] = destName;
          tripLastStopMap[extractBaseTripId(tId)] = destName;
        }
      }

      const tripsEntry = zip.getEntry('trips.txt');
      if (tripsEntry) {
        const tripRows = parse(tripsEntry.getData().toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
        tripRows.forEach((t) => {
          const tId = t.trip_id?.trim();
          if (!tId) return;
          const baseId = extractBaseTripId(tId);
          let headsign = cleanHeadsign(t.trip_headsign) || tripLastStopMap[tId] || tripLastStopMap[baseId] || '';
          if (headsign) {
            tripDestinationMap[tId] = headsign;
            tripDestinationMap[baseId] = headsign;
          }
        });
      }
    } catch (e) {
      console.error('[GTFS Static] Error:', e.message);
    }
  }
}

loadOrFetchGtfsData();

async function updateTripUpdates() {
  try {
    const res = await fetch('https://api.at.govt.nz/realtime/legacy/tripupdates', {
      headers: { 'Ocp-Apim-Subscription-Key': AT_API_KEY }
    });
    if (!res.ok) return;

    const json = await res.json();
    const entities = json.response?.entity || json.entity || [];
    const next = {};

    entities.forEach((entity) => {
      const tu = entity.trip_update;
      const tripId = tu?.trip?.trip_id;
      if (!tripId) return;

      let tripDelay = tu.delay;
      let stopTimeUpdates = tu.stop_time_update;
      if (!Array.isArray(stopTimeUpdates) && stopTimeUpdates) stopTimeUpdates = [stopTimeUpdates];

      if (tripDelay === undefined && stopTimeUpdates && stopTimeUpdates.length > 0) {
        for (const stu of stopTimeUpdates) {
          const d = stu.arrival?.delay ?? stu.departure?.delay;
          if (d !== undefined && d !== null) { tripDelay = d; break; }
        }
      }
      if (tripDelay !== undefined && tripDelay !== null) next[tripId] = tripDelay;
    });
    delaysByTrip = next;
  } catch (e) {}
}

updateTripUpdates();
setInterval(updateTripUpdates, 20000);

function extractFleetNumber(vehicleEntity) {
  if (!vehicleEntity) return 'Unknown';
  let raw = String(vehicleEntity.label || vehicleEntity.id || '').trim();
  // Strips redundant leading 'RT' only if stacked in front of another 2-letter company code (e.g. RTNB4285 -> NB4285)
  let clean = raw.replace(/^RT(?=[A-Z]{2}\d)/i, '');
  return clean || raw || 'Unknown';
}

function formatOccupancy(status) {
  const map = { 0: 'Empty', 1: 'Many Seats Available', 2: 'Few Seats Available', 3: 'Standing Room Only', 4: 'Crushed Standing Room', 5: 'Bus Full', 6: 'Not Accepting Passengers' };
  return map[status] || 'Seats Available';
}

function formatTardiness(delaySeconds) {
  if (delaySeconds === null || delaySeconds === undefined || isNaN(delaySeconds)) return 'Scheduled';
  const mins = Math.round(delaySeconds / 60);
  if (mins > 0) return `+${mins} min late`;
  if (mins < 0) return `${Math.abs(mins)} min early`;
  return 'On Time';
}

function formatTripTime(timeStr) {
  if (!timeStr) return '';
  const parts = String(timeStr).split(':');
  if (parts.length >= 2) {
    let hour = parseInt(parts[0], 10);
    const min = parts[1].padStart(2, '0');
    const ampm = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
    return `${hour}:${min} ${ampm}`;
  }
  return String(timeStr);
}

function getActualTripStartTime(v, timestampSec) {
  if (v?.trip?.start_time) return formatTripTime(v.trip.start_time);
  const tripId = String(v?.trip?.trip_id || '');
  const match = tripId.match(/-(\d{2})(\d{2})(\d{2})$/);
  if (match) return formatTripTime(`${match[1]}:${match[2]}:${match[3]}`);
  if (timestampSec) {
    const d = new Date(timestampSec * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

app.get('/api/buses/live', async (req, res) => {
  try {
    const url = `https://api.at.govt.nz/realtime/legacy/vehiclelocations?subscription-key=${AT_API_KEY}`;
    const response = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': AT_API_KEY, 'Accept': 'application/json' } });

    if (!response.ok) return res.status(response.status).json({ error: `AT API HTTP ${response.status}` });

    const data = await response.json();
    const entities = data.response?.entity || data.entity || [];
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    const liveBuses = entities.map((e) => {
      const v = e.vehicle;
      if (!v || !v.position || !v.position.latitude || !v.position.longitude) return null;

      const vehicleId = extractFleetNumber(v.vehicle);
      const routeRaw = v.trip?.route_id || v.trip?.routeId || '';
      const routeDisplay = routeIdToShortNameMap[routeRaw] || routeIdToShortNameMap[String(routeRaw).split('-')[0]] || parseRouteDisplay(routeRaw);

      const startTimeFormatted = getActualTripStartTime(v, v.timestamp || e.timestamp);
      const tripId = v.trip?.trip_id || `trip_${vehicleId}_${routeDisplay}`;
      const baseTripId = extractBaseTripId(tripId);

      let finalDest = tripDestinationMap[tripId] || tripDestinationMap[baseTripId] || cleanHeadsign(v.trip?.trip_headsign) || (routeDisplay === 'NIS' ? 'Not In Service' : `Route ${routeDisplay}`);

      const delaySec = v.trip?.delay ?? v.delay ?? delaysByTrip[tripId];
      const finalStatus = formatTardiness(delaySec);

      if (routeDisplay !== 'NIS') {
        db.run(
          `INSERT INTO shift_history (vehicle_id, trip_id, route_display, destination, day, start_time, tardiness)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(trip_id) DO UPDATE SET tardiness = excluded.tardiness, destination = excluded.destination`,
          [vehicleId, tripId, routeDisplay, finalDest, todayStr, startTimeFormatted, finalStatus]
        );
      }

      return {
        vehicle_id: vehicleId,
        trip_id: tripId,
        route_display: routeDisplay,
        start_time: startTimeFormatted,
        destination: finalDest,
        latitude: parseFloat(v.position.latitude),
        longitude: parseFloat(v.position.longitude),
        stop_id: v.stop_id ? `Stop #${v.stop_id}` : 'In Transit',
        tardiness: finalStatus,
        occupancy: formatOccupancy(v.occupancy_status)
      };
    });

    res.json(liveBuses.filter(Boolean));
  } catch (err) {
    res.status(500).json({ error: 'Server Catch Error', details: err.message });
  }
});

app.get('/api/history/bus/:vehicleId', (req, res) => {
  const vId = req.params.vehicleId;
  db.all(
    `SELECT route_display, destination, day, start_time, tardiness FROM shift_history WHERE vehicle_id = ? ORDER BY id DESC LIMIT 50`,
    [vId],
    (err, rows) => {
      if (err) return res.status(500).json([]);
      res.json(rows || []);
    }
  );
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`AT Bus Tracker listening on port ${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is in use, auto-switching to 3001...`);
    app.listen(3001, () => console.log(`AT Bus Tracker listening on port 3001`));
  } else {
    console.error(err);
  }
});