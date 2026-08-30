const express = require('express');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database setup
const dbPath = path.join(__dirname, 'tracker.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS shift_history (
    vehicle_id TEXT,
    trip_id TEXT,
    route_display TEXT,
    origin TEXT,
    destination TEXT,
    day TEXT,
    start_time TEXT,
    tardiness TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (vehicle_id, day, start_time)
  )`);
});

// Global state maps
let calendarServices = {};
let calendarExceptions = {};
let tripServiceMap = {};
let stopDeparturesMap = {};
let routeScheduledTripsMap = {};
let tripIsOvernightMap = {};
let delaysByTrip = {};

// --- HELPER FUNCTIONS ---

function getNZDateStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getPreviousDateStr(dateStr) {
  const parts = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split('T')[0];
}

function timeStrToMinutes(timeStr) {
  if (!timeStr) return 0;
  let s = String(timeStr).trim();
  if (s.includes('T') || (s.includes(' ') && s.includes('-'))) {
    const parts = s.split(/[\sT]/);
    s = parts[parts.length - 1];
  }
  const match = s.match(/^(\d{1,3}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!match) return 0;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = match[3] ? match[3].toUpperCase() : null;
  if (ampm) {
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
  }
  if (hours < 5 && (!ampm || ampm === 'AM')) {
    hours += 24;
  }
  return hours * 60 + minutes;
}

function extractBaseTripId(tripId) {
  if (!tripId) return '';
  return tripId.split('_')[0];
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

function formatTripTime(timeStr) {
  if (!timeStr) return '';
  const parts = timeStr.split(':');
  if (parts.length < 2) return timeStr;
  let h = parseInt(parts[0], 10) % 24;
  return `${String(h).padStart(2, '0')}:${parts[1]}`;
}

function isServiceActiveOnDate(serviceId, dateStr) {
  if (!serviceId || !dateStr) return true;
  const cleanDate = dateStr.replace(/-/g, '');

  if (calendarExceptions[serviceId] && calendarExceptions[serviceId][cleanDate] !== undefined) {
    return calendarExceptions[serviceId][cleanDate] === 1;
  }

  const cal = calendarServices[serviceId];
  if (!cal) return true;

  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3) return true;

  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const dayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayKey = dayKeys[d.getUTCDay()];

  const inDateRange = cleanDate >= cal.start_date && cleanDate <= cal.end_date;
  const operatesOnDay = String(cal[dayKey]).trim() === '1';

  return inDateRange && operatesOnDay;
}

function getDiscordWebhookUrl() {
  return process.env.DISCORD_WEBHOOK_URL || '';
}

async function loadOrFetchGtfsData() {
  console.log('[GTFS] Loading static GTFS data...');
}

loadOrFetchGtfsData().catch(err => console.error('[GTFS Error]', err));


// --- API ENDPOINTS ---

app.get('/api/stops/:id/departures', (req, res) => {
  const stopId = req.params.id.trim();
  const rawDeps = stopDeparturesMap[stopId] || [];

  const nowAkl = new Date(new Date().toLocaleString("en-US", { timeZone: "Pacific/Auckland" }));
  const nowHour = nowAkl.getHours();
  const currentMinutes = (nowHour < 5 ? nowHour + 24 : nowHour) * 60 + nowAkl.getMinutes();
  const todayStr = getNZDateStr();

  const upcoming = [];

  for (const d of rawDeps) {
    const serviceId = tripServiceMap[d.trip_id] || tripServiceMap[extractBaseTripId(d.trip_id)];
    const tripMins = timeStrToMinutes(d.timeStr);

    if (serviceId && !isServiceActiveOnDate(serviceId, todayStr)) {
      continue;
    }

    if (tripMins < currentMinutes) continue;

    upcoming.push({ ...d, tripMins });
  }

  upcoming.sort((a, b) => a.tripMins - b.tripMins);

  const departures = upcoming.map(d => ({
    route: d.route,
    origin: d.origin,
    destination: d.destination,
    time: formatTripTime(d.timeStr),
    is_live: delaysByTrip[d.trip_id] !== undefined
  }));

  res.json(departures);
});

app.post('/api/buses/live', (req, res) => {
  const liveBuses = req.body.buses || [];
  const todayStr = getNZDateStr();
  const yesterdayStr = getPreviousDateStr(todayStr);
  const nowAklHour = new Date(new Date().toLocaleString("en-US", { timeZone: "Pacific/Auckland" })).getHours();

  const stmt = db.prepare(`INSERT OR REPLACE INTO shift_history 
    (vehicle_id, trip_id, route_display, origin, destination, day, start_time, tardiness) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  liveBuses.forEach((b) => {
    if (b.route_display && b.route_display !== 'NIS') {
      const startMins = timeStrToMinutes(b.start_time);
      let targetDay = todayStr;

      // Early morning window (00:00 - 04:59 NZ time): map early shifts to yesterday's service day
      if (nowAklHour < 5) {
        if (startMins < 300 || startMins >= 1440) {
          targetDay = yesterdayStr;
        }
      }

      stmt.run([
        String(b.vehicle_id),
        b.trip_id || '',
        b.route_display,
        b.origin || '',
        b.destination || '',
        targetDay,
        b.start_time || '',
        b.tardiness || 'On Time'
      ], (err) => {
        if (err) console.error('[DB] shift_history upsert failed:', err.message);
      });
    }
  });

  stmt.finalize();
  res.json({ success: true, count: liveBuses.length });
});

app.get('/api/history/bus/:vehicleId', (req, res) => {
  const vehicleId = (req.params.vehicleId || '').trim();

  db.all(
    `SELECT * FROM shift_history 
     WHERE vehicle_id = ? 
     ORDER BY day DESC, start_time DESC`,
    [vehicleId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

app.get('/api/history/route/:routeDisplay/:day', (req, res) => {
  const rawRoute = req.params.routeDisplay || '';
  const routeDisplay = rawRoute.trim().toUpperCase();
  const altRouteDisplay = routeDisplay.replace(/^0+/, '');
  const day = req.params.day;

  db.all(
    `SELECT * FROM shift_history 
     WHERE (route_display = ? OR route_display = ?) AND day = ?`,
    [routeDisplay, altRouteDisplay, day],
    (err, dbRows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      const combinedRows = [...(dbRows || [])];

      const scheduledTrips = routeScheduledTripsMap[routeDisplay] || routeScheduledTripsMap[altRouteDisplay] || [];
      scheduledTrips.forEach(st => {
        const tId = st.trip_id;
        const serviceId = tripServiceMap[tId] || tripServiceMap[extractBaseTripId(tId)];

        if (!serviceId || isServiceActiveOnDate(serviceId, day)) {
          combinedRows.push({
            vehicle_id: 'Scheduled',
            trip_id: tId,
            route_display: st.route_display || routeDisplay,
            origin: st.origin,
            destination: st.destination,
            day: day,
            start_time: st.start_time,
            tardiness: 'Scheduled',
            created_at: null
          });
        }
      });

      const uniqueMap = new Map();
      combinedRows.forEach(r => {
        const mins = timeStrToMinutes(r.start_time);
        const normDest = formatCleanDestination(r.destination).toLowerCase();
        const key = `${mins}_${normDest}`;

        if (!uniqueMap.has(key)) {
          uniqueMap.set(key, r);
        } else {
          const existing = uniqueMap.get(key);
          if (r.vehicle_id !== 'Scheduled' && existing.vehicle_id === 'Scheduled') {
            uniqueMap.set(key, r);
          } else if (r.vehicle_id !== 'Scheduled' && existing.vehicle_id !== 'Scheduled') {
            const subKey = `${key}_${r.vehicle_id}`;
            if (!uniqueMap.has(subKey)) {
              uniqueMap.set(subKey, r);
            }
          }
        }
      });

      let finalRows = Array.from(uniqueMap.values());
      finalRows.sort((a, b) => timeStrToMinutes(b.start_time) - timeStrToMinutes(a.start_time));

      res.json(finalRows);
    }
  );
});

app.get('/api/history/route-days/:routeDisplay', (req, res) => {
  const rawRoute = req.params.routeDisplay || '';
  const routeDisplay = rawRoute.trim().toUpperCase();
  const altRouteDisplay = routeDisplay.replace(/^0+/, '');

  db.all(
    `SELECT DISTINCT day FROM shift_history 
     WHERE (route_display = ? OR route_display = ?)
     ORDER BY day DESC`,
    [routeDisplay, altRouteDisplay],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      const daysSet = new Set((rows || []).map(r => r.day));

      const nowAkl = new Date(new Date().toLocaleString("en-US", { timeZone: "Pacific/Auckland" }));
      for (let i = 0; i < 7; i++) {
        const d = new Date(nowAkl);
        d.setDate(d.getDate() - i);
        daysSet.add(getNZDateStr(d));
      }

      const sortedDays = Array.from(daysSet).sort().reverse();
      res.json(sortedDays);
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

    calendarServices = {};
    calendarExceptions = {};

    await loadOrFetchGtfsData();

    res.json({ success: true, message: 'GTFS static data successfully refreshed!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/report-bug', async (req, res) => {
  try {
    const { userText, currentRoute, vehicleId } = req.body;
    const webhookUrl = getDiscordWebhookUrl();

    if (!webhookUrl) {
      console.error('[Bug Report Error] Webhook URL function returned empty string.');
      return res.status(500).json({ error: 'Webhook URL not configured on server' });
    }

    if (!userText || !userText.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const discordRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🚨 **New AT Tracker Bug Report**\n**Route:** ${currentRoute || 'None'}\n**Vehicle:** ${vehicleId || 'None'}\n**Details:** ${userText}`
      })
    });

    if (!discordRes.ok) {
      const errText = await discordRes.text();
      return res.status(500).json({ error: `Discord rejected request (${discordRes.status}): ${errText}` });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Bug Report Server Error]', err);
    res.status(500).json({ error: err.message });
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