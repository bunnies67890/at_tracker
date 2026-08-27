require('dotenv').config();

const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { parse } = require('csv-parse/sync');
const sqlite3 = require('sqlite3').verbose();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AT_API_KEY = process.env.AT_API_KEY;
console.log('DEBUG CHECK:', AT_API_KEY ? `Key exists (${AT_API_KEY.length} chars)` : 'KEY IS BLANK OR UNDEFINED');

const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'bus_history.db') 
  : path.join(__dirname, 'bus_history.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Database connection error:', err.message);
});

// Optimized with WAL mode and NORMAL sync for Railway network volumes
db.serialize(() => {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");

  db.run(`
    CREATE TABLE IF NOT EXISTS shift_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id TEXT,
      trip_id TEXT UNIQUE,
      route_display TEXT,
      origin TEXT,
      destination TEXT,
      day TEXT,
      start_time TEXT,
      tardiness TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, () => {
    db.run(`ALTER TABLE shift_history ADD COLUMN origin TEXT`, (err) => {});
  });
});

function purgeOldHistory() {
  db.run(`DELETE FROM shift_history WHERE day < date('now', '-7 days')`, (err) => {
    if (err) console.error('[DB] Error purging old history:', err.message);
  });
}
purgeOldHistory();
setInterval(purgeOldHistory, 1000 * 60 * 60 * 6);

let tripOriginMap = {};
let tripDestinationMap = {};
let routeIdToShortNameMap = {};
let delaysByTrip = {};

let tripToBlockMap = {};
let blockToTripsMap = {};
let tripStartTimeMap = {};
let tripServiceMap = {};
let calendarServices = {}; 
let calendarExceptions = {}; 

let allStops = [];
let stopNamesMap = {};
let stopDeparturesMap = {};

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

function timeStrToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':');
  if (parts.length < 2) return 0;
  return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2] || 0, 10);
}

function isServiceActiveOnDate(serviceId, dateStr) {
  const cleanDate = dateStr.replace(/-/g, '');
  const d = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = d.getDay(); 
  const dayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayKey = dayKeys[dayOfWeek];

  if (calendarExceptions[serviceId] && calendarExceptions[serviceId][cleanDate] !== undefined) {
    return calendarExceptions[serviceId][cleanDate] === 1; 
  }

  const cal = calendarServices[serviceId];
  if (!cal) return false;

  if (cleanDate < cal.start_date || cleanDate > cal.end_date) return false;
  return cal[dayKey] === '1';
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
      allStops = [];
      stopNamesMap = {};

      const stopsEntry = zip.getEntry('stops.txt');
      if (stopsEntry) {
        const stopRows = parse(stopsEntry.getData().toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
        stopRows.forEach((s) => {
          if (s.stop_id && s.stop_name) {
            const sId = s.stop_id.trim();
            const sName = s.stop_name.trim();
            stopNamesMap[sId] = sName;
            allStops.push({
              stop_id: sId,
              stop_name: sName,
              lat: parseFloat(s.stop_lat),
              lon: parseFloat(s.stop_lon)
            });
          }
        });
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

      const calEntry = zip.getEntry('calendar.txt');
      if (calEntry) {
        const calRows = parse(calEntry.getData().toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
        calRows.forEach(c => {
          if (c.service_id) {
            calendarServices[c.service_id.trim()] = {
              monday: c.monday, tuesday: c.tuesday, wednesday: c.wednesday,
              thursday: c.thursday, friday: c.friday, saturday: c.saturday, sunday: c.sunday,
              start_date: c.start_date.trim(), end_date: c.end_date.trim()
            };
          }
        });
      }

      const calExEntry = zip.getEntry('calendar_dates.txt');
      if (calExEntry) {
        const exRows = parse(calExEntry.getData().toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
        exRows.forEach(ex => {
          const sId = ex.service_id?.trim();
          const dt = ex.date?.trim();
          const type = parseInt(ex.exception_type, 10);
          if (sId && dt) {
            if (!calendarExceptions[sId]) calendarExceptions[sId] = {};
            calendarExceptions[sId][dt] = type;
          }
        });
      }

      const stopTimesEntry = zip.getEntry('stop_times.txt');
      const tripMinSeqTime = {};
      const tripMinStopName = {};
      const tripMaxStopName = {};
      
      const tripsEntry = zip.getEntry('trips.txt');
      const tripMetaMap = {};
      if (tripsEntry) {
        const tripRows = parse(tripsEntry.getData().toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
        tripRows.forEach((t) => {
          const tId = t.trip_id?.trim();
          if (!tId) return;
          const baseId = extractBaseTripId(tId);
          const serviceId = t.service_id?.trim();
          const blockId = t.block_id?.trim();
          const routeId = t.route_id?.trim();
          const routeDisplay = routeIdToShortNameMap[routeId] || routeIdToShortNameMap[routeId?.split('-')[0]] || parseRouteDisplay(routeId);

          if (serviceId) {
            tripServiceMap[tId] = serviceId;
            tripServiceMap[baseId] = serviceId;
          }

          if (blockId) {
            tripToBlockMap[tId] = blockId;
            tripToBlockMap[baseId] = blockId;

            if (!blockToTripsMap[blockId]) blockToTripsMap[blockId] = [];
            blockToTripsMap[blockId].push({
              trip_id: tId,
              route_id: routeId,
              service_id: serviceId,
              headsign: cleanHeadsign(t.trip_headsign)
            });
          }

          let headsign = cleanHeadsign(t.trip_headsign);
          if (headsign) {
            tripDestinationMap[tId] = headsign;
            tripDestinationMap[baseId] = headsign;
          }

          tripMetaMap[tId] = { route: routeDisplay, destination: headsign, service_id: serviceId };
          tripMetaMap[baseId] = tripMetaMap[tId];
        });
      }

      if (stopTimesEntry) {
        const stopTimeRows = parse(stopTimesEntry.getData().toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
        stopTimeRows.forEach((st) => {
          const tId = st.trip_id?.trim();
          const seq = parseInt(st.stop_sequence, 10);
          const depTime = st.departure_time?.trim();
          const sId = st.stop_id?.trim();

          if (tId && !isNaN(seq)) {
            if (depTime && (!tripMinSeqTime[tId] || seq < tripMinSeqTime[tId].seq)) {
              tripMinSeqTime[tId] = { seq, time: depTime };
            }
            if (sId && stopNamesMap[sId]) {
              if (!tripMinStopName[tId] || seq < tripMinStopName[tId].seq) {
                tripMinStopName[tId] = { seq, name: stopNamesMap[sId] };
              }
              if (!tripMaxStopName[tId] || seq > tripMaxStopName[tId].seq) {
                tripMaxStopName[tId] = { seq, name: stopNamesMap[sId] };
              }
            }
          }

          if (tId && sId && depTime) {
            const meta = tripMetaMap[tId] || tripMetaMap[extractBaseTripId(tId)] || { route: 'N/A', destination: 'N/A' };
            const originName = tripMinStopName[tId]?.name || '';
            const destName = meta.destination || tripMaxStopName[tId]?.name || 'N/A';

            if (!stopDeparturesMap[sId]) stopDeparturesMap[sId] = [];
            stopDeparturesMap[sId].push({
              trip_id: tId,
              route: meta.route,
              origin: originName,
              destination: destName,
              timeStr: depTime
            });
          }
        });
      }

      for (const tId in tripMinSeqTime) {
        const formatted = formatTripTime(tripMinSeqTime[tId].time);
        tripStartTimeMap[tId] = formatted;
        tripStartTimeMap[extractBaseTripId(tId)] = formatted;
      }

      for (const tId in tripMinStopName) {
        const origName = cleanHeadsign(tripMinStopName[tId].name);
        if (origName) {
          tripOriginMap[tId] = origName;
          tripOriginMap[extractBaseTripId(tId)] = origName;
        }
      }

      for (const tId in tripMaxStopName) {
        const destName = cleanHeadsign(tripMaxStopName[tId].name);
        if (destName && !tripDestinationMap[tId]) {
          tripDestinationMap[tId] = destName;
          tripDestinationMap[extractBaseTripId(tId)] = destName;
        }
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
  return raw.toUpperCase() || 'Unknown';
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

function getActualTripStartTime(v, timestampSec) {
  if (v?.trip?.start_time) return formatTripTime(v.trip.start_time);
  const tripId = String(v?.trip?.trip_id || '');
  if (tripStartTimeMap[tripId]) return tripStartTimeMap[tripId];
  const baseId = extractBaseTripId(tripId);
  if (tripStartTimeMap[baseId]) return tripStartTimeMap[baseId];

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

      let finalOrigin = tripOriginMap[tripId] || tripOriginMap[baseTripId] || '';
      let finalDest = tripDestinationMap[tripId] || tripDestinationMap[baseTripId] || cleanHeadsign(v.trip?.trip_headsign) || (routeDisplay === 'NIS' ? 'Not In Service' : `Route ${routeDisplay}`);

      const delaySec = v.trip?.delay ?? v.delay ?? delaysByTrip[tripId];
      const finalStatus = formatTardiness(delaySec);

      return {
        vehicle_id: vehicleId,
        trip_id: tripId,
        route_display: routeDisplay,
        start_time: startTimeFormatted,
        origin: finalOrigin,
        destination: finalDest,
        latitude: parseFloat(v.position.latitude),
        longitude: parseFloat(v.position.longitude),
        tardiness: finalStatus,
        occupancy: formatOccupancy(v.occupancy_status)
      };
    }).filter(Boolean);

    // Optimized bulk database transaction to prevent network volume lag
    db.serialize(() => {
      db.run("BEGIN TRANSACTION;");
      const stmt = db.prepare(`
        INSERT INTO shift_history (vehicle_id, trip_id, route_display, origin, destination, day, start_time, tardiness)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(trip_id) DO UPDATE SET tardiness = excluded.tardiness, origin = excluded.origin, destination = excluded.destination
      `);

      liveBuses.forEach((b) => {
        if (b.route_display !== 'NIS') {
          stmt.run([b.vehicle_id, b.trip_id, b.route_display, b.origin, b.destination, todayStr, b.start_time, b.tardiness]);
        }
      });

      stmt.finalize();
      db.run("COMMIT;");
    });

    res.json(liveBuses);
  } catch (err) {
    res.status(500).json({ error: 'Server Catch Error', details: err.message });
  }
});

app.get('/api/stops', (req, res) => {
  res.json(allStops);
});

app.get('/api/stops/:id/departures', (req, res) => {
  const stopId = req.params.id.trim();
  const rawDeps = stopDeparturesMap[stopId] || [];

  const nowAkl = new Date(new Date().toLocaleString("en-US", { timeZone: "Pacific/Auckland" }));
  const currentSeconds = nowAkl.getHours() * 3600 + nowAkl.getMinutes() * 60 + nowAkl.getSeconds();
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date());

  const seenKeys = new Set();
  const upcoming = [];

  for (const d of rawDeps) {
    const serviceId = tripServiceMap[d.trip_id] || tripServiceMap[extractBaseTripId(d.trip_id)];
    if (serviceId && !isServiceActiveOnDate(serviceId, todayStr)) {
      continue;
    }

    const seconds = timeStrToSeconds(d.timeStr);
    if (seconds < currentSeconds) continue;

    const dedupKey = `${d.route}_${d.origin}_${d.destination}_${d.timeStr}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    upcoming.push({ ...d, seconds });
  }

  upcoming.sort((a, b) => a.seconds - b.seconds);

  const departures = upcoming.map(d => ({
    route: d.route,
    origin: d.origin,
    destination: d.destination,
    time: formatTripTime(d.timeStr),
    is_live: delaysByTrip[d.trip_id] !== undefined
  }));

  res.json(departures);
});

app.get('/api/history/bus/:vehicleId', (req, res) => {
  const vId = req.params.vehicleId.trim().toUpperCase();
  db.all(
    `SELECT route_display, origin, destination, day, start_time, tardiness FROM shift_history WHERE vehicle_id = ? ORDER BY id DESC LIMIT 50`,
    [vId],
    (err, rows) => {
      if (err) return res.status(500).json([]);
      res.json(rows || []);
    }
  );
});

app.get('/api/history/vehicle-day/:vehicleId', (req, res) => {
  const vehicleId = req.params.vehicleId.trim().toUpperCase();
  const day = req.query.day || new Date().toISOString().split('T')[0];

  db.all(
    `SELECT route_display, origin, destination, day, start_time, tardiness, trip_id 
     FROM shift_history 
     WHERE vehicle_id = ? AND day = ? 
     ORDER BY start_time ASC`,
    [vehicleId, day],
    (err, rows) => {
      if (err) rows = [];

      const seenTripIds = new Set(rows.map(r => r.trip_id));
      let blockIdsToFetch = new Set();

      rows.forEach(r => {
        if (r.trip_id) {
          const bId = tripToBlockMap[r.trip_id] || tripToBlockMap[extractBaseTripId(r.trip_id)];
          if (bId) blockIdsToFetch.add(bId);
        }
      });

      let blockExpandedRows = [...rows];

      blockIdsToFetch.forEach(bId => {
        const scheduledTrips = blockToTripsMap[bId] || [];
        scheduledTrips.forEach(st => {
          if (isServiceActiveOnDate(st.service_id, day)) {
            if (!seenTripIds.has(st.trip_id)) {
              seenTripIds.add(st.trip_id);
              const rDisp = routeIdToShortNameMap[st.route_id] || routeIdToShortNameMap[st.route_id?.split('-')[0]] || parseRouteDisplay(st.route_id);
              const startTime = tripStartTimeMap[st.trip_id] || tripStartTimeMap[extractBaseTripId(st.trip_id)] || 'Scheduled';
              const orig = tripOriginMap[st.trip_id] || tripOriginMap[extractBaseTripId(st.trip_id)] || '';
              const dest = st.headsign || tripDestinationMap[st.trip_id] || `Route ${rDisp}`;
              
              const delaySec = delaysByTrip[st.trip_id];
              const tardiness = formatTardiness(delaySec);

              blockExpandedRows.push({
                route_display: rDisp,
                origin: orig,
                destination: dest,
                day: day,
                start_time: startTime,
                tardiness: tardiness,
                trip_id: st.trip_id
              });
            }
          }
        });
      });

      const uniqueMap = new Map();
      blockExpandedRows.forEach(r => {
        const key = `${r.route_display}_${r.start_time}`;
        if (!uniqueMap.has(key)) {
          uniqueMap.set(key, r);
        } else {
          const existing = uniqueMap.get(key);
          if (r.tardiness !== 'Scheduled' && existing.tardiness === 'Scheduled') {
            uniqueMap.set(key, r);
          }
        }
      });

      let finalRows = Array.from(uniqueMap.values());
      finalRows.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));

      const cleaned = finalRows.map(r => ({
        route_display: r.route_display,
        origin: r.origin,
        destination: r.destination,
        day: r.day,
        start_time: r.start_time,
        tardiness: r.tardiness,
        trip_id: r.trip_id
      }));

      res.json(cleaned);
    }
  );
});

app.get('/api/history/route/:routeDisplay', (req, res) => {
  const routeDisplay = req.params.routeDisplay;
  const day = req.query.day || new Date().toISOString().split('T')[0];
  db.all(
    `SELECT vehicle_id, trip_id, route_display, origin, destination, day, start_time, tardiness, created_at 
     FROM shift_history 
     WHERE route_display = ? AND day = ? 
     ORDER BY start_time DESC`,
    [routeDisplay, day],
    (err, rows) => {
      if (err) return res.status(500).json([]);
      res.json(rows || []);
    }
  );
});

app.get('/api/history/route-days/:routeDisplay', (req, res) => {
  const routeDisplay = req.params.routeDisplay;
  db.all(
    `SELECT DISTINCT day FROM shift_history 
     WHERE route_display = ? AND day >= date('now', '-7 days') 
     ORDER BY day DESC`,
    [routeDisplay],
    (err, rows) => {
      if (err) return res.status(500).json([]);
      res.json(rows.map(r => r.day) || []);
    }
  );
});

app.get('/api/admin/refresh-gtfs', async (req, res) => {
  try {
    const dirPath = path.join(__dirname, 'gtfs-static');
    const zipPath = path.join(dirPath, 'gtfs.zip');

    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    await loadOrFetchGtfsData();

    res.json({ success: true, message: 'GTFS static data successfully refreshed!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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