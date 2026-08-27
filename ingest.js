require('dotenv').config();
const axios = require('axios');
const cron = require('node-cron');
const pool = require('./db');

const AT_API_KEY = process.env.AT_API_KEY;

function cleanFleetCode(v) {
  const rawLabel = v.vehicle?.label?.trim();
  const rawId = v.vehicle?.id?.trim();
  
  // Prefer fleet label if available, fall back to ID
  let code = rawLabel || rawId || 'UNKNOWN';

  // Format raw 5-digit NZ Bus / Howick & Eastern / Ritchies IDs to standard fleet codes if missing prefix
  if (/^\d{5}$/.test(code)) {
    return `BUS-${code}`;
  }
  return code;
}

async function fetchAndSaveVehiclePositions() {
  try {
    const response = await axios.get('https://api.at.govt.nz/realtime/legacy/vehiclelocations', {
      headers: { 'Ocp-Apim-Subscription-Key': AT_API_KEY }
    });

    const entities = response.data?.response?.entity || [];
    if (!entities.length) return;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      for (const item of entities) {
        const v = item.vehicle;
        if (!v || !v.position) continue;

        const vehicleId = cleanFleetCode(v);
        const routeId = v.trip?.route_id || 'Unassigned';
        const tripId = v.trip?.trip_id || null;
        const lat = v.position.latitude;
        const lon = v.position.longitude;
        const ts = new Date((v.timestamp || Date.now() / 1000) * 1000);

        await client.query(`
          INSERT INTO vehicle_positions (vehicle_id, route_id, trip_id, latitude, longitude, timestamp)
          VALUES ($1, $2, $3, $4, $5, $6);
        `, [vehicleId, routeId, tripId, lat, lon, ts]);
      }
      await client.query('COMMIT');
      console.log(`[${new Date().toLocaleTimeString()}] Logged ${entities.length} buses.`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('DB Insert Error:', err.message);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Ingest API Error:', err.message);
  }
}

fetchAndSaveVehiclePositions();
setInterval(fetchAndSaveVehiclePositions, 30000);

cron.schedule('0 0 * * *', async () => {
  await pool.query("DELETE FROM vehicle_positions WHERE timestamp < NOW() - INTERVAL '7 days';");
});