// Scans NOAA's rolling 7-day GOES X-ray feed for C1-class-and-stronger flare peaks and
// archives each one as a standalone JSON window file, so events survive
// after they roll off NOAA's 7-day retention. Run by .github/workflows/archive-flares.yml.
import { writeFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';

const NOAA_URL = 'https://services.swpc.noaa.gov/json/goes/secondary/xrays-7-day.json';
const ARCHIVE_DIR = 'archive';
const INDEX_PATH = `${ARCHIVE_DIR}/index.json`;
const PEAK_THRESHOLD = 1e-6; // C1 and above

function classify(flux) {
  if (flux >= 1e-4) return { letter: 'X', label: 'X' + (flux / 1e-4).toFixed(1) };
  if (flux >= 1e-5) return { letter: 'M', label: 'M' + (flux / 1e-5).toFixed(1) };
  return { letter: 'C', label: 'C' + (flux / 1e-6).toFixed(1) };
}

function safeName(iso) {
  return iso.replace(/[:.]/g, '-');
}

async function main() {
  const res = await fetch(NOAA_URL);
  const json = await res.json();
  const series = json
    .filter(d => d.energy === '0.1-0.8nm' && typeof d.flux === 'number')
    .sort((a, b) => new Date(a.time_tag) - new Date(b.time_tag));
  if (!series.length) { console.log('No data from NOAA'); return; }

  // find contiguous runs above the threshold; the run's max flux/time is the flare peak.
  const events = [];
  let run = [];
  for (const d of series) {
    if (d.flux >= PEAK_THRESHOLD) {
      run.push(d);
    } else if (run.length) {
      events.push(run);
      run = [];
    }
  }
  if (run.length) events.push(run);

  const peaks = events.map(run => {
    let best = run[0];
    for (const d of run) if (d.flux > best.flux) best = d;
    return best;
  });

  if (!existsSync(ARCHIVE_DIR)) await mkdir(ARCHIVE_DIR, { recursive: true });
  let index = [];
  if (existsSync(INDEX_PATH)) {
    try { index = JSON.parse(await readFile(INDEX_PATH, 'utf8')); } catch { index = []; }
  }
  const known = new Set(index.map(e => e.peakTime));

  let added = 0;
  for (const peak of peaks) {
    const peakISO = new Date(peak.time_tag).toISOString();
    if (known.has(peakISO)) continue;

    const peakTs = new Date(peak.time_tag).getTime();
    const from = peakTs - 60 * 60000, to = peakTs + 180 * 60000;
    const windowData = series.filter(d => {
      const t = new Date(d.time_tag).getTime();
      return t >= from && t <= to;
    });
    const { letter, label } = classify(peak.flux);
    const file = `${safeName(peakISO)}_${label}.json`;

    await writeFile(`${ARCHIVE_DIR}/${file}`, JSON.stringify({
      class: letter, label, peakTime: peakISO, peakFlux: peak.flux,
      window: windowData.map(d => ({ time_tag: d.time_tag, flux: d.flux }))
    }));

    index.push({ file, class: letter, label, peakTime: peakISO, peakFlux: peak.flux });
    known.add(peakISO);
    added++;
  }

  // Top-up pass: events archived soon after their peak were stored with an incomplete
  // post-peak window. While they are still inside NOAA's 7-day feed, refill them.
  let topped = 0;
  const feedLast = new Date(series[series.length - 1].time_tag).getTime();
  for (const entry of index) {
    const peakTs = new Date(entry.peakTime).getTime();
    const wantTo = peakTs + 180 * 60000;
    if (feedLast < peakTs) continue;
    const path = `${ARCHIVE_DIR}/${entry.file}`;
    if (!existsSync(path)) continue;
    let doc;
    try { doc = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
    const have = doc.window && doc.window.length
      ? new Date(doc.window[doc.window.length - 1].time_tag).getTime() : 0;
    if (have >= Math.min(wantTo, feedLast) - 60000) continue;
    const from = peakTs - 60 * 60000;
    const refreshed = series.filter(d => {
      const t = new Date(d.time_tag).getTime();
      return t >= from && t <= wantTo;
    });
    if (refreshed.length <= (doc.window || []).length) continue;
    doc.window = refreshed.map(d => ({ time_tag: d.time_tag, flux: d.flux }));
    await writeFile(path, JSON.stringify(doc));
    topped++;
  }

  index.sort((a, b) => new Date(b.peakTime) - new Date(a.peakTime));
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2));
  console.log(`Archived ${added} new event(s), topped up ${topped}. Total: ${index.length}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
