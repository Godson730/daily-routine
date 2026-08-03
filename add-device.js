/**
 * Registers a phone for push reminders.
 *
 *   node add-device.js <setup-code>
 *
 * The setup code comes from the "Reminders when the app is closed" card in the
 * app. Re-running it for a phone that is already registered updates that phone's
 * reminder times instead of adding a duplicate.
 */
const fs = require("fs");
const path = require("path");

const CONFIG = path.join(__dirname, "push-config.json");

const code = process.argv[2];
if (!code) {
  console.error("Usage: node add-device.js <setup-code>");
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(Buffer.from(code.trim(), "base64").toString("utf8"));
} catch (e) {
  console.error("That setup code isn't readable. Copy it again from the app.");
  process.exit(1);
}

const sub = payload && payload.sub;
if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
  console.error("That setup code has no usable push subscription in it.");
  process.exit(1);
}

const routines = Array.isArray(payload.routines) ? payload.routines : [];
const bad = routines.find((r) => !r || typeof r.n !== "string" || !/^\d{2}:\d{2}$/.test(r.t || ""));
if (bad) {
  console.error("That setup code has a malformed routine entry: " + JSON.stringify(bad));
  process.exit(1);
}

let config = { devices: [] };
try { config = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch (e) {}
if (!Array.isArray(config.devices)) config.devices = [];

const device = { tz: payload.tz || "UTC", sub, routines };
const at = config.devices.findIndex((d) => d && d.sub && d.sub.endpoint === sub.endpoint);
if (at >= 0) {
  config.devices[at] = device;
  console.log("Updated the existing phone.");
} else {
  config.devices.push(device);
  console.log("Added a new phone.");
}

fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + "\n");

console.log(`Timezone: ${device.tz}`);
console.log(`Reminders: ${routines.length}`);
for (const r of routines) console.log(`  ${r.t}  ${r.n}`);
console.log(`Phones registered: ${config.devices.length}`);
