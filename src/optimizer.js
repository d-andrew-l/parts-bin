// Upgrade optimizer. For each build it compares the platform + installed parts with the parts on the shelf
// (marked Available, never Sell / sold / in the trash) and only proposes changes that are compatible and
// measurably better. It also checks power-supply headroom and GPU fit, and lists what would be worth buying.
// Shared by the app (window.Optimizer) and the Node tests.
(function (root) {
  'use strict';
  const DB = () => (typeof module !== 'undefined' && module.exports ? require('./partsdb.js') : root.PartsDB);
  const RANK = {high: 0, medium: 1, low: 2, buy: 3, info: 4};
  const gb = (n) => (n >= 1000 ? `${+(n / 1000).toFixed(n % 1000 ? 1 : 0)} TB` : `${n} GB`);
  const isSSD = (p) => /SSD/.test(p.attrs?.kind || '');
  const isM2 = (p) => /M\.2/i.test(p.attrs?.formFactor || '') || p.attrs?.kind === 'NVMe SSD';
  const isSata = (p) => p.type === 'Storage' && !isM2(p);
  const qty = (p) => Math.max(1, +p.qty || 1);
  const live = (p) => !p.deleted;
  const onShelf = (p) => live(p) && !p.use && p.verdict !== 'Sell';
  const byCap = (x, y) => (y.attrs?.capacityGB || 0) - (x.attrs?.capacityGB || 0) || (y.mfgDate || '').localeCompare(x.mfgDate || '');
  const MEDIA_ROLE = /gam|media|plex|jellyfin|emby|transcod|render|edit|ai\b|ml\b|llm|stream|workstation|cad/i;

  // DDR3L runs at 1.35V or 1.5V, so it also works in a plain DDR3 board; the reverse isn't true.
  function ramFits(stick, plat) {
    const t = stick.attrs?.memType, form = stick.attrs?.memForm || 'UDIMM';
    if (!t || !plat.memType) return null;
    if (form !== (plat.memForm || 'UDIMM')) return false;
    return t === plat.memType || (plat.memType === 'DDR3' && t === 'DDR3L');
  }
  const cpuScore = (p) => p?.attrs?.score || DB().cpuScore(p?.attrs || {}) || null;
  const cpuTdp = (p) => p?.attrs?.tdpW || DB().findCPU(p?.item)?.tdpW || null;
  const gpuTdp = (p) => p?.attrs?.tdpW || DB().findGPU(p?.item)?.tdpW || null;
  const gpuPerf = (p) => p?.attrs?.perf || DB().findGPU(p?.item)?.perf || null;

  function gpuFits(gpu, plat) {
    const a = gpu.attrs || {};
    if (plat.lowProfileOnly && a.lowProfile === false) return false;
    if (plat.lowProfileOnly && !a.lowProfile) return null;
    if (plat.maxGpuLengthMm && a.lengthMm && a.lengthMm > plat.maxGpuLengthMm) return false;
    return plat.pcieFree == null ? null : plat.pcieFree > 0 || null;
  }

  // true / false / null (= not enough info to say)
  function fits(part, build) {
    const plat = build.platform || {};
    const a = part.attrs || {};
    switch (part.type) {
      case 'CPU':
      case 'Motherboard':
        if (!a.socket || !plat.socket) return null;
        return a.socket === plat.socket;
      case 'RAM':
        return ramFits(part, plat);
      case 'Storage':
        if (isM2(part)) return plat.m2Slots == null ? null : plat.m2Slots > 0;
        return plat.sataPorts == null ? null : plat.sataPorts > 0;
      case 'GPU':
        return gpuFits(part, plat);
      case 'Network':
        return plat.pcieFree == null ? null : plat.pcieFree > 0;
      default:
        return null;
    }
  }

  function missingInfo(plat) {
    const miss = [];
    if (!plat.socket) miss.push('CPU socket');
    if (!plat.memType) miss.push('RAM type');
    if (plat.ramSlots == null) miss.push('RAM slots');
    if (plat.m2Slots == null) miss.push('M.2 slots');
    if (plat.sataPorts == null) miss.push('SATA ports');
    return miss;
  }

  // rough peak draw: CPU at boost (TDP x 1.4), GPU board power, ~40 W board + fans, drives and sticks
  function powerEstimate(parts) {
    const cpu = parts.find((p) => p.type === 'CPU'), gpu = parts.find((p) => p.type === 'GPU');
    const drives = parts.filter((p) => p.type === 'Storage').reduce((s, p) => s + qty(p) * (isSSD(p) ? 4 : 8), 0);
    const sticks = parts.filter((p) => p.type === 'RAM').reduce((s, p) => s + qty(p), 0);
    return Math.round((cpuTdp(cpu) || 65) * 1.4 + (gpuTdp(gpu) || 0) + 40 + drives + sticks * 4);
  }
  const psuWatts = (parts, plat) => parts.find((p) => p.type === 'Power')?.attrs?.watts || plat.psuW || null;

  function suggest(build, allParts) {
    if (build.kind === 'project') return []; // electronics projects have no PC platform to upgrade
    const parts = allParts.filter(live);
    const plat = build.platform || {};
    const mine = parts.filter((p) => p.use === build.id);
    const pool = parts.filter(onShelf);
    const out = [];
    const caveat = (p) => (p.tested ? [] : [`${p.item} is marked untested; test it before relying on it.`]);
    const used = new Set();
    const buy = (title, reason, query) => out.push({priority: 'buy', action: 'buy', title, reason, query});

    const miss = missingInfo(plat);
    if (miss.length) out.push({priority: 'info', title: `Fill in ${build.name}'s platform details`, reason: `Missing: ${miss.join(', ')}. Without them the optimizer can't check what fits. Edit the build to add them.`});

    // ---- RAM: fill free slots (pairing for dual channel), else swap the smallest stick for a bigger one
    const sticks = mine.filter((p) => p.type === 'RAM');
    let count = sticks.reduce((s, p) => s + qty(p), 0);
    let total = sticks.reduce((s, p) => s + qty(p) * (p.attrs?.capacityGB || 0), 0);
    if (plat.memType && plat.ramSlots) {
      const cands = pool.filter((p) => p.type === 'RAM' && ramFits(p, plat)).sort((x, y) => (y.attrs.capacityGB || 0) - (x.attrs.capacityGB || 0) || (y.attrs.speed || 0) - (x.attrs.speed || 0) || (y.mfgDate || '').localeCompare(x.mfgDate || ''));
      const minSpeed = () => Math.min(...[...sticks, ...cands.filter((c) => used.has(c.id))].map((p) => p.attrs?.speed || Infinity));
      while (count < plat.ramSlots) {
        const free = cands.filter((c) => !used.has(c.id) && count + qty(c) <= plat.ramSlots);
        if (!free.length) break;
        const odd = count % 2 === 1 ? sticks.concat(cands.filter((c) => used.has(c.id))).at(-1) : null;
        const pick = (odd && free.find((c) => c.attrs.capacityGB === odd.attrs?.capacityGB)) || free[0];
        const cap = (pick.attrs.capacityGB || 0) * qty(pick);
        if (plat.maxRamGB && total + cap > plat.maxRamGB) break;
        used.add(pick.id);
        const before = total, beforeCount = count;
        total += cap;
        count += qty(pick);
        const dual = beforeCount === 1 || (beforeCount === 0 && count >= 2);
        const notes = [];
        const slow = minSpeed();
        if (pick.attrs.speed && slow < pick.attrs.speed) notes.push(`All sticks will run at the slowest speed (${slow} MT/s).`);
        if (pick.attrs.memType === 'DDR3L' && plat.memType === 'DDR3') notes.push('DDR3L runs fine at 1.5V in a DDR3 board.');
        out.push({priority: dual || before < 8 ? 'high' : before < 16 ? 'medium' : 'low', action: 'add', partId: pick.id, title: `Add ${pick.item}`,
          reason: `${gb(before)} → ${gb(total)} RAM${dual ? ', and two sticks enable dual channel (roughly double memory bandwidth)' : ''}. Uses a free slot (${count}/${plat.ramSlots}).`, caveats: [...notes, ...caveat(pick)]});
      }
      if (count >= plat.ramSlots && sticks.length) {
        const smallest = [...sticks].sort((x, y) => (x.attrs?.capacityGB || 0) - (y.attrs?.capacityGB || 0))[0];
        const bigger = cands.find((c) => !used.has(c.id) && qty(c) === 1 && (c.attrs.capacityGB || 0) > (smallest.attrs?.capacityGB || 0));
        if (bigger && (!plat.maxRamGB || total - smallest.attrs.capacityGB + bigger.attrs.capacityGB <= plat.maxRamGB)) {
          used.add(bigger.id);
          out.push({priority: 'medium', action: 'replace', partId: bigger.id, replaceId: smallest.id, title: `Swap ${smallest.item} for ${bigger.item}`,
            reason: `All ${plat.ramSlots} slots are full. ${gb(total)} → ${gb(total - smallest.attrs.capacityGB + bigger.attrs.capacityGB)} RAM. Mismatched sizes can drop part of the memory out of dual channel.`, caveats: caveat(bigger)});
        }
      }
      // worth buying: a matching stick for single channel, or a 2x8GB kit for anything under 16 GB
      const reused = out.some((s) => s.action && s.partId && partOf(s.partId)?.type === 'RAM');
      if (!reused && plat.ramSlots >= 2) {
        if (count === 1 && sticks[0]?.attrs?.capacityGB) buy(`Buy a matching ${sticks[0].attrs.capacityGB}GB ${plat.memType} stick`, `${build.name} runs one stick (single channel). A second matching stick doubles memory bandwidth and RAM.`, `${sticks[0].attrs.capacityGB}GB ${plat.memType} ${plat.memForm === 'SODIMM' ? 'SODIMM' : 'desktop'} ${sticks[0].attrs.speed || ''}`);
        else if (total < 16 && count === 0) buy(`Buy a 2×8GB ${plat.memType} kit`, `${build.name} has no RAM recorded. 16 GB in two sticks is the comfortable minimum today.`, `2x8GB ${plat.memType} ${plat.memForm === 'SODIMM' ? 'SODIMM' : 'desktop'} kit`);
      }
    }
    function partOf(id) { return parts.find((p) => p.id === id); }

    // ---- CPU: a faster chip for the same socket (≥10% higher score)
    const cpu = mine.find((p) => p.type === 'CPU');
    const cooler = mine.find((p) => p.type === 'Cooling' && p.attrs?.tdpW);
    if (plat.socket) {
      const best = pool.filter((p) => p.type === 'CPU' && p.attrs?.socket === plat.socket && cpuScore(p)).sort((x, y) => cpuScore(y) - cpuScore(x))[0];
      const cpuNotes = (p) => {
        const n = [];
        if (cpu?.attrs?.arch && p.attrs?.arch && cpu.attrs.arch !== p.attrs.arch) n.push(`The board may need a BIOS update before it recognises a ${p.attrs.arch} chip; update while the old CPU is still in.`);
        else n.push('May need a BIOS update first.');
        const t = cpuTdp(p);
        if (cooler && t && t > cooler.attrs.tdpW) n.push(`${cooler.item} is rated for ${cooler.attrs.tdpW} W; this CPU is ${t} W.`);
        else if (t && cpuTdp(cpu) && t > cpuTdp(cpu)) n.push(`Runs hotter than the current chip (${cpuTdp(cpu)} → ${t} W); check the cooler.`);
        return n;
      };
      if (best && !cpu) {
        out.push({priority: 'high', action: 'add', partId: best.id, title: `Install ${best.item}`, reason: `${build.name} has no CPU recorded and this one fits ${plat.socket}.`, caveats: [...cpuNotes(best), ...caveat(best)]});
      } else if (best && cpuScore(cpu) && cpuScore(best) >= cpuScore(cpu) * 1.1) {
        const gain = Math.round((cpuScore(best) / cpuScore(cpu) - 1) * 100);
        out.push({priority: gain >= 30 ? 'high' : 'medium', action: 'replace', partId: best.id, replaceId: cpu.id, title: `Replace ${cpu.item} with ${best.item}`,
          reason: `About ${gain}% more multithread performance (Parts Bin score ${cpuScore(cpu).toLocaleString()} → ${cpuScore(best).toLocaleString()}), same ${plat.socket} socket.`, caveats: [...cpuNotes(best), ...caveat(best)]});
      }
      // worth buying: the best drop-in chip in the database, if it's a big step up
      const top = DB().bestForSocket(plat.socket, plat.memType)[0];
      const have = cpuScore(cpu);
      if (top && have && top.score >= have * 1.4 && !pool.some((p) => DB().findCPU(p.item)?.key === top.key) && DB().findCPU(cpu?.item)?.key !== top.key) {
        buy(`Best drop-in CPU: ${top.name}`, `The fastest ${plat.socket} chip in the database for this board's RAM, about ${Math.round((top.score / have - 1) * 100)}% faster multithreaded than the ${cpu.item}. Check the board's CPU support list first.`, top.name);
      }
    }

    // ---- Storage: SSD when there is none, then fill free M.2 / SATA with capacity
    const drives = mine.filter((p) => p.type === 'Storage');
    let m2Free = plat.m2Slots == null ? 0 : plat.m2Slots - drives.filter(isM2).reduce((s, p) => s + qty(p), 0);
    let sataFree = plat.sataPorts == null ? 0 : plat.sataPorts - drives.filter(isSata).reduce((s, p) => s + qty(p), 0);
    const storageRole = /nas|storage|backup|file|samba|media|plex|jellyfin/i.test(build.role || '');
    const ssds = pool.filter((p) => p.type === 'Storage' && isSSD(p)).sort(byCap);
    // a lot of several drives needs that many free ports
    const takeSlot = (p) => {
      const n = qty(p);
      if (isM2(p) && m2Free >= n) return (m2Free -= n), n > 1 ? `${n} free M.2 slots` : 'a free M.2 slot';
      if (!isM2(p) && sataFree >= n) return (sataFree -= n), n > 1 ? `${n} free SATA ports` : 'a free SATA port';
      return null;
    };
    if (!drives.some(isSSD)) {
      const pick = ssds.find((p) => (isM2(p) ? m2Free > 0 : sataFree > 0));
      if (pick) {
        const slot = takeSlot(pick);
        used.add(pick.id);
        out.push({priority: 'high', action: 'add', partId: pick.id, title: `Add ${pick.item} as the boot drive`, reason: `${build.name} has no SSD recorded. Booting from an SSD is many times faster than a hard drive. Goes in ${slot}.`, caveats: caveat(pick)});
      } else if (plat.m2Slots != null || plat.sataPorts != null) {
        buy(`Buy an SSD for the boot drive`, `${build.name} has no SSD recorded. A 500 GB ${m2Free > 0 ? 'NVMe drive in the free M.2 slot' : 'SATA SSD'} makes everything feel faster.`, m2Free > 0 ? '500GB NVMe M.2 2280 SSD' : '500GB 2.5" SATA SSD');
      }
    }
    for (const p of ssds) {
      if (used.has(p.id)) continue;
      const slot = takeSlot(p);
      if (!slot) continue;
      used.add(p.id);
      out.push({priority: 'low', action: 'add', partId: p.id, title: `Add ${p.item}`, reason: `+${gb(p.attrs.capacityGB || 0)} of SSD storage in ${slot}.`, caveats: caveat(p)});
    }
    if (storageRole) {
      for (const p of pool.filter((x) => x.type === 'Storage' && !isSSD(x)).sort(byCap)) {
        const slot = takeSlot(p);
        if (!slot) continue;
        used.add(p.id);
        out.push({priority: 'low', action: 'add', partId: p.id, title: `Add ${p.item}${qty(p) > 1 ? ` (×${qty(p)})` : ''}`, reason: `+${gb((p.attrs.capacityGB || 0) * qty(p))} of storage in ${slot}. Best as a backup or scratch copy, not the only copy of anything.`,
          caveats: ['Run a SMART check and a full surface test first.', ...caveat(p)]});
      }
    }

    // ---- GPU: a faster card that physically fits and the PSU can feed
    const watts = psuWatts(mine, plat);
    const draw = powerEstimate(mine);
    const gpu = mine.find((p) => p.type === 'GPU');
    const cardOk = (g) => {
      const f = gpuFits(g, {...plat, pcieFree: gpu ? 1 : plat.pcieFree});
      if (f === false) return [false];
      const notes = [];
      if (plat.lowProfileOnly && !g.attrs?.lowProfile) notes.push(`${build.name} only takes low-profile cards; check this one has a low-profile bracket.`);
      if (plat.maxGpuLengthMm && !g.attrs?.lengthMm) notes.push(`Check the card is shorter than ${plat.maxGpuLengthMm} mm.`);
      const extra = (gpuTdp(g) || 0) - (gpuTdp(gpu) || 0);
      if (watts && extra > 0 && draw + extra > watts * 0.9) return [false];
      if (watts && extra > 0 && draw + extra > watts * 0.8) notes.push(`Puts the ${watts} W supply at about ${Math.round(((draw + extra) / watts) * 100)}% at peak; fine for a media box, tight for sustained load.`);
      const conn = DB().findGPU(g.item)?.power;
      if (conn && conn !== 'none') notes.push(`Needs ${conn} power from the PSU.`);
      return [true, notes];
    };
    const gpus = pool.filter((p) => p.type === 'GPU' && gpuPerf(p)).sort((x, y) => gpuPerf(y) - gpuPerf(x));
    if (gpu && gpuPerf(gpu)) {
      const better = gpus.find((g) => gpuPerf(g) >= gpuPerf(gpu) * 1.15 && cardOk(g)[0]);
      if (better) out.push({priority: 'medium', action: 'replace', partId: better.id, replaceId: gpu.id, title: `Replace ${gpu.item} with ${better.item}`,
        reason: `About ${Math.round((gpuPerf(better) / gpuPerf(gpu) - 1) * 100)}% faster graphics (rough index ${gpuPerf(gpu)} → ${gpuPerf(better)}).`, caveats: [...cardOk(better)[1], ...caveat(better)]});
    } else if (!gpu && MEDIA_ROLE.test(build.role || '') && (plat.pcieFree || 0) > 0) {
      const g = gpus.find((x) => cardOk(x)[0]);
      if (g) out.push({priority: 'medium', action: 'add', partId: g.id, title: `Add ${g.item}`, reason: `${build.name}'s role (${build.role}) benefits from a dedicated card, and it has a free PCIe slot.`, caveats: [...cardOk(g)[1], ...caveat(g)]});
    }

    // ---- Power: warn when the PSU is close to its limit, offer a bigger spare if there is one
    if (watts && draw > watts * 0.8) {
      const spare = pool.filter((p) => p.type === 'Power' && (p.attrs?.watts || 0) >= draw * 1.25 && !/test bench only|not for a build/i.test(p.notes || '')).sort((x, y) => x.attrs.watts - y.attrs.watts)[0];
      const psu = mine.find((p) => p.type === 'Power');
      if (spare && psu) out.push({priority: 'high', action: 'replace', partId: spare.id, replaceId: psu.id, title: `Replace ${psu.item} with ${spare.item}`, reason: `Estimated peak draw is about ${draw} W, ${Math.round((draw / watts) * 100)}% of the current ${watts} W supply. ${spare.attrs.watts} W leaves healthy headroom.`, caveats: caveat(spare)});
      else {
        out.push({priority: 'info', title: `Power supply is close to its limit`, reason: `Estimated peak draw is about ${draw} W on a ${watts} W supply (${Math.round((draw / watts) * 100)}%). Supplies are happiest under 80%.`});
        buy(`Buy a ${Math.ceil((draw * 1.5) / 50) * 50} W power supply`, `Gives ${build.name} about 50% headroom over its estimated ${draw} W peak. Get an 80 Plus Gold unit from a reputable brand.`, `${Math.ceil((draw * 1.5) / 50) * 50}W ATX power supply 80 Plus Gold`);
      }
    }

    return out.sort((x, y) => RANK[x.priority] - RANK[y.priority]);
  }

  // spares that can't go into any build as it's currently described
  function orphans(builds, parts) {
    const checkable = ['CPU', 'RAM', 'Motherboard'];
    const pcs = builds.filter((b) => b.kind !== 'project');
    return parts.filter((p) => onShelf(p) && checkable.includes(p.type) && pcs.length && pcs.every((b) => fits(p, b) === false));
  }

  const api = {suggest, fits, orphans, missingInfo, powerEstimate};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Optimizer = api;
})(typeof window !== 'undefined' ? window : globalThis);
