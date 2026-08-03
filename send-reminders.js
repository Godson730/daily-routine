/**
 * Sends a Web Push reminder for every routine that came due since the last run.
 *
 * Runs on a schedule from .github/workflows/reminders.yml. Because that schedule
 * is best-effort and can be delayed, this walks minute-by-minute from the last
 * recorded run up to now, so a late run still catches everything it missed —
 * except reminders older than STALE_AFTER_MIN, which are dropped rather than
 * delivered at a misleading time.
 */
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const CONFIG = path.join(__dirname, "push-config.json");
const STATE = path.join(__dirname, "push-state.json");
const STALE_AFTER_MIN = 45;
const MAX_LOOKBACK_MIN = 180;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return fallback; }
}

// "07:30" in the given zone for a specific instant.
function localHM(date, tz) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
}

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const priv = process.env.VAPID_PRIVATE_KEY;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const subject = process.env.VAPID_SUBJECT || "https://godson730.github.io/daily-routine/";
  if (!DRY_RUN) {
    if (!priv || !pub) {
      console.error("Missing VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY.");
      process.exit(1);
    }
    webpush.setVapidDetails(subject, pub, priv);
  }

  const config = readJson(CONFIG, { devices: [] });
  const devices = Array.isArray(config.devices) ? config.devices : [];
  if (!devices.length) {
    console.log("No devices registered yet — nothing to send.");
    return;
  }

  const state = readJson(STATE, {});
  const dead = new Set(state.dead || []);
  const now = new Date();
  now.setSeconds(0, 0);

  let last = state.lastRun ? new Date(state.lastRun) : null;
  if (!last || isNaN(last)) last = new Date(now.getTime() - 5 * 60000);

  let lookback = Math.round((now - last) / 60000);
  if (lookback > MAX_LOOKBACK_MIN) lookback = MAX_LOOKBACK_MIN;
  if (lookback < 1) {
    console.log("No new minutes since the last run.");
    return;
  }

  // Every minute in (last, now], oldest first.
  const minutes = [];
  for (let i = lookback - 1; i >= 0; i--) minutes.push(new Date(now.getTime() - i * 60000));

  const jobs = [];
  for (const device of devices) {
    if (!device || !device.sub || !device.sub.endpoint) continue;
    if (dead.has(device.sub.endpoint)) continue;
    const tz = device.tz || "UTC";
    const routines = Array.isArray(device.routines) ? device.routines : [];

    for (const minute of minutes) {
      const ageMin = Math.round((now - minute) / 60000);
      if (ageMin > STALE_AFTER_MIN) continue;
      const hm = localHM(minute, tz);
      for (const r of routines) {
        if (r.t !== hm) continue;
        jobs.push({
          device,
          payload: {
            title: "JA Routine",
            body: r.n,
            tag: "routine-" + r.t + "-" + hm
          },
          when: hm
        });
      }
    }
  }

  if (!jobs.length) {
    console.log(`Checked ${lookback} minute(s) across ${devices.length} device(s) — nothing due.`);
  }

  for (const job of jobs) {
    if (DRY_RUN) {
      console.log(`[dry-run] would send "${job.payload.body}" (due ${job.when}).`);
      continue;
    }
    try {
      await webpush.sendNotification(job.device.sub, JSON.stringify(job.payload), { TTL: 1800 });
      console.log(`Sent "${job.payload.body}" (due ${job.when}).`);
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        dead.add(job.device.sub.endpoint);
        console.warn(`Subscription expired (HTTP ${code}) — device retired. It must re-register in the app.`);
      } else {
        console.error(`Push failed (HTTP ${code || "?"}): ${err && err.message}`);
        process.exitCode = 1;
      }
    }
  }

  if (!DRY_RUN) {
    state.lastRun = now.toISOString();
    state.dead = [...dead];
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
