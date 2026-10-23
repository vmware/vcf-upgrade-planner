/* VC -> Supervisor -> VKS -> VKr upgrade solver.
 * Ported verbatim from upstream:
 *   tools/upgrade-solver.js (see docs/vks-upgrade-planner.html script tag).
 * Re-synced from wcp-interop:main @ a44e8594, 2026-10-23
 * New paths added for VKS 3.8.0 and for VKr v1.37
 * Implements SPEC.md section 2. Keep in lockstep with that spec + solver -
 * this is a straight copy, with no local modifications.
 */
// ======================================================================
// Browser port of upgrade-solver.js (design doc §5.6 / SPEC.md §2).
// Logic is copied verbatim from the Node prototype minus the CLI/fs wrapper —
// per SPEC.md's own rule, path/compatibility RULES live only here and in
// upgrade-solver.js; if the two drift, upgrade-solver.js wins and this file
// should be re-synced from it.
// ======================================================================
/**
 * Single BFS walk, used two ways depending on `isGoal`:
 *   - with `isGoal`: shortest-path search, returns the first matching node's { node, hops, path },
 *     or null if nothing matches (mirrors the former `bfsShortestPath`).
 *   - without it (or with a falsy value): full reachability, returns a Map of every reachable node
 *     to its { hops, path } (mirrors the former `bfsAllReachable`).
 * Both former functions did the identical queue walk with only the stopping condition differing.
 */
function bfsWalk(graph, start, isGoal) {
  const result = new Map();
  const seen = new Set([start]);
  let frontier = [{ node: start, path: [start] }];
  let hops = 0;
  if (isGoal && isGoal(start)) return { node: start, hops: 0, path: [start] };
  while (frontier.length) {
    hops += 1;
    const next = [];
    for (const { node, path } of frontier) {
      for (const nbr of graph[node] || []) {
        if (seen.has(nbr)) continue;
        seen.add(nbr);
        const newPath = path.concat(nbr);
        if (isGoal) {
          if (isGoal(nbr)) return { node: nbr, hops, path: newPath };
        } else {
          result.set(nbr, { hops, path: newPath });
        }
        next.push({ node: nbr, path: newPath });
      }
    }
    frontier = next;
  }
  return isGoal ? null : result;
}

function vcFamily(vc) { return vc.startsWith('8.') ? '8.x' : '9.x'; }

/**
 * Does the interop upgrade graph know this vCenter build at all — as a source or as a target?
 */
function vcKnownToUpgradeGraph(matrix, vc) {
  if (Object.prototype.hasOwnProperty.call(matrix.vc_upgrade_graph, vc)) return true;
  return Object.values(matrix.vc_upgrade_graph).some((targets) => targets.includes(vc));
}
function vcOrder(matrix) { return Object.keys(matrix.vc_sv_matrix); }

/**
 * Does `vc` push Supervisor images through the Unified Depot? (rule 5b's async floor)
 *
 * By version, not by position in vc_sv_matrix: that order is chronological within 9.x, and an
 * express patch of an older train (9.0.2.0100, released after 9.1.0.0) is still a 9.0 vCenter.
 */
function isUnifiedDepotVc(matrix, vc) {
  return Boolean(matrix.vc_sv_matrix[vc]) && vcFamily(vc) === '9.x' && compareVersionNumbers(vc, '9.1.0.0') >= 0;
}

function compareVersionNumbers(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// A Supervisor lineage is its -vsc suffix, and lineages are ordered by when they shipped - the
// release date of the first vCenter carrying the suffix - not by the suffix's digits: -vsc0.1.15
// (8.0U3j, 2026-05-27) is newer than -vsc9.1.0.0 (2026-05-12). A Supervisor-only lineage
// (9.0.0.0100) has no vCenter, so it takes interop's date for its own builds (sv_release_dates),
// and only a lineage with neither falls back to version order.
function lineageDate(matrix, suffix) {
  let date = null;
  for (const e of Object.values(matrix.vc_sv_matrix)) {
    if (e.sv_version_suffix === suffix && e.release_date && (!date || e.release_date < date)) date = e.release_date;
  }
  if (date || !isSupervisorOnlyLineage(matrix, suffix)) return date;
  for (const [build, d] of Object.entries(matrix.sv_release_dates || {})) {
    if (parseVscSuffix(build) === suffix && (!date || d < date)) date = d;
  }
  return date;
}

function compareLineage(matrix, a, b) {
  const da = lineageDate(matrix, a), db = lineageDate(matrix, b);
  if (da && db && da !== db) return da < db ? -1 : 1;
  return compareVersionNumbers(a, b);
}

// A lineage no vCenter ships: a Supervisor-only release (9.0.0.0100, 9.0.2.0100), delivered onto
// the vCenters sv_vc_compatibility lists.
function isSupervisorOnlyLineage(matrix, suffix) {
  return !Object.values(matrix.vc_sv_matrix).some((e) => e.sv_version_suffix === suffix);
}

/**
 * Express-patch back-in-time rule: an express patch (x.y.z.NNNN, NNNN > 0) is not an independent
 * entry point, so it is blocked from `from` whenever its base release x.y.z.0 would be a
 * back-in-time hop, even if the patch itself shipped later (8.0 U3i -> 9.0.2.0100 is refused when
 * 9.0.2.0 predates 8.0 U3i). When `from` is itself an express patch it is not an independent entry
 * point either, so it is judged by its base release (9.0.2.0100 -> 9.1.0.0300 is allowed: 9.0.2.0
 * predates 9.1.0.0). Mirrors Rule E in scripts/upgrade_engine.py.
 */
function epBaseBackInTime(matrix, from, to) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(to);
  if (!m || Number(m[4]) === 0) return false;
  const base = `${m[1]}.${m[2]}.${m[3]}.0`;
  // Already on (or an express patch of) that line: the base is not an entry point being crossed.
  if (from === base || from.startsWith(`${m[1]}.${m[2]}.${m[3]}.`)) return false;
  if (!matrix.vc_sv_matrix[base] || !matrix.vc_sv_matrix[from]) return false;
  const fm = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(from);
  const fromBase = fm && Number(fm[4]) > 0 ? `${fm[1]}.${fm[2]}.${fm[3]}.0` : from;
  const fDate = (matrix.vc_sv_matrix[fromBase] || matrix.vc_sv_matrix[from]).release_date;
  const bDate = matrix.vc_sv_matrix[base].release_date;
  return !!(fDate && bDate) && bDate < fDate;
}

function vcReachable(matrix, fromVc, allow9x) {
  const order = vcOrder(matrix);
  const idx = new Map(order.map((v, i) => [v, i]));
  const fromIdx = idx.get(fromVc);
  if (fromIdx === undefined) throw new Error(`Unknown VC version "${fromVc}" (not in vc_sv_matrix)`);
  const dateOf = (v) => matrix.vc_sv_matrix[v].release_date;
  const allowedKeys = new Set(
    order.filter((v) => idx.get(v) >= fromIdx && (allow9x || vcFamily(v) === vcFamily(fromVc)))
  );
  const graph = {};
  for (const v of allowedKeys) {
    const vDate = dateOf(v);
    graph[v] = (matrix.vc_upgrade_graph[v] || []).filter((n) => {
      if (!allowedKeys.has(n) || idx.get(n) < idx.get(v)) return false;
      const nDate = dateOf(n);
      if (epBaseBackInTime(matrix, v, n)) return false;
      return !(vDate && nDate) || nDate >= vDate;
    });
  }
  return bfsWalk(graph, fromVc);
}

function realVcEdge(matrix, a, b) {
  const edges = matrix.vc_upgrade_graph[a];
  if (!edges || !edges.includes(b)) return false;
  if (epBaseBackInTime(matrix, a, b)) return false;
  const svA = matrix.vc_sv_matrix[a].supported_sv_k8s_minors;
  const svB = new Set(matrix.vc_sv_matrix[b].supported_sv_k8s_minors);
  return svA.some((m) => svB.has(m));
}

/**
 * Is 9.x build `vc` in train `train` (e.g. "9.1") or a later one? Compared numerically on the
 * leading components, not by vc_sv_matrix order: that order is release-date based, so a late
 * 9.0.x express patch (9.0.2.0100) sorts after 9.1.0.0 without being a 9.1 build.
 */
function vcTrainAtLeast(vc, train) {
  const a = vc.split('.').map(Number);
  const b = String(train).split('.').map(Number);
  for (let i = 0; i < b.length; i++) {
    if (Number.isNaN(a[i]) || Number.isNaN(b[i])) return false;
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/**
 * SPEC.md rule 9b's golden-path gateway: the hand-maintained waypoint an 8.x source ordered before
 * it must pass through on its way to a 9.x build in `min_target_train` or later (golden path to
 * 9.1+). Null when it does not apply, or when the source has no real edge to it.
 */
function goldenGatewayFor(matrix, fromVc, toVc) {
  const gw = matrix.golden_path_9x_gateway;
  if (!gw || !gw.via || vcFamily(fromVc) !== '8.x' || vcFamily(toVc) !== '9.x') return null;
  if (!vcTrainAtLeast(toVc, gw.min_target_train)) return null;
  const order = vcOrder(matrix);
  const from = order.indexOf(fromVc);
  const via = order.indexOf(gw.via);
  if (from === -1 || via === -1 || from >= via || !realVcEdge(matrix, fromVc, gw.via)) return null;
  return gw.via;
}

/**
 * The gateway's optional second waypoint (`golden_path_9x_gateway.then`, golden path to 9.1+):
 * a route that passes through the gateway build, or starts on it, continues through
 * `then.via` before the final hop when the target is in `then.min_target_train` or later. Sources
 * past the gateway never reach it, so they keep their direct edges. Null when it does not apply
 * or either hop is not a real edge.
 */
function goldenThenFor(matrix, fromVc, toVc) {
  const gw = matrix.golden_path_9x_gateway;
  const then = gw && gw.then;
  if (!then || !then.via || vcFamily(fromVc) !== '8.x' || vcFamily(toVc) !== '9.x') return null;
  if (!vcTrainAtLeast(toVc, gw.min_target_train) || !vcTrainAtLeast(toVc, then.min_target_train)) return null;
  const anchor = fromVc === gw.via ? fromVc : goldenGatewayFor(matrix, fromVc, toVc);
  if (anchor !== gw.via || !realVcEdge(matrix, gw.via, then.via) || !realVcEdge(matrix, then.via, toVc)) return null;
  return then.via;
}

function recommendedVcPath(matrix, fromVc, toVc) {
  const via = goldenGatewayFor(matrix, fromVc, toVc);
  const then = goldenThenFor(matrix, fromVc, toVc);
  if (via || then) {
    const rest = then ? derivedVcPath(matrix, then, toVc) : derivedVcPath(matrix, via, toVc);
    if (rest) {
      const path = [fromVc, ...(via ? [via] : []), ...(then ? [then] : []), ...rest.path.slice(1)];
      return { path, hops: path.length - 1 };
    }
  }
  return derivedVcPath(matrix, fromVc, toVc);
}

function derivedVcPath(matrix, fromVc, toVc) {
  if (fromVc === toVc) return { path: [toVc], hops: 0 };

  const order = vcOrder(matrix);
  const idx = new Map(order.map((v, i) => [v, i]));
  const from = idx.get(fromVc);
  const to = idx.get(toVc);
  if (from === undefined || to === undefined || to <= from) return null;

  const path = [fromVc];
  let cur = fromVc;
  let guard = 0;
  while (cur !== toVc) {
    if (++guard > order.length) return null;
    if (realVcEdge(matrix, cur, toVc)) { path.push(toVc); cur = toVc; break; }

    let next = null;
    for (const b of (matrix.vc_upgrade_graph[cur] || [])) {
      const i = idx.get(b);
      if (i !== undefined && i < to && realVcEdge(matrix, cur, b) && (next === null || i > idx.get(next))) {
        next = b;
      }
    }
    if (next === null || idx.get(next) <= idx.get(cur)) return null;
    path.push(next);
    cur = next;
  }
  return { path, hops: path.length - 1 };
}

function recommendedNextVcHop(matrix, fromVc, toVc) {
  const rec = recommendedVcPath(matrix, fromVc, toVc);
  return rec && rec.path.length > 1 ? rec.path[1] : null;
}

function resolveVcHopPath(matrix, fromVc, toVc, allow9x) {
  return recommendedVcPath(matrix, fromVc, toVc) || vcReachable(matrix, fromVc, allow9x).get(toVc);
}

function parseSvMinor(svFull) {
  const m = /^v?(\d+)\.(\d+)\.\d+/.exec(svFull);
  return m ? `${m[1]}.${m[2]}` : null;
}

function svMinorOf(v) {
  return /^\d+\.\d+$/.test(v) ? v : parseSvMinor(v);
}

function parseVscSuffix(svFull) {
  const m = /-vsc(.+)$/.exec(svFull);
  return m ? m[1] : null;
}

/**
 * UPDATED: Scans vc_sv_matrix directly to find all matching vCenter releases
 * sharing the -vsc suffix, returning the newest one in matrix order.
 * This fixes lossy inversion when multiple vCenters share a suffix (e.g. 0.1.15).
 */
function deriveVcFromSv(matrix, svInput) {
  if (!svInput || !svInput.includes('-vsc')) return null;
  const suffix = parseVscSuffix(svInput);
  if (!suffix) return null;
  const matches = Object.keys(matrix.vc_sv_matrix).filter(
    (vc) => matrix.vc_sv_matrix[vc].sv_version_suffix === suffix
  );
  return matches.length ? matches[matches.length - 1] : null;
}

function resolveStartingSv(matrix, currentVC, currentSvInput) {
  if (!currentSvInput) {
    const entry = matrix.vc_sv_matrix[currentVC];
    if (!entry) throw new Error(`Unknown current VC "${currentVC}"`);
    const minors = entry.supported_sv_k8s_minors;
    const minor = minors[minors.length - 1];
    return { svFull: embeddedSvBuildForMinor(matrix, currentVC, minor), svMinor: minor, shipVc: currentVC, source: 'defaulted-highest' };
  }
  if (currentSvInput.includes('-vsc')) {
    const derivedVc = deriveVcFromSv(matrix, currentSvInput);
    return {
      svFull: currentSvInput, svMinor: parseSvMinor(currentSvInput),
      shipVc: derivedVc || currentVC, source: 'parsed-vsc-suffix',
    };
  }
  const asPatch = /^v?(\d+\.\d+)\.\d+/.exec(currentSvInput);
  if (asPatch) {
    const resolved = exactSvBuildForPatch(matrix, currentVC, currentSvInput);
    return {
      svFull: resolved || currentSvInput, svMinor: asPatch[1], shipVc: currentVC,
      source: resolved ? 'bare-patch+current-vc' : 'bare-patch+current-vc (unresolved)',
    };
  }
  if (/^v?\d+\.\d+$/.test(currentSvInput)) {
    return { svFull: null, svMinor: currentSvInput.replace(/^v/, ''), shipVc: currentVC, source: 'bare-minor+current-vc' };
  }
  throw new Error(
    `Could not parse Supervisor version "${currentSvInput}". Expected a Kubernetes minor ` +
    `("1.30"), a patch ("1.32.9"), or a full build ("v1.32.9+vmware.1-fips-vsc9.1.0.0").`
  );
}

function allSvVersions(matrix) {
  const bare = (s) => { const m = /^v?(\d+\.\d+\.\d+)/.exec(s); return m ? m[1] : null; };
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    return (pa[0] - pb[0]) || (pa[1] - pb[1]) || ((pa[2] || 0) - (pb[2] || 0));
  };
  const builds = new Set(Object.keys(matrix.sv_upgrade_graph));
  for (const e of matrix.sv_vks_compatibility) builds.add(e.sv_k8s);
  const patches = new Set();
  for (const b of builds) { const p = bare(b); if (p) patches.add(p); }
  return {
    minors: allSvMinorsOrdered(matrix),
    patches: [...patches].sort(cmp),
    builds: [...builds].sort((a, b) => cmp(bare(a) || '0.0.0', bare(b) || '0.0.0') || a.localeCompare(b)),
  };
}

const SV_MINORS_ORDERED_CACHE = new WeakMap();
function allSvMinorsOrdered(matrix) {
  const cached = SV_MINORS_ORDERED_CACHE.get(matrix);
  if (cached) return cached;
  const set = new Set();
  for (const entry of Object.values(matrix.vc_sv_matrix)) {
    for (const m of entry.supported_sv_k8s_minors) set.add(m);
  }
  for (const src of [matrix.sv_vc_compatibility, matrix.sv_upgrade_graph]) {
    for (const build of Object.keys(src || {})) {
      const mm = parseSvMinor(build);
      if (mm) set.add(mm);
    }
  }
  const ordered = [...set].sort((a, b) => {
    const [aMaj, aMin] = a.split('.').map(Number);
    const [bMaj, bMin] = b.split('.').map(Number);
    return aMaj - bMaj || aMin - bMin;
  });
  SV_MINORS_ORDERED_CACHE.set(matrix, ordered);
  return ordered;
}

function svMinorDistance(matrix, fromMinor, toMinor) {
  const order = allSvMinorsOrdered(matrix);
  const fi = order.indexOf(fromMinor);
  const ti = order.indexOf(toMinor);
  if (fi === -1 || ti === -1) return Infinity;
  return Math.max(0, ti - fi);
}

const SV_MINOR_EDGE_CACHE = new WeakMap();
function svMinorEdgeSet(matrix) {
  const cached = SV_MINOR_EDGE_CACHE.get(matrix);
  if (cached) return cached;
  const edges = new Set();
  for (const [build, targets] of Object.entries(matrix.sv_upgrade_graph || {})) {
    const fromMinor = parseSvMinor(build);
    if (!fromMinor) continue;
    for (const t of targets || []) {
      const toMinor = parseSvMinor(t);
      if (toMinor) edges.add(`${fromMinor}->${toMinor}`);
    }
  }
  SV_MINOR_EDGE_CACHE.set(matrix, edges);
  return edges;
}

function svMinorHasUpgradeEdge(matrix, fromMinor, toMinor) {
  return fromMinor === toMinor || svMinorEdgeSet(matrix).has(`${fromMinor}->${toMinor}`);
}

function expandSvMinorSteps(matrix, fromMinor, toMinor, reason) {
  const order = allSvMinorsOrdered(matrix);
  const fi = order.indexOf(fromMinor);
  const ti = order.indexOf(toMinor);
  if (fi === -1 || ti === -1 || ti <= fi) return [];
  const phases = [];
  for (let i = fi; i < ti; i++) {
    if (!svMinorHasUpgradeEdge(matrix, order[i], order[i + 1])) {
      const err = new Error(
        `Data gap: sv_upgrade_graph has no upgrade edge from Supervisor ${order[i]} to ${order[i + 1]}, ` +
        `but they are adjacent in the known minor order - rule 5a requires a real graph edge, not just ` +
        `minor-order adjacency, before this hop can be planned.`
      );
      err.svUpgradeGraphGap = true;
      throw err;
    }
    phases.push({ phase: 'Supervisor', from: order[i], to: order[i + 1], reason });
  }
  return phases;
}

function svMinorsSupportingVks(matrix, vks) {
  const minors = new Set();
  for (const entry of matrix.sv_vks_compatibility) {
    if (entry.allowed_vks.includes(vks)) {
      const m = parseSvMinor(entry.sv_k8s);
      if (m) minors.add(m);
    }
  }
  return minors;
}

function vksAllowedForSvMinor(matrix, svMinor) {
  const allowed = new Set();
  for (const entry of matrix.sv_vks_compatibility) {
    if (parseSvMinor(entry.sv_k8s) === svMinor) for (const vks of entry.allowed_vks) allowed.add(vks);
  }
  return allowed;
}

function vksAllowedForSvBuildOrMinor(matrix, svBuildOrMinor) {
  const exact = matrix.sv_vks_compatibility.find((e) => e.sv_k8s === svBuildOrMinor);
  if (exact) return new Set(exact.allowed_vks);
  return vksAllowedForSvMinor(matrix, parseSvMinor(svBuildOrMinor) || svBuildOrMinor);
}

function vkrAllowedForVks(matrix, vks) {
  const entry = matrix.vks_vkr_compatibility.find((e) => e.vks === vks);
  return entry ? new Set(entry.allowed_vkr) : new Set();
}

function parseVks(vks) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(vks);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

function compareVks(a, b) {
  const pa = parseVks(a), pb = parseVks(b);
  if (!pa || !pb) return 0;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

function bestVksForVkr(matrix, vkr, fromVks, maxVks) {
  const supporting = matrix.vks_vkr_compatibility
    .filter((e) => e.allowed_vkr.includes(vkr))
    .map((e) => e.vks)
    .filter((v) => (!fromVks || compareVks(v, fromVks) >= 0) && (!maxVks || compareVks(v, maxVks) <= 0));
  if (!supporting.length) return null;
  const sorted = supporting.slice().sort(compareVks);
  return sorted[sorted.length - 1];
}

function isVkrSuperseded(matrix, vkr) { return Object.prototype.hasOwnProperty.call(matrix.vkr_status, vkr); }

function liveSiblingForSupersededVkr(matrix, vks, vkr) {
  const allowed = vkrAllowedForVks(matrix, vks);
  const forward = (matrix.vkr_upgrade_graph[vkr] || []).filter(
    (v) => !isVkrSuperseded(matrix, v) && allowed.has(v) && compareVkr(v, vkr) > 0);
  if (!forward.length) return null;
  const sameMinor = forward.filter((v) => vkrMinor(v) === vkrMinor(vkr));
  return (sameMinor.length ? sameMinor : forward).slice().sort(compareVkr)[0];
}

function lowestSufficientVks(matrix, vkrs, fromVks, ceilingVks) {
  const supporting = matrix.vks_vkr_compatibility
    .filter((e) => vkrs.every((v) => e.allowed_vkr.includes(v)))
    .map((e) => e.vks)
    .filter((v) => (!fromVks || compareVks(v, fromVks) >= 0) && (!ceilingVks || compareVks(v, ceilingVks) <= 0));
  if (!supporting.length) return null;
  return supporting.slice().sort((a, b) => {
    const pa = parseVks(a), pb = parseVks(b);
    if (!pa || !pb) return compareVks(a, b);
    return (pa.major - pb.major) || (pa.minor - pb.minor) || (pb.patch - pa.patch);
  })[0];
}

function lowestSupportedVksForVkr(matrix, targetVkr, asOf) {
  const today = asOf || new Date().toISOString().slice(0, 10);
  const lc = (matrix.lifecycle || {}).vks || {};
  const supported = matrix.vks_vkr_compatibility
    .filter((e) => e.allowed_vkr.includes(targetVkr))
    .map((e) => e.vks)
    .filter((v) => {
      const entry = lc[v] || lc[vksMinorKey(v)];
      return entry ? (!entry.eos || entry.eos > today) : false;
    });
  if (!supported.length) return null;
  return supported.slice().sort((a, b) => {
    const pa = parseVks(a), pb = parseVks(b);
    if (!pa || !pb) return compareVks(a, b);
    return (pa.major - pb.major) || (pa.minor - pb.minor) || (pb.patch - pa.patch);
  })[0];
}

function compareVkr(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

function vkrMinor(vkr) { const p = vkr.split('.'); return `${p[0]}.${p[1]}`; }

function svSortKeyFull(matrix, v) {
  const order = allSvMinorsOrdered(matrix);
  const minor = parseSvMinor(v) || (/^v?(\d+\.\d+)$/.exec(v) || [])[1] || v;
  const mi = order.indexOf(minor);
  const patch = (/^v?\d+\.\d+\.(\d+)/.exec(v) || [])[1];
  const vmw = (/\+vmware\.(\d+)/.exec(v) || [])[1];
  const suffix = parseVscSuffix(v) || '';
  const suffixParts = suffix ? suffix.split('.').map((x) => Number(x) || 0) : [];
  return [
    mi === -1 ? Number.MAX_SAFE_INTEGER : mi,
    patch === undefined ? -1 : Number(patch),
    vmw === undefined ? -1 : Number(vmw),
    ...[0, 1, 2, 3].map((i) => (suffixParts[i] === undefined ? -1 : suffixParts[i])),
  ];
}

function compareSv(matrix, a, b) {
  const ka = svSortKeyFull(matrix, a), kb = svSortKeyFull(matrix, b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return 0;
}

/**
 * Resolves a bare Supervisor patch (e.g. "1.33.9") to the exact full build
 * shipped by `vc` — same patch, `vc`'s own -vsc suffix.
 */
function exactSvBuildForPatch(matrix, vc, barePatch) {
  const entry = matrix.vc_sv_matrix[vc];
  const suffix = entry && entry.sv_version_suffix;
  if (!suffix) return null;
  const patchMatch = /^v?(\d+\.\d+\.\d+)/.exec(barePatch);
  if (!patchMatch) return null;
  const token = `-vsc${suffix}`;
  const candidates = Object.keys(matrix.sv_vc_compatibility).filter(
    (b) => b.endsWith(token) && b.startsWith(`v${patchMatch[1]}+`)
  );
  if (!candidates.length) return null;
  return candidates.slice().sort((a, b) => compareSv(matrix, a, b)).pop();
}

/**
 * Resolves a bare patch to a full build on `vc`: the build `vc` itself ships, else the async
 * (FDS) build it can install, lowest lineage first (rule 15d). Null when neither exists.
 */
function resolveBarePatchBuild(matrix, vc, barePatch) {
  const exact = exactSvBuildForPatch(matrix, vc, barePatch);
  if (exact) return exact;
  const m = /^v?(\d+\.\d+\.\d+)/.exec(barePatch);
  if (!m || !isUnifiedDepotVc(matrix, vc)) return null;
  const order = vcOrder(matrix);
  const lineageIdx = (b) => {
    const i = order.indexOf(parseVscSuffix(b) || '');
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const candidates = Object.keys(matrix.sv_vc_compatibility || {}).filter(
    (b) => b.startsWith(`v${m[1]}+`) && svBuildInstallableOn(matrix, vc, b)
  );
  if (!candidates.length) return null;
  return candidates.slice().sort(
    (a, b) => lineageIdx(a) - lineageIdx(b) || compareSv(matrix, b, a)
  )[0];
}

function embeddedSvBuildForMinor(matrix, vc, minor) {
  const entry = matrix.vc_sv_matrix[vc];
  const suffix = entry && entry.sv_version_suffix;
  if (!suffix) return null;
  const token = `-vsc${suffix}`;
  const candidates = Object.keys(matrix.sv_vc_compatibility).filter(
    (b) => b.endsWith(token) && parseSvMinor(b) === minor
  );
  if (!candidates.length) return null;
  return candidates.slice().sort((a, b) => compareSv(matrix, a, b)).pop();
}

function asyncSvBuildForMinor(matrix, vc, minor) {
  if (!isUnifiedDepotVc(matrix, vc)) return null;
  const order = vcOrder(matrix);
  const candidates = Object.keys(matrix.sv_vc_compatibility || {}).filter(
    (b) => parseSvMinor(b) === minor && svBuildInstallableOn(matrix, vc, b)
  );
  if (!candidates.length) return null;
  const lineageIdx = (b) => {
    const i = order.indexOf(parseVscSuffix(b) || '');
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return candidates.slice().sort(
    (a, b) => lineageIdx(a) - lineageIdx(b) || compareSv(matrix, a, b)
  )[0];
}

function displaySvBuildForMinor(matrix, vc, minor) {
  return embeddedSvBuildForMinor(matrix, vc, minor) || asyncSvBuildForMinor(matrix, vc, minor);
}

// Rule 5c: the builds a Supervisor step from `running` may land on in `minor` on vCenter `vc` -
// only upgrades sv_upgrade_graph lists from that exact build, installable there (rule 5b), and
// never an older lineage than the one running. Preference follows rule 15d: the vCenter's own
// build, else the lowest qualifying lineage, latest patch.
function svUpgradeTargets(matrix, running, vc, minor) {
  const from = parseVscSuffix(running);
  const candidates = ((matrix.sv_upgrade_graph || {})[running] || []).filter((b) =>
    parseSvMinor(b) === minor && svBuildInstallableOn(matrix, vc, b) &&
    (!from || compareLineage(matrix, parseVscSuffix(b), from) >= 0));
  const own = displaySvBuildForMinor(matrix, vc, minor);
  return candidates.sort((a, b) => (b === own) - (a === own) ||
    compareLineage(matrix, parseVscSuffix(a), parseVscSuffix(b)) || compareSv(matrix, b, a));
}

// Rule 5c: every Supervisor step between exact builds must be an upgrade sv_upgrade_graph lists -
// including a same-version move onto another lineage, which the graph never lists, so it is never
// planned - must not move to an older lineage, and must land on a build the vCenter in effect can
// install (rule 5b).
function illegalSvStep(matrix, phases, startingVc) {
  let vc = startingVc;
  for (const ph of phases) {
    if (ph.phase === 'vCenter') { vc = ph.to; continue; }
    if (ph.phase !== 'Supervisor' || !String(ph.from).includes('-vsc') || !String(ph.to).includes('-vsc')) continue;
    const listed = ((matrix.sv_upgrade_graph || {})[ph.from] || []).includes(ph.to);
    if (compareLineage(matrix, parseVscSuffix(ph.to), parseVscSuffix(ph.from)) < 0) {
      return `Supervisor ${ph.to} is an older lineage than ${ph.from}, which is already running. ` +
        `A Supervisor upgrade never moves to a build shipped before the one in place.`;
    }
    if (!listed) {
      return `The Supervisor upgrade interop data lists no upgrade from ${ph.from} to ${ph.to}, ` +
        `so that step cannot be planned.`;
    }
    if (!svBuildInstallableOn(matrix, vc, ph.to)) {
      return `Supervisor ${ph.to} cannot be installed on vCenter ${vc}, where this step would run.`;
    }
  }
  return null;
}

function resolveDisplaySvBuilds(matrix, phases, startingVc, startingSvFull) {
  let vc = startingVc;
  const firstSv = phases.find((p) => p.phase === 'Supervisor');
  let lastBuild = startingSvFull || (firstSv && displaySvBuildForMinor(matrix, startingVc, svMinorOf(firstSv.from))) || null;
  for (const ph of phases) {
    if (ph.phase === 'vCenter') { vc = ph.to; continue; }
    if (ph.phase !== 'Supervisor') continue;
    if (!ph.landedOnVc) ph.landedOnVc = vc;
    if (ph.from && /^\d+\.\d+$/.test(ph.from)) {
      ph.from = (lastBuild && svMinorOf(lastBuild) === ph.from) ? lastBuild : (displaySvBuildForMinor(matrix, vc, ph.from) || ph.from);
    }
    if (ph.to && /^\d+\.\d+$/.test(ph.to)) {
      const exact = lastBuild && lastBuild.includes('-vsc');
      const build = exact ? svUpgradeTargets(matrix, lastBuild, vc, ph.to)[0] : displaySvBuildForMinor(matrix, vc, ph.to);
      if (build) ph.to = build;
      else if (exact) ph.noUpgradeEdge = true;
    }
    lastBuild = ph.to;
  }
}

function findEarliestVksStrand(matrix, vcPhases, startingVc, startingMinor, startingVks, namedTargetVks, fromIndex, currentVkr, startingSvFull) {
  let vc = startingVc, minor = startingMinor;
  let prevBuild = startingSvFull || embeddedSvBuildForMinor(matrix, vc, minor) || minor;
  let prevMinor = minor;
  const skipBefore = fromIndex || 0;
  const pickVks = (candidates) => {
    const vkrSafe = currentVkr ? candidates.filter((v) => vkrAllowedForVks(matrix, v).has(currentVkr)) : candidates;
    const targetUnreachableHere = namedTargetVks && compareVks(namedTargetVks, candidates[0]) < 0;
    return (namedTargetVks && candidates.includes(namedTargetVks))
      ? namedTargetVks
      : targetUnreachableHere
        ? candidates[0]
        : (vkrSafe.length ? vkrSafe[vkrSafe.length - 1] : (candidates[candidates.length - 1] || null));
  };
  // A step that strands the running VKS must not run while still on it, so the bump goes
  // before that step, onto a VKS both the build in effect before the step and the build it
  // lands on allow — every intermediate state stays compatible (rule 13c). Only when no such
  // bridging VKS exists does the bump fall back to the stranded build's own allowed list:
  // after the step for the overlap hop vCenter itself requires (it is unconditional and cannot
  // be deferred), before it for anything else.
  const mustLeadReasons = new Set(['overlap-required']);
  const checkAt = (i, ph) => {
    // A vCenter hop does not change the running Supervisor. Inspect the actual
    // resolved destination on Supervisor steps, including async builds.
    const build = ph.phase === 'Supervisor' ? ph.to : prevBuild;
    const stepFromBuild = prevBuild, stepFromMinor = prevMinor;
    prevBuild = build; prevMinor = minor;
    if (i + 1 <= skipBefore) return null;
    if (vksAllowedForSvBuildOrMinor(matrix, build).has(startingVks)) return null;
    const candidates = [...vksAllowedForSvBuildOrMinor(matrix, build)]
      .filter((v) => compareVks(v, startingVks) >= 0).sort(compareVks);
    const fromAllowed = vksAllowedForSvBuildOrMinor(matrix, stepFromBuild);
    const bridging = candidates.filter((v) => fromAllowed.has(v));
    if (bridging.length) {
      return { index: i, minor, insertMinor: stepFromMinor, chosenVks: pickVks(bridging) };
    }
    const after = mustLeadReasons.has(ph.reason);
    return { index: after ? i + 1 : i, minor, insertMinor: after ? minor : stepFromMinor, chosenVks: pickVks(candidates) };
  };
  for (let i = 0; i < vcPhases.length; i++) {
    const ph = vcPhases[i];
    if (ph.phase === 'vCenter') { vc = ph.to; const r = checkAt(i, ph); if (r) return r; }
    else if (ph.phase === 'Supervisor') { minor = svMinorOf(ph.to) || minor; const r = checkAt(i, ph); if (r) return r; }
  }
  return null;
}

function vksMinorKey(vks) {
  const p = parseVks(vks);
  return p ? `${p.major}.${p.minor}` : vks;
}

function minRequiredVkrForVks(matrix, targetVKS, currentVKr, targetVkrCap) {
  let allowed = [...vkrAllowedForVks(matrix, targetVKS)].filter((v) => !isVkrSuperseded(matrix, v));
  if (!allowed.length) return null;
  if (currentVKr) {
    const forward = allowed.filter((v) => compareVkr(v, currentVKr) > 0);
    if (forward.length) allowed = forward;
  }
  if (targetVkrCap && allowed.includes(targetVkrCap)) {
    const capped = allowed.filter((v) => compareVkr(v, targetVkrCap) <= 0);
    if (capped.length) allowed = capped;
  }
  const floorMinor = vkrMinor(allowed.slice().sort(compareVkr)[0]);
  const inFloor = allowed.filter((v) => vkrMinor(v) === floorMinor).sort(compareVkr);
  return inFloor[inFloor.length - 1];
}

function resolveTargetVkr(matrix, targetVKS, targetVKr, currentVKr) {
  if (targetVKr) return { vkr: targetVKr, forced: false };
  const allowed = vkrAllowedForVks(matrix, targetVKS);
  if (allowed.has(currentVKr)) return { vkr: currentVKr, forced: false };
  const floor = minRequiredVkrForVks(matrix, targetVKS, currentVKr);
  return { vkr: floor || currentVKr, forced: true };
}

function pathScore(c) {
  return [c.vcHops, c.vcMajorCrossings, c.svHops, -(c.svPatchRecency || 0), c.vcHops + c.svHops];
}

function compareByScore(a, b) {
  const sa = pathScore(a), sb = pathScore(b);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i];
  return 0;
}

function countMajorCrossings(path) {
  let n = 0;
  for (let i = 1; i < path.length; i++) if (vcFamily(path[i - 1]) === '8.x' && vcFamily(path[i]) === '9.x') n += 1;
  return n;
}

function pickVcEndpoint(matrix, fromVc, currentSvMinor, requiredMinors, allow9x, require9x, vcAllowed) {
  const permitted = (vc) => !vcAllowed || vcAllowed(vc);
  const currentEntry = matrix.vc_sv_matrix[fromVc];
  const currentOverlap = permitted(fromVc)
    ? currentEntry.supported_sv_k8s_minors.filter((m) => requiredMinors.has(m))
    : [];
  if (permitted(fromVc)) {
    // Rule 5a/5b: on a 9.1+ vCenter a minor it does not ship is still installable async.
    for (const m of requiredMinors) {
      if (!currentOverlap.includes(m) && svMinorInstallableOn(matrix, fromVc, m)) currentOverlap.push(m);
    }
  }
  if (currentOverlap.length && !(require9x && vcFamily(fromVc) !== '9.x')) {
    let landingMinor = currentOverlap[0];
    let bestSvHops = svMinorDistance(matrix, currentSvMinor, landingMinor);
    for (const m of currentOverlap.slice(1)) {
      const d = svMinorDistance(matrix, currentSvMinor, m);
      if (d < bestSvHops) { bestSvHops = d; landingMinor = m; }
    }
    return {
      vc: fromVc, hops: 0, vcHops: 0, vcMajorCrossings: 0, path: [fromVc], landingMinor,
      svHops: bestSvHops, svPatchRecency: svMinorDistance(matrix, currentSvMinor, landingMinor)
    };
  }
  const reachable = vcReachable(matrix, fromVc, allow9x);
  let best = null;
  for (const [vc, info] of reachable) {
    if (require9x && vcFamily(vc) !== '9.x') continue;
    if (!permitted(vc)) continue;
    const entry = matrix.vc_sv_matrix[vc];
    const overlap = entry.supported_sv_k8s_minors.filter((m) => requiredMinors.has(m));
    for (const m of requiredMinors) {
      if (!overlap.includes(m) && svMinorInstallableOn(matrix, vc, m)) overlap.push(m);
    }
    if (!overlap.length) continue;
    let landingMinor = overlap[0];
    let bestSvHops = svMinorDistance(matrix, currentSvMinor, landingMinor);
    for (const m of overlap.slice(1)) {
      const d = svMinorDistance(matrix, currentSvMinor, m);
      if (d < bestSvHops) { bestSvHops = d; landingMinor = m; }
    }
    const candidate = {
      vc, hops: info.hops, vcHops: info.hops, vcMajorCrossings: countMajorCrossings(info.path),
      path: info.path, landingMinor, svHops: bestSvHops, svPatchRecency: allSvMinorsOrdered(matrix).indexOf(landingMinor)
    };
    if (!best || compareByScore(candidate, best) < 0) best = candidate;
  }
  return best;
}

function walkVcTrajectory(matrix, path, startingSvMinor, preferMinor, preferReason, vcReason) {
  const phases = [];
  let svMinor = startingSvMinor;
  for (let i = 1; i < path.length; i++) {
    const fromVc = path[i - 1], toVc = path[i];
    const toEntry = matrix.vc_sv_matrix[toVc];
    const overlaps = toEntry.supported_sv_k8s_minors.includes(svMinor);
    const crossesMajor = vcFamily(fromVc) === '8.x' && vcFamily(toVc) === '9.x';
    const isMinorBump9x = vcFamily(fromVc) === '9.x' && vcFamily(toVc) === '9.x';

    // A named target is only "asked for" on the last hop; earlier hops are intermediates.
    const hopReason = vcReason === 'vc-target-requested' && i < path.length - 1
      ? 'vc-intermediate-to-target' : vcReason;
    const vcPhase = () => ({
      phase: 'vCenter', from: fromVc, to: toVc,
      ...(hopReason ? { reason: hopReason } : {})
    });
    // Every vCenter hop needs the running Supervisor minor inside the target's window (rule 6);
    // the planner never relies on a vCenter upgrade auto-upgrading Supervisor.
    if (!overlaps) {
      const landing = toEntry.supported_sv_k8s_minors.find((m) => svMinorDistance(matrix, svMinor, m) >= 0) ||
        toEntry.supported_sv_k8s_minors[0];
      phases.push(...expandSvMinorSteps(matrix, svMinor, landing, 'overlap-required'));
      phases.push(vcPhase());
      svMinor = landing;
    } else {
      phases.push(vcPhase());
    }

    if ((crossesMajor || isMinorBump9x) && preferMinor &&
      toEntry.supported_sv_k8s_minors.includes(preferMinor) &&
      svMinorDistance(matrix, svMinor, preferMinor) > 0) {
      phases.push(...expandSvMinorSteps(matrix, svMinor, preferMinor, preferReason || 'target-sv-requested'));
      svMinor = preferMinor;
    }
  }
  return { phases, endingSvMinor: svMinor };
}

function ensureVcSupportsSvMinor(matrix, ctx, svMinor, phases) {
  return climbSvTo(matrix, ctx, svMinor, phases, 'target-requires-newer-sv');
}

function svMinorInstallableOn(matrix, vc, minor) {
  const entry = matrix.vc_sv_matrix[vc];
  if (entry && entry.supported_sv_k8s_minors.includes(minor)) return true;
  return Object.keys(matrix.sv_vc_compatibility || {}).some(
    (build) => parseSvMinor(build) === minor && svBuildInstallableOn(matrix, vc, build));
}

function svBuildInstallableOn(matrix, vc, build) {
  const entry = matrix.vc_sv_matrix[vc];
  if (!entry) return false;
  const compat = (matrix.sv_vc_compatibility || {})[build];
  if (!compat || !compat.includes(vc)) return false;
  const suffix = parseVscSuffix(build);
  if (suffix === entry.sv_version_suffix) return true;
  // Rule 5b: sv_vc_compatibility says where a build can keep running after a vCenter upgrade,
  // not what can be installed there. A build shipped with an older vCenter is never installed on
  // a newer one (v1.31.6-vsc9.0.2.0 on 9.1.0.0).
  if (!suffix || compareLineage(matrix, suffix, entry.sv_version_suffix) < 0) return false;
  // A Supervisor-only release installs wherever it is compatible.
  if (isSupervisorOnlyLineage(matrix, suffix)) return true;
  // A later vCenter's build arrives only via FDS, which exists from 9.1 and stocks only builds
  // stamped by a 9.1+ vCenter.
  return isUnifiedDepotVc(matrix, vc) && svBuildAvailableInFds(matrix, build);
}

/**
 * FDS only stocks Supervisor builds whose own -vsc suffix comes from a
 * unified-depot vCenter (>= 9.1.0.0). A build stamped with a pre-9.1 suffix
 * (e.g. "-vsc0.1.15") was never staged there and can't be async-fetched.
 */
function svBuildAvailableInFds(matrix, build) {
  const ownerVc = deriveVcFromSv(matrix, build);
  return !!ownerVc && isUnifiedDepotVc(matrix, ownerVc);
}

function needsAsyncStaging(matrix, vc, build) {
  const entry = matrix.vc_sv_matrix[vc];
  if (!entry || !isUnifiedDepotVc(matrix, vc)) return false;
  return parseVscSuffix(build) !== entry.sv_version_suffix;
}

function climbSvTo(matrix, ctx, targetMinor, phases, reason, recommendedTo) {
  const order = allSvMinorsOrdered(matrix);
  const targetIdx = order.indexOf(targetMinor);
  if (targetIdx === -1) return false;
  let guard = 0;

  while (svMinorDistance(matrix, ctx.svMinor, targetMinor) > 0) {
    if (++guard > 32) return false;

    const shipped = matrix.vc_sv_matrix[ctx.vc].supported_sv_k8s_minors;
    const candidates = order
      .filter((m) => order.indexOf(m) <= targetIdx &&
        svMinorDistance(matrix, ctx.svMinor, m) >= 0 &&
        svMinorInstallableOn(matrix, ctx.vc, m))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const topHere = candidates.length ? candidates[candidates.length - 1] : null;

    if (topHere && topHere !== ctx.svMinor) {
      const asyncReach = !shipped.includes(topHere);
      phases.push(...expandSvMinorSteps(matrix, ctx.svMinor, topHere,
        asyncReach ? 'async-sv-upgrade' : reason));
      ctx.svMinor = topHere;
      if (ctx.svMinor === targetMinor) return true;
    }

    let best = null;
    if (recommendedTo) {
      const nextVc = recommendedNextVcHop(matrix, ctx.vc, recommendedTo);
      const info = nextVc ? vcReachable(matrix, ctx.vc, ctx.allow9x).get(nextVc) : null;
      if (info) best = { vc: nextVc, path: info.path };
    }
    if (!best) {
      const reachable = vcReachable(matrix, ctx.vc, ctx.allow9x);
      for (const [vc, info] of reachable) {
        const entry = matrix.vc_sv_matrix[vc];
        const sup = entry.supported_sv_k8s_minors;
        if (!sup.includes(ctx.svMinor)) continue;

        const top = order
          .filter((m) => order.indexOf(m) <= targetIdx && svMinorInstallableOn(matrix, vc, m))
          .reduce((a, m) => (a === null || order.indexOf(m) > order.indexOf(a) ? m : a), null);
        if (!top || order.indexOf(top) <= order.indexOf(ctx.svMinor)) continue;

        const ceiling = sup.reduce((a, m) => (order.indexOf(m) > order.indexOf(a) ? m : a), sup[0]);
        const score = [-order.indexOf(top), info.hops, -order.indexOf(ceiling)];
        const better = !best || score[0] < best.score[0] ||
          (score[0] === best.score[0] && score[1] < best.score[1]) ||
          (score[0] === best.score[0] && score[1] === best.score[1] && score[2] < best.score[2]);
        if (better) best = { vc, path: info.path, score };
      }
    }
    if (!best) return false;

    const walked = walkVcTrajectory(matrix, best.path, ctx.svMinor, null, null, 'vc-enables-sv-climb');
    phases.push(...walked.phases);
    ctx.vc = best.vc;
    if (svMinorDistance(matrix, ctx.svMinor, walked.endingSvMinor) > 0) ctx.svMinor = walked.endingSvMinor;
  }
  return true;
}

function ensureSvSupportsVks(matrix, svMinor, vks, phases, reason, ctx) {
  if (vksAllowedForSvMinor(matrix, svMinor).has(vks)) return svMinor;
  const nextMinor = allSvMinorsOrdered(matrix).find(
    (m) => svMinorDistance(matrix, svMinor, m) > 0 && vksAllowedForSvMinor(matrix, m).has(vks)
  );
  if (!nextMinor) return null;

  if (ctx) {
    ctx.svMinor = svMinor;
    if (!ensureVcSupportsSvMinor(matrix, ctx, nextMinor, phases)) return null;
    svMinor = ctx.svMinor;
    if (svMinorDistance(matrix, svMinor, nextMinor) === 0) return svMinor;
  }

  phases.push(...expandSvMinorSteps(matrix, svMinor, nextMinor, reason));
  if (ctx) ctx.svMinor = nextMinor;
  return nextMinor;
}

function buildVkrWalkGraph(matrix) {
  const walkGraph = {};
  for (const [from, tos] of Object.entries(matrix.vkr_upgrade_graph)) {
    walkGraph[from] = tos.filter((t) => !isVkrSuperseded(matrix, t));
  }
  return walkGraph;
}

function rankVkrCandidates(list) {
  return list.slice().sort((x, y) => {
    const xm = vkrMinor(x), ym = vkrMinor(y);
    if (xm !== ym) return compareVkr(`${xm}.0`, `${ym}.0`);
    return compareVkr(y, x);
  })[0];
}

function pickNextVkr(matrix, walkGraph, cursor, targetVkr, vks) {
  let viable = (walkGraph[cursor] || []).filter(
    (n) => n === targetVkr || bfsWalk(walkGraph, n, (x) => x === targetVkr)
  );
  if (!viable.length) return null;
  if (vkrMinor(targetVkr) !== vkrMinor(cursor)) {
    const advancing = viable.filter((n) => vkrMinor(n) !== vkrMinor(cursor));
    if (advancing.length) viable = advancing;
  }
  const allowedNow = vkrAllowedForVks(matrix, vks);
  return rankVkrCandidates(viable.filter((n) => allowedNow.has(n))) || rankVkrCandidates(viable);
}

function illegalLegacyVkrHop(matrix, from, to) {
  return matrix.vkr_type[from] === 'non-legacy' && matrix.vkr_type[to] === 'legacy'
    ? `Illegal hop ${from} (non-legacy) -> ${to} (legacy)` : null;
}

function climbVkrInterleaved(matrix, walkGraph, fromVkr, toVkr, fromVks, ceilingVks, ctx, svMinor, reason) {
  const phases = [];
  let cursor = fromVkr, vks = fromVks, minor = svMinor, guard = 0;
  while (cursor !== toVkr) {
    if (++guard > 64) return { ok: false, reason: `VKr catch-up ${fromVkr} -> ${toVkr} failed to converge` };
    const next = pickNextVkr(matrix, walkGraph, cursor, toVkr, vks);
    if (!next) return { ok: false, reason: `No path from VKr ${cursor} to ${toVkr}` };
    const illegal = illegalLegacyVkrHop(matrix, cursor, next);
    if (illegal) return { ok: false, reason: illegal };
    if (!vkrAllowedForVks(matrix, vks).has(next)) {
      let climb = lowestSufficientVks(matrix, [cursor, next], vks, ceilingVks);
      if (!climb && isVkrSuperseded(matrix, cursor)) {
        const sibling = liveSiblingForSupersededVkr(matrix, vks, cursor);
        if (sibling) {
          phases.push({ phase: 'VKr', from: cursor, to: sibling, reason: 'leave-superseded-vkr' });
          cursor = sibling;
          continue;
        }
      }
      if (!climb) climb = lowestSufficientVks(matrix, [next], vks, ceilingVks);
      if (!climb) {
        return { ok: false, reason: `VKr ${next} is not compatible with any VKS at or below ${ceilingVks} that is also compatible with the current VKr ${cursor} (stuck on ${vks})` };
      }
      const vksWalk = walkVksWithSv(matrix, vks, climb, minor, phases,
        reason === 'vks-forces-vkr-floor' ? 'vks-enables-vkr-climb' : reason, reason, ctx);
      if (!vksWalk.ok) return { ok: false, reason: vksWalk.reason };
      minor = vksWalk.svMinor;
      vks = climb;
    }
    phases.push({ phase: 'VKr', from: cursor, to: next, ...(reason ? { reason } : {}) });
    cursor = next;
  }
  return { ok: true, phases, endVkr: cursor, endVks: vks, endSvMinor: minor };
}

function applyVksHop(matrix, opts) {
  const { toVks, svMinor, vkr, walkGraph, phases, reason, fromVks } = opts;
  const vksReason = opts.vksReason || reason;
  let landedVkr = vkr;
  let vks = fromVks;
  let minor = svMinor;
  if (vkr && !vkrAllowedForVks(matrix, toVks).has(vkr)) {
    const floor = minRequiredVkrForVks(matrix, toVks, vkr, opts.targetVkrCap);
    if (!floor) {
      return { ok: false, reason: `VKS ${toVks} is compatible with no non-superseded VKr reachable from ${vkr}; upgrading to it would strand the workload cluster` };
    }
    const climb = climbVkrInterleaved(matrix, walkGraph, vkr, floor, vks, toVks, opts.ctx, minor, 'vks-forces-vkr-floor');
    if (!climb.ok) return { ok: false, reason: climb.reason };
    phases.push(...climb.phases);
    landedVkr = climb.endVkr;
    vks = climb.endVks;
    minor = climb.endSvMinor;
  }
  const vksWalk = walkVksWithSv(matrix, vks, toVks, minor, phases, vksReason, reason, opts.ctx);
  if (!vksWalk.ok) return { ok: false, reason: vksWalk.reason };
  return { ok: true, svMinor: vksWalk.svMinor, vkr: landedVkr };
}

// Walks VKS from -> to, moving Supervisor forward first wherever the next VKS hop needs a newer
// minor than the one running: a VKS version cannot be installed on a Supervisor that does not
// allow it. The bump goes ahead of the hop only when the new minor still allows the VKS running
// before it; if not, no ordering keeps both layers compatible and the bump follows the hop.
function walkVksWithSv(matrix, from, to, svMinor, phases, vksReason, svReason, ctx) {
  if (from === to) return { ok: true, svMinor };
  const hit = bfsWalk(matrix.vks_upgrade_graph, from, (n) => n === to);
  if (!hit) return { ok: false, reason: `No path from VKS ${from} to ${to} in vks_upgrade_graph` };
  let minor = svMinor;
  for (let i = 0; i < hit.path.length - 1; i++) {
    const a = hit.path[i], b = hit.path[i + 1];
    const hop = { phase: 'VKS', from: a, to: b, ...(vksReason ? { reason: vksReason } : {}) };
    const needed = vksAllowedForSvMinor(matrix, minor).has(b) ? null : allSvMinorsOrdered(matrix).find(
      (m) => svMinorDistance(matrix, minor, m) > 0 && vksAllowedForSvMinor(matrix, m).has(b));
    if (needed && vksAllowedForSvMinor(matrix, needed).has(a)) {
      const bumped = ensureSvSupportsVks(matrix, minor, b, phases, svReason, ctx);
      if (bumped === null) return { ok: false, reason: `No Supervisor minor reachable from ${minor} is compatible with VKS ${b}` };
      minor = bumped;
      phases.push(hop);
      continue;
    }
    phases.push(hop);
    const bumped = ensureSvSupportsVks(matrix, minor, b, phases, svReason, ctx);
    if (bumped === null) return { ok: false, reason: `No Supervisor minor reachable from ${minor} is compatible with VKS ${b}` };
    minor = bumped;
  }
  return { ok: true, svMinor: minor };
}

function walkVksSegment(matrix, from, to, reason) {
  if (from === to) return { ok: true, phases: [] };
  const hit = bfsWalk(matrix.vks_upgrade_graph, from, (n) => n === to);
  if (!hit) return { ok: false, reason: `No path from VKS ${from} to ${to} in vks_upgrade_graph` };
  const phases = [];
  for (let i = 0; i < hit.path.length - 1; i++) {
    phases.push({ phase: 'VKS', from: hit.path[i], to: hit.path[i + 1], ...(reason ? { reason } : {}) });
  }
  return { ok: true, phases };
}

function walkVkrTrajectory(matrix, currentVkr, targetVkr, svMinorAfterVc, targetVKS, currentVKS, ctx,
  targetVksReason) {
  const phases = [];
  let svMinor = svMinorAfterVc, cursor = currentVkr, vks = currentVKS;
  const walkGraph = buildVkrWalkGraph(matrix);
  let guard = 0;
  while (cursor !== targetVkr) {
    if (++guard > 64) return { unreachable: true, reason: 'VKr walk failed to converge', phases };
    const nextVkr = pickNextVkr(matrix, walkGraph, cursor, targetVkr, vks);
    if (!nextVkr) return { unreachable: true, reason: `No path from VKr ${cursor} to ${targetVkr}`, phases };
    const illegal = illegalLegacyVkrHop(matrix, cursor, nextVkr);
    if (illegal) return { unreachable: true, reason: illegal, phases };
    if (!vkrAllowedForVks(matrix, vks).has(nextVkr)) {
      let climb = lowestSufficientVks(matrix, [cursor, nextVkr], vks, targetVKS);
      if (!climb && isVkrSuperseded(matrix, cursor)) {
        const by = matrix.vkr_status[cursor].by;
        const sibling = liveSiblingForSupersededVkr(matrix, vks, cursor);
        if (!sibling) {
          return { unreachable: true, reason: `VKr ${cursor} is superseded by ${by}, and VKS ${vks} allows no live release forward of it, so there is no way off ${cursor} on the VKS you are running. This needs manual remediation before an upgrade plan applies.`, phases };
        }
        phases.push({ phase: 'VKr', from: cursor, to: sibling, reason: 'leave-superseded-vkr' });
        cursor = sibling;
        continue;
      }
      if (!climb) {
        climb = lowestSufficientVks(matrix, [nextVkr], vks, targetVKS);
      }
      if (!climb) {
        const bound = targetVKS ? ` at or below the target VKS ${targetVKS}` : '';
        return { unreachable: true, reason: `VKr ${nextVkr} is not compatible with any VKS${bound} that is also compatible with the current VKr ${cursor} (stuck on ${vks})`, phases };
      }
      const hop = applyVksHop(matrix, {
        toVks: climb, svMinor, vkr: cursor, walkGraph, phases,
        reason: 'vkr-forced', ctx, targetVkrCap: targetVkr, fromVks: vks
      });
      if (!hop.ok) return { unreachable: true, reason: hop.reason, phases };
      svMinor = hop.svMinor; cursor = hop.vkr;
      vks = climb;
      if (cursor === targetVkr) break;
      if (!vkrAllowedForVks(matrix, vks).has(nextVkr)) continue;
    }
    phases.push({ phase: 'VKr', from: cursor, to: nextVkr });
    cursor = nextVkr;
  }
  if (targetVKS && compareVks(vks, targetVKS) < 0) {
    const hop = applyVksHop(matrix, {
      toVks: targetVKS, svMinor, vkr: cursor, walkGraph, phases,
      reason: 'vks-requires-newer-sv',
      vksReason: targetVksReason || 'target-vks-requested',
      ctx, targetVkrCap: targetVkr, fromVks: vks
    });
    if (!hop.ok) return { unreachable: true, reason: hop.reason, phases };
    svMinor = hop.svMinor; cursor = hop.vkr;
    vks = targetVKS;
  }
  return { unreachable: false, phases, endingSvMinor: svMinor, endingVks: vks, endingVkr: cursor };
}

function annotateVkrPhases(matrix, phases, startingVks) {
  let vks = startingVks;
  for (const p of phases) {
    if (p.phase === 'VKS') { vks = p.to; continue; }
    if (p.phase !== 'VKr' || !vks) continue;
    const allowed = [...vkrAllowedForVks(matrix, vks)];
    if (!allowed.length) continue;
    p.vksInEffect = vks;
    p.vksSupportsVkrUpTo = allowed.sort(compareVkr)[allowed.length - 1];
  }
}

function validateStartingState(matrix, s) {
  const errors = [];
  const { currentVC, currentVKS, currentVKr, svMinor, svFull, targetVKS, targetVKr } = s;

  if (currentVC && vcBefore8u3(matrix, currentVC)) {
    const named = [];
    if (currentVKS) named.push(`current VKS ${currentVKS}`);
    if (currentVKr) named.push(`current VKr ${currentVKr}`);
    if (targetVKS) named.push(`target VKS ${targetVKS}`);
    if (targetVKr) named.push(`target VKr ${targetVKr}`);
    if (named.length) {
      errors.push({
        kind: 'vks-before-8.0u3',
        message:
          `Invalid: vCenter ${currentVC} is before 8.0U3, and VKS/VKr require 8.0U3 or newer — ` +
          `VKS 3.0.0 (the first release) shipped with it, so no vCenter before it can run VKS at ` +
          `all. Remove ${named.join(' and ')}, or move the current vCenter to 8.0U3 or later.`,
      });
    }
  }

  const vcEntry = currentVC ? matrix.vc_sv_matrix[currentVC] : null;
  // Pre-floor builds (e.g. v1.17.4-vsc0.0.1) carry no '+', so match them by lookup, not by build shape.
  const preFloorOnly = Boolean(svFull) && !(matrix.sv_vc_compatibility || {})[svFull] &&
    Boolean((matrix.sv_pre_floor_only || {})[svFull]);

  if (vcEntry && svMinor && !preFloorOnly && !vcEntry.supported_sv_k8s_minors.includes(svMinor)) {
    const window = vcEntry.supported_sv_k8s_minors;
    const order = allSvMinorsOrdered(matrix);
    const ahead = order.indexOf(svMinor) > order.indexOf(window[window.length - 1]);

    if (ahead) {
      errors.push({
        kind: 'sv-ahead-of-vc',
        message:
          `Invalid starting state: vCenter ${currentVC} is compatible with Supervisor Kubernetes ` +
          `${window.join(', ')}, but the current Supervisor is ${svFull || svMinor} (${svMinor}), ` +
          `which is newer than that window — check which vCenter build is actually running.`,
      });
    } else {
      errors.push({
        kind: 'sv-behind-vc',
        message:
          `Invalid starting state: vCenter ${currentVC} is compatible with Supervisor Kubernetes ` +
          `${window.join(', ')}, but the current Supervisor is ${svFull || svMinor} (${svMinor}), ` +
          `which is older than that window. Supervisor must be on at least ${window[0]} to run on ` +
          `${currentVC} — check which Supervisor and vCenter builds are actually running.`,
      });
    }
  }

  if (currentVC && svFull && (svFull.includes('+') || preFloorOnly) && matrix.sv_vc_compatibility) {
    const compatVcs = matrix.sv_vc_compatibility[svFull];
    const preFloor = (matrix.sv_pre_floor_only || {})[svFull];
    if (!compatVcs && preFloor) {
      errors.push({
        kind: 'sv-below-scope-floor',
        message:
          `Supervisor ${svFull} is compatible with vCenter ${preFloor.join(', ')}, all of which precede ` +
          `8.0U3. This planner starts at 8.0U3, because VKS 3.0.0 and later require it` +
          (currentVKS ? `, so a VKS version (${currentVKS}) cannot be running on this Supervisor` : '') +
          `. Nothing here needs a VKS upgrade plan.`,
      });
    } else if (!compatVcs) {
      errors.push({
        kind: 'sv-no-compatibility-data',
        message:
          `Invalid starting state: no vCenter compatibility is published for Supervisor ${svFull}, ` +
          `so it cannot be treated as running on ${currentVC}. Check the version string, or pick a ` +
          `build from the list.`,
      });
    } else if (!compatVcs.includes(currentVC)) {
      errors.push({
        kind: 'sv-not-compatible-with-vc',
        message:
          `Invalid starting state: Supervisor ${svFull} is not compatible with vCenter ${currentVC}. ` +
          `That build is compatible with ${compatVcs.join(', ')}. (Supervisor ships asynchronously from ` +
          `vCenter, so the build's own -vsc suffix does not determine where it can run - this list ` +
          `does.)`,
      });
    }
  }

  if (currentVKS && currentVKr) {
    const allowed = vkrAllowedForVks(matrix, currentVKS);
    if (allowed.size && !allowed.has(currentVKr)) {
      const sorted = [...allowed].sort(compareVkr);
      errors.push({
        kind: 'vkr-vs-vks',
        message:
          `Invalid starting state: VKS ${currentVKS} is not compatible with Kubernetes Release ` +
          `${currentVKr}. It is compatible with ${sorted[0]} through ${sorted[sorted.length - 1]}. ` +
          `A cluster on an incompatible release is already stranded, so it must be brought into ` +
          `range before an upgrade plan from this state means anything.`,
      });
    }
  }

  if (currentVKS && svMinor) {
    // Compatibility is published per Supervisor build, and builds of one minor differ (e.g.
    // v1.30.10...-vsc9.0.2.0 dropped VKS 3.0.0 while v1.30.10...-vsc0.1.12 still lists it). When
    // the exact build is known, judge against it, not the union over its whole minor.
    const exactBuild = svFull && matrix.sv_vks_compatibility.some((e) => e.sv_k8s === svFull);
    const allowedVks = exactBuild ? vksAllowedForSvBuildOrMinor(matrix, svFull) : vksAllowedForSvMinor(matrix, svMinor);
    if (allowedVks.size && !allowedVks.has(currentVKS)) {
      errors.push({
        kind: 'vks-vs-sv',
        message:
          `Invalid starting state: VKS ${currentVKS} is not compatible with Supervisor ` +
          `${exactBuild ? svFull : `Kubernetes ${svMinor}`}. That Supervisor is compatible with ` +
          `${[...allowedVks].sort(compareVks).join(', ')}.`,
      });
    }
  }

  return { errors };
}

/**
 * Spec rule 19: advisories for a destination whose minor has reached end-of-general-support.
 * UPDATED: Correctly triggers on and after the EoS date.
 */
function eosAdvisories(matrix, dest, asOf) {
  const lifecycle = matrix.lifecycle;
  if (!lifecycle) return [];
  const today = asOf || new Date().toISOString().slice(0, 10);
  const out = [];

  const vcTrainKey = (version) => {
    let best = null;
    for (const key of Object.keys(lifecycle.vc || {})) {
      if (version.startsWith(key) && (!best || key.length > best.length)) best = key;
    }
    return best;
  };

  const lookup = (kind, version) => {
    if (kind === 'vks') {
      const t = lifecycle.vks || {};
      return t[version] || t[vksMinorKey(version)] || null;
    }
    if (kind === 'vc') {
      const t = lifecycle.vc || {};
      return t[version] || t[vcTrainKey(version)] || null;
    }
    return (lifecycle.vkr_patch || {})[version] || (lifecycle.vkr || {})[vkrMinor(version)] || null;
  };

  const check = (kind, version) => {
    if (!version) return;
    const entry = lookup(kind, version);
    if (!entry || !entry.eos) return;
    if (entry.eos > today) return; // Surfaces on or after entry.eos
    const minor = kind === 'vkr' ? vkrMinor(version) : kind === 'vc' ? vcTrainKey(version) : vksMinorKey(version);
    const label = kind === 'vkr' ? 'VKr' : kind === 'vc' ? 'vCenter' : 'VKS';
    const action = kind === 'vkr' ? 'cluster' : kind === 'vc' ? 'vCenter' : 'VKS';
    out.push({
      kind,
      version,
      minor,
      eos: entry.eos,
      message: `${label} ${version} has reached End of Support on ` +
        `${entry.eos}. Broadcom will no longer provide security fixes or support. ` +
        `Plan a ${action} upgrade.`,
    });
  };

  check('vks', dest.vks);
  check('vkr', dest.vkr);
  check('vc', dest.vc);
  return out;
}

function walkToVc(matrix, fromVc, toVc, svMinor, allow9x, phases, preferMinor, preferReason, vcReason) {
  if (fromVc === toVc) return { ok: true, vc: fromVc, svMinor };

  const order = allSvMinorsOrdered(matrix);
  const tgtEntry = matrix.vc_sv_matrix[toVc];
  const prep = { vc: fromVc, svMinor, allow9x };
  const recommendedTo = toVc;

  if (!tgtEntry.supported_sv_k8s_minors.includes(svMinor)) {
    const need = tgtEntry.supported_sv_k8s_minors
      .filter((m) => svMinorDistance(matrix, svMinor, m) > 0)
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
    if (!need) {
      return { ok: false, reason: `vCenter ${toVc} requires Supervisor to already be on one of ${tgtEntry.supported_sv_k8s_minors.join(', ')} before the upgrade, and none of those is forward of the current ${svMinor}.` };
    }
    if (!climbSvTo(matrix, prep, need, phases, 'overlap-required', recommendedTo)) {
      return { ok: false, reason: `Cannot reach Supervisor ${need}, which vCenter ${toVc} requires before it will allow the upgrade.` };
    }
  }

  const reach = prep.vc === toVc ? { path: [toVc] } : resolveVcHopPath(matrix, prep.vc, toVc, allow9x);
  if (!reach) {
    return { ok: false, reason: `No legal vCenter upgrade path from ${prep.vc} to ${toVc} after the Supervisor prerequisites were met.` };
  }
  const walked = walkVcTrajectory(matrix, reach.path, prep.svMinor, preferMinor, preferReason, vcReason);
  phases.push(...walked.phases);
  return { ok: true, vc: toVc, svMinor: walked.endingSvMinor };
}

function vcBefore8u3(matrix, vc) {
  const order = vcOrder(matrix);
  const i = order.indexOf(vc);
  const floor = order.indexOf('8.0U3');
  return i !== -1 && floor !== -1 && i < floor;
}

function annotateTargetReached(matrix, phases, named, recommend) {
  const DEPTH = ['vCenter', 'Supervisor', 'VKS', 'VKr'];
  const targets = {
    vCenter: named.targetVC, Supervisor: named.targetSV, VKS: named.targetVKS, VKr: named.targetVKr,
  };
  const hit = (p, target) => p.to === target ||
    (p.phase === 'Supervisor' && parseSvMinor(p.to) === (parseSvMinor(target) || target));

  const reachedIdx = {};
  for (const layer of DEPTH) {
    if (!targets[layer]) continue;
    const idx = phases.map((p, i) => [p, i])
      .filter(([p]) => p.phase === layer && hit(p, targets[layer]))
      .map(([, i]) => i).pop();
    reachedIdx[layer] = idx === undefined ? -1 : idx;
  }

  // Rule 7 requires Supervisor to land on a build from the final vCenter's own train - a
  // condition on the END STATE, not a specific reason code, so it can be satisfied by a
  // dedicated sv-replatform-to-vc-build step or incidentally by an ordinary Supervisor step
  // (e.g. a sv-currency-default bump that already lands on the final train). It is the FIRST
  // Supervisor phase to satisfy the lineage check that matters, not the last: once satisfied,
  // any further Supervisor currency climbs on the same train are genuinely optional and must
  // not push the marker past the step that actually did the required work.
  const vcSteps = phases.filter((p) => p.phase === 'vCenter');
  let replatformIdx = -1;
  if (vcSteps.length) {
    // A build's -vsc suffix is a Supervisor lineage, not a vCenter name, so rank it by the first
    // vCenter that shipped that suffix. A suffix shared by several vCenters ranks as the earliest.
    const order = vcOrder(matrix);
    const lineageRank = (suffix) => order.findIndex((v) => matrix.vc_sv_matrix[v].sv_version_suffix === suffix);
    const finalVcEntry = matrix.vc_sv_matrix[vcSteps[vcSteps.length - 1].to];
    const finalRank = finalVcEntry ? lineageRank(finalVcEntry.sv_version_suffix) : -1;
    if (finalRank !== -1) {
      replatformIdx = phases.findIndex((p) => {
        if (p.phase !== 'Supervisor') return false;
        const rank = lineageRank(parseVscSuffix(p.to));
        return rank !== -1 && rank >= finalRank;
      });
    }
  }

  // The customer's request is only satisfied once EVERY named layer has landed, so the marker
  // sits at the latest of the named layers' landing steps (any combination of vCenter,
  // Supervisor, VKS and VKr), never at the first named layer to arrive.
  const layers = DEPTH.filter((k) => targets[k]);
  if (!layers.length || layers.some((k) => reachedIdx[k] === -1)) return;
  const shallowest = DEPTH.indexOf(layers[0]);
  if (layers[0] === 'VKr') return;

  let idx = Math.max(...layers.map((k) => reachedIdx[k]));
  const mustReplatform = replatformIdx !== -1 && replatformIdx > idx;
  if (mustReplatform) idx = replatformIdx;

  const joinList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  const requested = joinList(layers.map((k) => `${k} ${targets[k]}`));
  const subject = layers.length > 1 ? `Your requested targets (${requested}) are` : `Your requested ${requested} is`;

  const remaining = DEPTH.slice(shallowest + 1).filter((k) => !targets[k]);
  const after = phases.slice(idx + 1).filter((p) => remaining.includes(p.phase));
  if (!after.length && !mustReplatform) return;

  if (!recommend || mustReplatform) {
    phases[idx].targetReachedNote = `${subject} reached at this step.`;
    return;
  }

  const recommended = remaining.filter((k) => after.some((p) => p.phase === k));
  if (!recommended.length) return;
  phases[idx].targetReachedNote =
    `${subject} reached at this step. The steps that follow are our recommendation to bring ` +
    `${joinList(recommended)} to the latest version compatible with ${layers.length > 1 ? 'them' : targets[layers[0]]} — ` +
    `they are not required to reach ${layers.length > 1 ? 'your targets' : targets[layers[0]]}.`;
}

// Rule 23: known issue on the hop into a 9.1 release that predates the fix. Versions are compared
// numerically, not by vc_sv_matrix order (release-date based: 9.0.2.0100 sorts after 9.1.0.0).
const LCM_RESET_FIXED_IN = [9, 1, 1, 100];

function vcParts(vc, n) {
  const parts = (String(vc).match(/\d+/g) || []).slice(0, n).map(Number);
  while (parts.length < n) parts.push(0);
  return parts;
}

function cmpParts(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function lcmResetApplies(fromVc, toVc) {
  const from = vcParts(fromVc, 3);
  const fromOk = (from[0] === 8 && cmpParts(from, [8, 0, 3]) >= 0) || (from[0] === 9 && from[1] === 0);
  const to = vcParts(toVc, 4);
  return fromOk && cmpParts(to, [9, 1, 0, 0]) >= 0 && cmpParts(to, LCM_RESET_FIXED_IN) < 0;
}

function annotateTransitions(matrix, phases, currentVKS, hasWorkloadClusters = false) {
  for (const p of phases) {
    const notes = [];

    if (p.phase === 'VKS' && hasWorkloadClusters) {
      const allowed = [...vkrAllowedForVks(matrix, p.to)].sort(compareVkr);
      const dropped = [...vkrAllowedForVks(matrix, p.from)]
        .filter((v) => !allowed.includes(v)).sort(compareVkr);
      notes.push({
        kind: 'workload-vkr-precheck', required: true,
        allowed_vkr: allowed, no_longer_supported_vkr: dropped,
        text: `Required before this VKS step: check every workload cluster against VKS ${p.to}'s ` +
          'allowed Kubernetes Releases. This plan checks only the entered lowest VKr; higher ' +
          'clusters are not automatically validated.' +
          (dropped.length ? ` Releases no longer supported by this step: ${dropped.join(', ')}. ` +
            'Upgrade any affected clusters through supported releases on the current VKS before this step.' : '') +
          ' Do not apply this step until every cluster is compatible with the destination VKS.',
      });
    }

    if (p.phase === 'Supervisor') {
      notes.push({
        kind: 'avi-lb-compatibility',
        text: 'If using AVI Load Balancer, confirm the AVI release is compatible with this ' +
          'Supervisor build before upgrading: ' +
          'https://interopmatrix.broadcom.com/Interoperability?col=1795,&row=1378,&isHidePatch=true&isHideLegacyReleases=false',
      });
    }

    if (p.phase === 'Supervisor' && p.to && p.to.includes('-vsc') && p.landedOnVc &&
      needsAsyncStaging(matrix, p.landedOnVc, p.to)) {
      notes.push({
        kind: 'async-staging-fds',
        text: `vCenter ${p.landedOnVc} does not embed ${p.to}, so this is an async Supervisor ` +
          `upgrade: the build has to be staged before it can be applied. Configure FDS with ` +
          `this Supervisor build first.`,
      });
    }

    if (p.phase === 'vCenter' && vcBefore8u3(matrix, p.from) && !vcBefore8u3(matrix, p.to)) {
      const embedded = (matrix.vc_embedded_vks || {})[p.to];
      notes.push({
        kind: 'tkg-service-becomes-async',
        text: `Crossing from ${p.from} to ${p.to} migrates TKG Service from being embedded in ` +
          'Supervisor to an async Supervisor Service, which changes how it is versioned and ' +
          'upgraded from then on.' +
          (!currentVKS && embedded
            ? ` This step installs VKS ${embedded}, the version ${p.to} embeds by default.`
            : ''),
      });
    }

    if (p.phase === 'vCenter' && lcmResetApplies(p.from, p.to)) {
      notes.push({
        kind: 'lcm-reset-data-loss',
        text: 'A reset of the vSphere Lifecycle Manager database might cause data loss in the ' +
          'Supervisor. If the vSphere Lifecycle Manager database in your environment is reset ' +
          `before upgrading vCenter from ${p.from} to ${p.to}, the upgrade might cause data loss ` +
          'in the Supervisor. To avoid data loss, before this vCenter upgrade, check your ' +
          'environment and take mitigation steps, if necessary. See Broadcom knowledge base ' +
          'article 455737 for how to check if your environment is affected and for mitigation steps: ' +
          'https://knowledge.broadcom.com/external/article?articleNumber=455737',
      });
    }

    if (notes.length) p.transitionNotes = notes;
  }
}

// Validate the emitted actions, after exact-build resolution and finalization.
// Checking minor unions while planning cannot prove an async build is safe.
function replayPlanState(matrix, phases, initial) {
  const state = { ...initial };
  const fields = { vCenter: 'vc', Supervisor: 'sv', VKS: 'vks', VKr: 'vkr' };
  for (const [index, p] of phases.entries()) {
    const field = fields[p.phase];
    if (state[field] && p.from !== state[field]) {
      return { error: `Step ${index + 1} starts ${p.phase} at ${p.from}, but the running version is ${state[field]}.` };
    }
    state[field] = p.to;
    // A bare patch the customer picked that their vCenter never shipped stays unresolved (no -vsc
    // build), so there is no sv_vc_compatibility row to judge it by.
    const svVcRow = state.sv && matrix.sv_vc_compatibility[state.sv];
    if (svVcRow && !svVcRow.includes(state.vc)) {
      return { error: `Step ${index + 1} leaves Supervisor ${state.sv} incompatible with vCenter ${state.vc}.` };
    }
    if (state.sv && state.vks && !vksAllowedForSvBuildOrMinor(matrix, state.sv).has(state.vks)) {
      return { error: `Step ${index + 1} leaves VKS ${state.vks} incompatible with Supervisor ${state.sv}.` };
    }
    if (state.vks && state.vkr && !vkrAllowedForVks(matrix, state.vks).has(state.vkr)) {
      return { error: `Step ${index + 1} leaves VKr ${state.vkr} incompatible with VKS ${state.vks}.` };
    }
  }
  return { state };
}

function namedEndpointError(state, input) {
  const targets = { vc: input.targetVC, sv: input.targetSV, vks: input.targetVKS, vkr: input.targetVKr };
  const labels = { vc: 'vCenter', sv: 'Supervisor', vks: 'VKS', vkr: 'VKr' };
  for (const [field, target] of Object.entries(targets)) {
    if (!target) continue;
    let matches = state[field] === target;
    if (field === 'sv' && !target.includes('-vsc')) {
      const requested = target.replace(/^v/, '');
      matches = /^\d+\.\d+$/.test(requested)
        ? parseSvMinor(state.sv) === requested
        : (String(state.sv).match(/^v?(\d+\.\d+\.\d+)/) || [])[1] === requested;
    }
    if (!matches) {
      return `Target conflict: the upgrades required by your targets leave ${labels[field]} on ` +
        `${state[field]}, instead of your explicit target ${target}. Change the conflicting targets; ` +
        'an explicit endpoint cannot be replaced by a prerequisite or recommendation.';
    }
  }
  return null;
}

// Rule 14o/14p: what each unnamed target layer is disclosed as, read off the plan's own end state
// so the note never names a version the plan does not reach. With recommendations off, a newer
// compatible version is reported separately as not included, never as a target.
function describePathDefaults(matrix, o) {
  const assumedTargets = [], notIncluded = [];
  const svSteps = o.phases.filter((p) => p.phase === 'Supervisor');
  const landedSv = svSteps.length ? (parseSvMinor(svSteps[svSteps.length - 1].to) || svSteps[svSteps.length - 1].to)
    : o.startingSvMinor;
  const stays = (layer) => `your current ${layer}, which nothing in your request requires moving`;
  const moved = 'where the steps your request requires leave it';
  // A target Supervisor derived from the target vCenter (rule 14n) is already disclosed once.
  if (!o.input.targetSV && !o.svDisclosed && landedSv) {
    assumedTargets.push({ layer: 'Supervisor', value: landedSv, why: 'the Supervisor Kubernetes minor this plan lands on' });
  }
  const latestVks = (() => {
    let allowed = [...vksAllowedForSvMinor(matrix, landedSv)].sort(compareVks);
    if (o.input.targetVKr) allowed = allowed.filter((v) => vkrAllowedForVks(matrix, v).has(o.input.targetVKr));
    return allowed[allowed.length - 1] || null;
  })();
  const vksWhyLatest = `the latest compatible with Supervisor ${landedSv}` +
    (o.input.targetVKr ? ` that still allows your target VKr ${o.input.targetVKr}` : '');
  if (!o.input.targetVKS && o.landedVks) {
    const why = o.recommend && o.defaultedVKSAim === o.landedVks ? vksWhyLatest
      : (o.landedVks === o.startingVks ? stays('VKS') : moved);
    assumedTargets.push({ layer: 'VKS', value: o.landedVks, why });
    if (!o.recommend && latestVks && compareVks(latestVks, o.landedVks) > 0) {
      notIncluded.push({ layer: 'VKS', value: latestVks, why: vksWhyLatest });
    }
  }
  if (!o.input.targetVKr && o.landedVkr) {
    const latestVkrFor = (vks) => [...vkrAllowedForVks(matrix, vks)]
      .filter((v) => !isVkrSuperseded(matrix, v)).sort(compareVkr).pop() || null;
    const landedLatest = latestVkrFor(o.landedVks);
    const why = o.recommend && o.landedVkr === landedLatest ? `the latest allowed by VKS ${o.landedVks}`
      : (o.landedVkr === o.startingVkr ? stays('VKr') : moved);
    assumedTargets.push({ layer: 'VKr', value: o.landedVkr, why });
    const aimVks = notIncluded.length ? latestVks : o.landedVks;
    const latestVkr = latestVkrFor(aimVks);
    if (!o.recommend && latestVkr && compareVkr(latestVkr, o.landedVkr) > 0) {
      notIncluded.push({ layer: 'VKr', value: latestVkr, why: `the latest allowed by VKS ${aimVks}` });
    }
  }
  return { assumedTargets, notIncluded };
}

// One clause per defaulted layer. Where the paths land on different versions, each value is
// attributed to its path (rule 14o) instead of listing them side by side as if they were one target.
function describeTargetDefaults(paths) {
  const byLayer = new Map();
  for (const p of paths) {
    for (const d of p.assumedTargets || []) {
      if (!byLayer.has(d.layer)) byLayer.set(d.layer, []);
      byLayer.get(d.layer).push({ path: p.label.split(' — ')[0], ...d });
    }
  }
  const out = [];
  for (const [layer, entries] of byLayer) {
    const distinct = [...new Map(entries.map((e) => [`${e.value}|${e.why}`, e])).values()];
    if (distinct.length === 1) {
      out.push(`target ${layer} ${distinct[0].value} (${distinct[0].why})`);
      continue;
    }
    const sameWhy = distinct.every((e) => e.why === distinct[0].why);
    const parts = entries.map((e) => `${e.value} on ${e.path}${sameWhy ? '' : ` (${e.why})`}`);
    out.push(`target ${layer} ${parts.join(' and ')}` +
      (sameWhy ? ` (${distinct[0].why.replace('this plan', 'each path')})` : ''));
  }
  return out;
}

function defaultCurrentVksVkr(matrix, currentVKS, currentVKr) {
  if (currentVKS && !currentVKr) {
    const allowed = [...vkrAllowedForVks(matrix, currentVKS)];
    if (allowed.length) currentVKr = allowed.sort(compareVkr)[allowed.length - 1];
  } else if (currentVKr && !currentVKS) {
    const best = bestVksForVkr(matrix, currentVKr, null, null);
    if (best) currentVKS = best;
  }
  return { currentVKS, currentVKr };
}

function adviseSvReplatform(matrix, phases, startingVc, startingSvFull, startingSvMinor, startingVks, namedSv) {
  const order = vcOrder(matrix);
  const vcSteps = phases.filter((p) => p.phase === 'vCenter');
  if (!vcSteps.length) return;
  const finalVc = vcSteps[vcSteps.length - 1].to;
  const finalVcIdx = order.indexOf(finalVc);
  if (finalVcIdx === -1) return;

  const svSteps = phases.filter((p) => p.phase === 'Supervisor');
  const minor = svSteps.length ? svMinorOf(svSteps[svSteps.length - 1].to) : startingSvMinor;
  if (!minor) return;
  const running = svSteps.length
    ? svSteps[svSteps.length - 1].to
    : (startingSvFull || embeddedSvBuildForMinor(matrix, startingVc, minor));
  if (!running) return;
  // The customer named this exact build: it is where the plan is meant to leave them, so never
  // move off it as long as it runs on the final vCenter.
  // A bare patch ("1.31.6") names the running build too when that build is on that patch.
  const namesRunning = namedSv && (running === namedSv ||
    (/^v?\d+\.\d+\.\d+$/.test(namedSv) && (/^v?(\d+\.\d+\.\d+)/.exec(running) || [])[1] === namedSv.replace(/^v/, '')));
  if (namesRunning && ((matrix.sv_vc_compatibility || {})[running] || []).includes(finalVc)) return;

  // A -vsc suffix is a Supervisor lineage, not a vCenter name, and 8.x vCenters can share one
  // (8.0U3j and 8.0U3k both ship -vsc0.1.15), so rank it by the first vCenter that shipped it.
  const lineageRank = (suffix) => order.findIndex((v) => matrix.vc_sv_matrix[v].sv_version_suffix === suffix);
  const finalRank = lineageRank(matrix.vc_sv_matrix[finalVc].sv_version_suffix);
  const runningRank = lineageRank(parseVscSuffix(running));
  if (runningRank !== -1 && runningRank >= finalRank) return;

  // The step must be an upgrade sv_upgrade_graph lists from the running build (rule 5c), forward
  // of it. The graph lists no same-version move onto another lineage, so this is a newer patch of
  // the running minor where one is listed, else one minor up on the final vCenter's train (the
  // final vCenter's own build can even be an older patch: 8.x 1.31.11-vsc0.1.13 vs 9.0.2.0's
  // 1.31.6). With neither, no step is added.
  const vksSteps = phases.filter((p) => p.phase === 'VKS');
  const vks = vksSteps.length ? vksSteps[vksSteps.length - 1].to : startingVks;
  const edges = (matrix.sv_upgrade_graph || {})[running] || [];
  const legal = (b) => {
    if (b === running || compareSv(matrix, b, running) <= 0) return false;
    if (!edges.includes(b)) return false;
    if (lineageRank(parseVscSuffix(b)) < finalRank) return false;
    const compat = matrix.sv_vks_compatibility.find((e) => e.sv_k8s === b);
    return !vks || !compat || compat.allowed_vks.includes(vks);
  };
  const pickFor = (m) => {
    const preferred = displaySvBuildForMinor(matrix, finalVc, m);
    if (preferred && legal(preferred)) return preferred;
    const candidates = Object.keys(matrix.sv_vc_compatibility || {}).filter(
      (b) => parseSvMinor(b) === m && svBuildInstallableOn(matrix, finalVc, b) && legal(b)
    );
    return candidates.sort((a, b) =>
      lineageRank(parseVscSuffix(a)) - lineageRank(parseVscSuffix(b)) || compareSv(matrix, b, a))[0] || null;
  };

  const minors = allSvMinorsOrdered(matrix);
  const nextMinor = minors[minors.indexOf(minor) + 1];
  const sameMinor = pickFor(minor);
  const target = sameMinor ||
    (nextMinor && svMinorHasUpgradeEdge(matrix, minor, nextMinor) && svMinorInstallableOn(matrix, finalVc, nextMinor)
      ? pickFor(nextMinor) : null);
  if (!target) return;

  phases.push({
    phase: 'Supervisor', from: running, to: target,
    reason: sameMinor ? 'sv-replatform-to-vc-build' : 'sv-replatform-minor-climb', landedOnVc: finalVc,
  });
}

const PHASE_REASON_EXPLANATIONS = {
  'overlap-required': 'Mandatory sequential Supervisor Kubernetes upgrade required to reach a version compatible with the next vCenter release on the path to your target.',
  'vkr-forced': 'Mandatory VKS upgrade required to support the upcoming Kubernetes Release (VKr) upgrades on the path to your target.',
  'target-requires-newer-sv': 'Mandatory Supervisor upgrade required to support the VKS version needed for your target.',
  'target-sv-requested': 'Required to reach the Supervisor version you asked for.',
  'sv-currency-default': 'Recommended Supervisor Kubernetes upgrade (not mandatory) to advance to the latest version supported by your target vCenter, since no target version was specified.',
  'vks-requires-newer-sv': 'Mandatory Supervisor upgrade required to support the VKS version needed for your target.',
  'target-vks-requested': 'Upgrades vSphere Kubernetes Service (VKS) to your requested target version.',
  'vks-currency-default': 'Recommended VKS upgrade (not mandatory) to advance to the latest version supported by your target Supervisor, since no target version was specified.',
  'vks-forces-vkr-floor': 'Mandatory sequential Kubernetes Release upgrade required to reach the minimum version compatible with the upcoming VKS upgrade on the path to your target.',
  'vks-enables-vkr-climb': 'Mandatory intermediate VKS upgrade required to allow your Kubernetes Releases (VKr) to advance toward the minimum version required by the upcoming VKS upgrade on the path to your target.',
  'vc-sv-forces-vks-bump': 'Mandatory VKS upgrade required to reach a version compatible with the upcoming Supervisor Kubernetes release on the path to your target.',
  'async-sv-upgrade': 'Mandatory sequential Supervisor upgrade delivered asynchronously (out-of-band) — requires no vCenter upgrade.',
  'vc-target-requested': 'The vCenter version you asked for.',
  'vc-intermediate-to-target': 'Mandatory intermediate vCenter upgrade required to reach your target vCenter — there is no direct upgrade path from the version you are on.',
  'vc-enables-sv-climb': 'Mandatory intermediate vCenter upgrade required to support the sequential Supervisor Kubernetes upgrades needed to reach your target vCenter.',
  'vc-required-by-sv-target': 'Mandatory vCenter upgrade required to support your requested target Supervisor Kubernetes version.',
  'vc-required-by-vks-target': 'Mandatory vCenter upgrade required to support the Supervisor Kubernetes version needed for your target VKS.',
  'vc-modernization-crossing': 'This path crosses to vCenter 9.x. Nothing in your target requires it — it is offered as the modernization alternative.',
  'vc-golden-destination': 'Recommended, not required: nothing in your target needs this hop, but it brings vCenter to the golden path destination, the latest build this path can stop on.',
  'leave-superseded-vkr': 'Required first: the Kubernetes Release you are running has been withdrawn, so newer VKS versions no longer list it — this moves you to the nearest compatible release on your current VKS before anything else can proceed.',
  'sv-replatform-to-vc-build': 'Mandatory Supervisor upgrade required to finalize your target vCenter upgrade: moves Supervisor onto the build that shipped with that vCenter (or a later one), never an earlier build. Same Kubernetes minor — a newer patch build, via a supported Supervisor upgrade path.',
  'sv-replatform-minor-climb': 'Mandatory Supervisor upgrade required to finalize your target vCenter upgrade: the build that shipped with that vCenter for your current Supervisor Kubernetes version is older than the one you are running, so Supervisor moves to the next Kubernetes version on that vCenter\'s build instead — never an earlier build.',
};

const SV_REASON_TO_VC_REASON = {
  'target-sv-requested': 'vc-required-by-sv-target',
  'sv-currency-default': 'vc-required-by-sv-target',
  'vks-requires-newer-sv': 'vc-required-by-vks-target',
};
// With no Supervisor-driven reason, the hop is an unrequired move to the golden destination: a
// crossing into 9.x only when the endpoint is 9.x, otherwise the 8.x golden destination.
function vcReasonForSvReason(svReason, endpointVc, sourceVc) {
  // Only a hop that actually leaves 8.x is a crossing; a 9.x source staying on 9.x is not.
  return SV_REASON_TO_VC_REASON[svReason] ||
    (vcFamily(endpointVc) === '9.x' && vcFamily(sourceVc) === '8.x' ? 'vc-modernization-crossing' : 'vc-golden-destination');
}

function defaultPhaseExplanation(phase) {
  if (phase.phase === 'vCenter') return 'Advances vCenter to a build required to reach your target.';
  if (phase.phase === 'Supervisor') return 'Sequential Supervisor Kubernetes upgrade.';
  if (phase.phase === 'VKS') return 'Upgrades the Supervisor Service (VKS) toward your requested target.';
  if (phase.phase === 'VKr') return 'Sequential Kubernetes Release upgrade toward your target (no minor skips permitted).';
  return '';
}

function annotateExportPhases(phases, starting) {
  let flaggedStartingSv = false;
  return phases.map((p, i) => {
    const annotated = {
      ...p,
      index: i + 1,
      explanation: PHASE_REASON_EXPLANATIONS[p.reason] || defaultPhaseExplanation(p),
    };
    if (!flaggedStartingSv && p.phase === 'Supervisor' && starting && starting.source === 'defaulted-highest') {
      annotated.from_assumed = true;
      flaggedStartingSv = true;
    }
    return annotated;
  });
}

// Section 1's Supervisor scope floor applies before deriving a vCenter from the build.
function svBelowScopeFloor(matrix, version) {
  if (!version) return false;
  const minimum = matrix.sv_min_version || 'v1.26.8+vmware.1-fips.1-vsc0.1.9';
  const parts = (v) => (/^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(v) || []).slice(1);
  const compare = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (+a[i] !== +b[i]) return +a[i] - +b[i];
    }
    return 0;
  };
  const v = parts(version), floor = parts(minimum);
  // A bare minor such as 1.26 resolves to an in-scope patch, rather than to 1.26.0.
  if (v.length && compare(v.filter((x) => x !== undefined), floor) < 0) return true;
  const suffix = /-vsc(\d+)\.(\d+)\.(\d+)/.exec(version);
  const floorSuffix = /-vsc(\d+)\.(\d+)\.(\d+)/.exec(minimum);
  return Boolean(suffix && compare(suffix.slice(1), floorSuffix.slice(1)) < 0);
}

function planUpgrade(matrix, input) {
  for (const field of ['currentSV', 'targetSV']) {
    if (!svBelowScopeFloor(matrix, input[field])) continue;
    const message = `Supervisor ${input[field]} is below this planner's minimum ` +
      `${matrix.sv_min_version || 'v1.26.8+vmware.1-fips.1-vsc0.1.9'}, the first Supervisor ` +
      `embedded in vCenter 8.0U3. Pre-U3 Supervisor lineages are outside the planner's scope.`;
    const err = new Error(message);
    const target = field === 'targetSV';
    err[target ? 'invalidTargetState' : 'invalidStartingState'] = true;
    err[target ? 'targetStateErrors' : 'startingStateErrors'] = [
      { kind: 'sv-below-scope-floor', message },
    ];
    throw err;
  }
  const { targetVC } = input;
  const recommend = Boolean(input.recommend);
  // Path A's unpinned endpoint is always the default 8.x golden destination (SPEC.md rule 9b).
  const golden8xDestination = matrix.golden_path_8x_destination;
  let { currentSV, targetSV, targetVKS, targetVKr } = input;
  let svTargetReason = 'target-sv-requested';
  let { currentVKS, currentVKr } = defaultCurrentVksVkr(matrix, input.currentVKS, input.currentVKr);
  const assumptionNotes = [];

  if (input.currentVKS && !input.currentVKr && currentVKr) {
    assumptionNotes.push(`current VKr ${currentVKr} (the latest allowed by VKS ${currentVKS})`);
  } else if (input.currentVKr && !input.currentVKS && currentVKS) {
    assumptionNotes.push(`current VKS ${currentVKS} (the latest that allows VKr ${currentVKr})`);
  }

  if (targetSV && !targetVC && /^\d+\.\d+$/.test(targetSV)) {
    const err = new Error(
      `Target Supervisor ${targetSV} is a bare minor with no target vCenter named - many real ` +
      `builds share that minor with different vCenter compatibility, so there is no single ` +
      `vCenter to resolve it to. Name a target vCenter, or a more specific target Supervisor ` +
      `(a patch or full build).`
    );
    err.invalidTargetState = true;
    err.targetStateErrors = [{ kind: 'bare-target-sv-without-vc', message: err.message }];
    throw err;
  }

  if (!input.currentVC && !currentSV && currentVKS) {
    const allowedMinors = matrix.sv_vks_compatibility
      .filter((e) => e.allowed_vks.includes(currentVKS))
      .map((e) => parseSvMinor(e.sv_k8s))
      .filter(Boolean);
    const order = allSvMinorsOrdered(matrix);
    const latestMinor = allowedMinors.length
      ? allowedMinors.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).pop()
      : null;
    const earliestVc = latestMinor
      ? Object.keys(matrix.vc_sv_matrix).find((vc) => matrix.vc_sv_matrix[vc].supported_sv_k8s_minors.includes(latestMinor))
      : null;
    if (latestMinor && earliestVc) {
      currentSV = latestMinor;
      input = { ...input, currentVC: earliestVc };
      assumptionNotes.push(
        `current vCenter ${earliestVc} and Supervisor ${latestMinor} (the latest compatible with ` +
        `VKS ${currentVKS}), since neither was specified`
      );
    }
  }

  const derivedVC = deriveVcFromSv(matrix, currentSV);
  const currentVC = input.currentVC || derivedVC;
  if (!currentVC) {
    throw new Error('currentVC could not be determined: specify a current vCenter, or a full SV version string containing a -vsc<suffix> token.');
  }

  if (targetVKr && isVkrSuperseded(matrix, targetVKr)) {
    const by = matrix.vkr_status[targetVKr].by;
    const err = new Error(
      `Target VKr ${targetVKr} is superseded by ${by} and can never be an upgrade destination. ` +
      `Target ${by} instead.`
    );
    err.invalidTargetState = true;
    err.targetStateErrors = [{ kind: 'target-vkr-superseded', message: err.message }];
    throw err;
  }

  if (targetVKS && targetVKr) {
    const allowed = vkrAllowedForVks(matrix, targetVKS);
    if (!allowed.has(targetVKr)) {
      throw new Error(
        `Target conflict: VKr ${targetVKr} is not in VKS ${targetVKS}'s allowed_vkr set. ` +
        `Pick a compatible pair, or specify only one of Target VKS / Target VKr and let the solver resolve the other.`
      );
    }
  }

  if (targetVC && vcBefore8u3(matrix, targetVC) && (targetVKS || targetVKr)) {
    throw new Error(
      `Invalid: target vCenter ${targetVC} is before 8.0U3, and VKS/VKr require 8.0U3 or newer, ` +
      `so it cannot reach target ${targetVKS ? `VKS ${targetVKS}` : `VKr ${targetVKr}`}.`
    );
  }

  const starting = resolveStartingSv(matrix, currentVC, currentSV);

  if (currentVC && !currentSV && starting.source === 'defaulted-highest') {
    const shownBuild = starting.svFull || starting.svMinor;
    assumptionNotes.push(`current Supervisor ${shownBuild} (the latest supported on vCenter ${currentVC})`);
  }

  if (!currentVKS && !currentVKr) {
    const curAllowed = [...vksAllowedForSvMinor(matrix, starting.svMinor)].sort(compareVks);
    if (curAllowed.length) {
      ({ currentVKS, currentVKr } = defaultCurrentVksVkr(matrix, curAllowed[curAllowed.length - 1], null));
      assumptionNotes.push(
        `current VKS ${currentVKS} (the latest compatible with Supervisor ${starting.svMinor}) and ` +
        `current VKr ${currentVKr} (the latest it allows)`
      );
    }
  }

  if (targetVC && targetVKS) {
    const tgtEntry0 = matrix.vc_sv_matrix[targetVC];
    if (tgtEntry0) {
      const win0 = tgtEntry0.supported_sv_k8s_minors;
      const needed0 = svMinorsSupportingVks(matrix, targetVKS);
      if (!win0.some((m) => needed0.has(m))) {
        const order00 = allSvMinorsOrdered(matrix);
        const err = new Error(
          `Invalid target combination: vCenter ${targetVC} is compatible with Supervisor Kubernetes ` +
          `${win0.join(', ')}, but VKS ${targetVKS} requires one of ` +
          `${[...needed0].sort((a, b) => order00.indexOf(a) - order00.indexOf(b)).join(', ') || '(none in this data)'}` +
          `. No Supervisor version satisfies both, so change either the target vCenter or the ` +
          `target VKS.`
        );
        err.invalidTargetState = true;
        err.targetStateErrors = [{ kind: 'target-vc-vks-no-common-sv', message: err.message }];
        throw err;
      }
    }
  }

  if (recommend && targetVC && !targetSV) {
    const tgtEntry = matrix.vc_sv_matrix[targetVC];
    if (tgtEntry) {
      let win = tgtEntry.supported_sv_k8s_minors;
      const order0 = allSvMinorsOrdered(matrix);
      if (targetVKS) {
        const needed = svMinorsSupportingVks(matrix, targetVKS);
        const both = win.filter((m) => needed.has(m));
        if (!both.length) {
          const err = new Error(
            `Invalid target combination: vCenter ${targetVC} is compatible with Supervisor Kubernetes ` +
            `${win.join(', ')}, but VKS ${targetVKS} requires one of ` +
            `${[...needed].sort((a, b) => order0.indexOf(a) - order0.indexOf(b)).join(', ') || '(none in this data)'}` +
            `. No Supervisor version satisfies both, so change either the target vCenter or the ` +
            `target VKS.`
          );
          err.invalidTargetState = true;
          err.targetStateErrors = [{ kind: 'target-vc-vks-no-common-sv', message: err.message }];
          throw err;
        }
        win = both;
      }
      const latest = win[win.length - 1];
      const derivedTargetSV = order0.indexOf(latest) >= order0.indexOf(starting.svMinor) ? latest
        : (win.includes(starting.svMinor) ? starting.svMinor : win[win.length - 1]);
      targetSV = derivedTargetSV;
      if (targetSV !== starting.svMinor) {
        svTargetReason = 'sv-currency-default';
        assumptionNotes.push(
          `target Supervisor ${derivedTargetSV} (the latest compatible with vCenter ${targetVC})`
        );
      }
    }
  }

  if (targetVC && targetSV) {
    const tgtVcEntry = matrix.vc_sv_matrix[targetVC];
    const tgtSvMinor = parseSvMinor(targetSV) || targetSV;
    if (tgtVcEntry && !tgtVcEntry.supported_sv_k8s_minors.includes(tgtSvMinor) &&
      !svMinorInstallableOn(matrix, targetVC, tgtSvMinor)) {
      const win = tgtVcEntry.supported_sv_k8s_minors;
      const err = new Error(
        `Invalid target combination: vCenter ${targetVC} is compatible with Supervisor Kubernetes ` +
        `${win.join(', ')}, so Supervisor ${tgtSvMinor} cannot run on it.` +
        ` Pick a Supervisor in that range, or a vCenter that is compatible with ${tgtSvMinor}.`
      );
      err.invalidTargetState = true;
      err.targetStateErrors = [{ kind: 'target-sv-not-on-target-vc', message: err.message }];
      throw err;
    }
  }

  const stateCheck = validateStartingState(matrix, {
    currentVC, currentVKS, currentVKr, svMinor: starting.svMinor, svFull: currentSV,
    targetVKS, targetVKr,
  });
  if (stateCheck.errors.length) {
    const err = new Error(stateCheck.errors[0].message);
    err.startingStateErrors = stateCheck.errors;
    err.invalidStartingState = true;
    throw err;
  }

  const defaultCeiling = targetVKS || null;

  const resolvedTargetVKS = targetVKS || null;

  const hasVkr = Boolean(currentVKr);
  let vkrResolution = null;
  if (hasVkr) {
    vkrResolution = targetVKr
      ? { vkr: targetVKr, forced: false }
      : resolveTargetVkr(matrix, resolvedTargetVKS || currentVKS, targetVKr, currentVKr);
  }
  const resolvedTargetVKr = vkrResolution ? vkrResolution.vkr : null;

  const requiredMinors = new Set();
  if (targetSV) {
    requiredMinors.add(parseSvMinor(targetSV) || targetSV);
  } else if (resolvedTargetVKS) {
    for (const entry of matrix.sv_vks_compatibility) {
      if (entry.allowed_vks.includes(resolvedTargetVKS)) requiredMinors.add(parseSvMinor(entry.sv_k8s));
    }
  }
  const hasNamedSvConstraint = Boolean(targetSV || resolvedTargetVKS);
  if (!requiredMinors.size) requiredMinors.add(starting.svMinor);

  function buildPath(allow9x, label, vksCeiling, require9x) {
    let pathVKS = currentVKS, pathVKr = currentVKr;
    const trueStartingVKS = pathVKS;
    if (!allow9x && vcFamily(currentVC) === '9.x') return null;
    if (require9x && targetVC && vcFamily(targetVC) !== '9.x') return null;
    if (!allow9x && targetVC && vcFamily(targetVC) !== vcFamily(currentVC)) return null;

    const alreadyOnExactBuild = starting.svFull === targetSV;
    if (targetSV && targetSV.includes('-vsc') && matrix.sv_vc_compatibility && !alreadyOnExactBuild) {
      const compat = matrix.sv_vc_compatibility[targetSV];
      if (compat) {
        const inBound = new Set([currentVC, ...vcReachable(matrix, currentVC, allow9x).keys()]);
        const hosts = compat.filter((vc) => inBound.has(vc) &&
          (!require9x || vcFamily(vc) === '9.x') && svBuildInstallableOn(matrix, vc, targetSV));
        if (!hosts.length) {
          // Where the build can actually be installed, within this path's family scope. Outside
          // that scope the path is simply not applicable; inside it, say why it cannot get there.
          const installable = Object.keys(matrix.vc_sv_matrix).filter((vc) => svBuildInstallableOn(matrix, vc, targetSV) &&
            (allow9x || vcFamily(vc) === vcFamily(currentVC)) && (!require9x || vcFamily(vc) === '9.x'));
          if (!installable.length) return null;
          const behind = starting.svFull ? compareSv(matrix, targetSV, starting.svFull) < 0
            : svMinorDistance(matrix, starting.svMinor, parseSvMinor(targetSV)) < 0;
          if (behind) {
            return {
              label, unreachable: true, reason: `Target Supervisor ${targetSV} is older than your current ` +
                `${starting.svFull || starting.svMinor}. Supervisor is never downgraded — pick a target at or ahead of it.`
            };
          }
          return {
            label, unreachable: true,
            reason: `Target Supervisor ${targetSV} can only be installed on vCenter ${installable.join(', ')}, and ` +
              `none of those is reachable from ${currentVC} on this path. A vCenter that is merely compatible ` +
              `with this build can keep running it after an upgrade, but cannot install it.`,
          };
        }
      }
    }

    let endpoint;
    if (targetVC) {
      if (targetVC === currentVC) {
        endpoint = { vc: currentVC, hops: 0, path: [currentVC], landingMinor: starting.svMinor };
      } else {
        const reach = resolveVcHopPath(matrix, currentVC, targetVC, allow9x);
        if (!reach) {
          if (!vcKnownToUpgradeGraph(matrix, targetVC)) {
            return { label, unreachable: true, reason: `vCenter ${targetVC} is a known release but has no upgrade paths in the interop data yet — it appears neither as a source nor as a target of any upgrade edge, so no route to it can be proven. This is a gap in the source data (the release is likely too new), not a statement that the upgrade is unsupported. Pick an earlier target vCenter, or leave Target vCenter blank to let a reachable one be chosen.` };
          }
          return { label, unreachable: true, reason: `No legal vCenter upgrade path from ${currentVC} to ${targetVC} within this path's bound.` };
        }
        endpoint = { vc: targetVC, hops: reach.hops, path: reach.path, landingMinor: starting.svMinor };
      }
    } else {
      const targetSvVcs = targetSV ? matrix.sv_vc_compatibility[targetSV] : null;
      const vcAllowed = targetSvVcs
        ? (vc) => (alreadyOnExactBuild ? targetSvVcs.includes(vc) : svBuildInstallableOn(matrix, vc, targetSV))
        : null;

      endpoint = pickVcEndpoint(matrix, currentVC, starting.svMinor, requiredMinors, allow9x, require9x, vcAllowed);
      if (!endpoint) {
        const hosts = Object.keys(matrix.vc_sv_matrix).filter((vc) =>
          matrix.vc_sv_matrix[vc].supported_sv_k8s_minors.some((m) => requiredMinors.has(m)));
        if (hosts.length && !hosts.some((vc) => vcKnownToUpgradeGraph(matrix, vc))) {
          return {
            label, unreachable: true, reason: `Reaching ${targetSV || 'this target'} needs Supervisor ` +
              `${[...requiredMinors].join(' or ')}, which is only compatible with vCenter ${hosts.join(', ')}, and none of ` +
              `those has any upgrade paths in the interop data yet, so no route to it can be proven. This is a gap ` +
              `in the source data, not a statement that the upgrade is unavailable. Pick an earlier target, or name ` +
              `the target vCenter explicitly.`
          };
        }
        return {
          label, unreachable: true, reason: require9x
            ? 'No 9.x vCenter reachable from here is compatible with the requested target, so there is no modernization path for it.'
            : 'No vCenter endpoint within this path\'s bound is compatible with the requested target.'
        };
      }

      // Golden path: with no target vCenter named, aim at the golden destination (9.1+ for the 9.x
      // path, 8.0U3k for the 8.x path). If it cannot host the required Supervisor/VKS, retract along
      // the same golden route to the latest earlier hop that can (e.g. 8.0U3i, then 8.0U3g).
      const goldenDest = allow9x ? matrix.golden_path_destination : golden8xDestination;
      // Async mode (rules 5a/5b): when the named Supervisor is one the current vCenter does not ship
      // but can install out-of-band, stay on it rather than adding a vCenter upgrade.
      const svMinorNamed = targetSV ? (parseSvMinor(targetSV) || targetSV) : null;
      const asyncOnCurrentVc = Boolean(svMinorNamed) && !alreadyOnExactBuild &&
        !matrix.vc_sv_matrix[currentVC].supported_sv_k8s_minors.includes(svMinorNamed) &&
        (targetSV.includes('-vsc')
          ? svBuildInstallableOn(matrix, currentVC, targetSV)
          : svMinorInstallableOn(matrix, currentVC, svMinorNamed));
      // A named Supervisor is an endpoint, not a waypoint. When the current vCenter already hosts
      // it, no vCenter hop is added at all. Otherwise a named exact build decides its own block:
      // the plan follows the recommended (golden) route to the vCenter that shipped it (its -vsc
      // lineage) - -vsc9.1.1.0 goes to 9.1.1.0, -vsc9.0.0.0 to 9.0.0.0 - even where an earlier
      // block could install it async. Only when that vCenter has no recommended route does the
      // plan diverge to the golden route's first block that hosts it.
      const svPinned = Boolean(targetSV);
      const stayOnCurrent = svPinned && endpoint.vc === currentVC;
      let shipEndpoint = null;
      if (svPinned && !stayOnCurrent && !asyncOnCurrentVc && targetSV.includes('-vsc')) {
        const vcIdx = vcOrder(matrix);
        const suffix = parseVscSuffix(targetSV);
        for (const vc of vcIdx) {
          if (vcIdx.indexOf(vc) <= vcIdx.indexOf(currentVC)) continue;
          if (matrix.vc_sv_matrix[vc].sv_version_suffix !== suffix) continue;
          if ((require9x && vcFamily(vc) !== '9.x') || (!allow9x && vcFamily(vc) !== vcFamily(currentVC))) continue;
          if (vcAllowed && !vcAllowed(vc)) continue;
          const route = recommendedVcPath(matrix, currentVC, vc);
          if (!route) continue;
          const landingMinor = parseSvMinor(targetSV);
          shipEndpoint = {
            vc, hops: route.hops, vcHops: route.hops,
            vcMajorCrossings: countMajorCrossings(route.path), path: route.path, landingMinor,
            svHops: svMinorDistance(matrix, starting.svMinor, landingMinor),
            svPatchRecency: allSvMinorsOrdered(matrix).indexOf(landingMinor)
          };
          endpoint = shipEndpoint;
          break;
        }
      }
      const goldenChain = !asyncOnCurrentVc && goldenDest && matrix.vc_sv_matrix[goldenDest] &&
        !stayOnCurrent && !shipEndpoint
        ? recommendedVcPath(matrix, currentVC, goldenDest) : null;
      if (goldenChain) {
        const n = goldenChain.path.length;
        for (let k = 1; k < n; k++) {
          const i = svPinned ? k : n - k;
          const vc = goldenChain.path[i];
          const entry = matrix.vc_sv_matrix[vc];
          if (!entry || (vcAllowed && !vcAllowed(vc))) continue;
          if (require9x && vcFamily(vc) !== '9.x') continue;
          const overlap = hasNamedSvConstraint
            ? entry.supported_sv_k8s_minors.filter((m) => requiredMinors.has(m))
            : entry.supported_sv_k8s_minors;
          if (!overlap.length) continue;
          let landingMinor = overlap[0];
          let bestSvHops = svMinorDistance(matrix, starting.svMinor, landingMinor);
          for (const m of overlap.slice(1)) {
            const d = svMinorDistance(matrix, starting.svMinor, m);
            if (d < bestSvHops) { bestSvHops = d; landingMinor = m; }
          }
          let path = goldenChain.path.slice(0, i + 1);
          if (svPinned) {
            // The golden route reaches a block (one release train); land on the member of that
            // block that shipped the named build (-vsc9.1.1.0 -> 9.1.1.0, not 9.1.1.0100), else
            // the earliest member that hosts it, not whichever member the route happens to name.
            const vcIdx = vcOrder(matrix);
            const train = (v) => v.split('.').slice(0, 3).join('.');
            const members = vcIdx.filter((v) => {
              if (train(v) !== train(vc) || vcIdx.indexOf(v) <= vcIdx.indexOf(currentVC)) return false;
              if (vcAllowed && !vcAllowed(v)) return false;
              const route = resolveVcHopPath(matrix, currentVC, v, allow9x);
              return Boolean(route) && route.path.length - 1 <= i;
            });
            const suffix = parseVscSuffix(targetSV);
            const member = members.find((v) => matrix.vc_sv_matrix[v].sv_version_suffix === suffix) ||
              members.find((v) => vcIdx.indexOf(v) <= vcIdx.indexOf(vc));
            if (member && member !== vc) path = resolveVcHopPath(matrix, currentVC, member, allow9x).path;
          }
          const hops = path.length - 1;
          endpoint = {
            vc: path[hops], hops, vcHops: hops,
            vcMajorCrossings: countMajorCrossings(path), path, landingMinor,
            svHops: bestSvHops, svPatchRecency: allSvMinorsOrdered(matrix).indexOf(landingMinor)
          };
          break;
        }
      }
    }

    let vcPhases = [];
    let svMinor = starting.svMinor;

    if (endpoint.landingMinor && svMinorDistance(matrix, svMinor, endpoint.landingMinor) === Infinity) {
      endpoint.landingMinor = svMinor;
    }

    let preferLandingMinor = targetSV ? (parseSvMinor(targetSV) || targetSV) : null;
    let preferLandingReason = preferLandingMinor ? svTargetReason : null;
    if (!preferLandingMinor && resolvedTargetVKS) {
      const endEntry = matrix.vc_sv_matrix[endpoint.vc];
      const candidates = endEntry ? endEntry.supported_sv_k8s_minors.filter((m) => requiredMinors.has(m)) : [];
      if (candidates.length) {
        preferLandingMinor = candidates
          .slice()
          .sort((a, b) => svMinorDistance(matrix, svMinor, a) - svMinorDistance(matrix, svMinor, b))[0];
        preferLandingReason = 'vks-requires-newer-sv';
      }
    }

    if (targetVC && targetVC !== currentVC) {
      const prep = { vc: currentVC, svMinor, allow9x };
      const tgtEntry = matrix.vc_sv_matrix[targetVC];
      const needsPrep = !tgtEntry.supported_sv_k8s_minors.includes(svMinor);
      const recommendedTo = targetVC;
      if (needsPrep) {
        const need = tgtEntry.supported_sv_k8s_minors
          .filter((m) => svMinorDistance(matrix, svMinor, m) > 0)
          .sort((a, b) => allSvMinorsOrdered(matrix).indexOf(a) - allSvMinorsOrdered(matrix).indexOf(b))[0];
        if (!need) {
          return { label, unreachable: true, reason: `vCenter ${targetVC} requires Supervisor to already be on one of ${tgtEntry.supported_sv_k8s_minors.join(', ')} before the upgrade, and none of those is forward of the current ${svMinor}.` };
        }
        if (!climbSvTo(matrix, prep, need, vcPhases, 'overlap-required', recommendedTo)) {
          return { label, unreachable: true, reason: `Cannot reach Supervisor ${need}, which vCenter ${targetVC} requires before it will allow the upgrade.` };
        }
        svMinor = prep.svMinor;
      }
      const reach = prep.vc === targetVC ? { path: [targetVC] } : resolveVcHopPath(matrix, prep.vc, targetVC, allow9x);
      if (!reach) {
        return { label, unreachable: true, reason: `No legal vCenter upgrade path from ${prep.vc} to ${targetVC} after the Supervisor prerequisites were met.` };
      }
      const walked = walkVcTrajectory(matrix, reach.path, svMinor, preferLandingMinor, preferLandingReason, 'vc-target-requested');
      vcPhases.push(...walked.phases);
      svMinor = walked.endingSvMinor;
      endpoint.path = reach.path;
    } else if (targetVC) {
      const walked = walkVcTrajectory(matrix, endpoint.path, starting.svMinor, preferLandingMinor, preferLandingReason, 'vc-target-requested');
      vcPhases = walked.phases;
      svMinor = walked.endingSvMinor;
    } else {
      let atVc = currentVC;
      if (endpoint.vc && endpoint.vc !== currentVC) {
        const endpointReason = vcReasonForSvReason(preferLandingReason, endpoint.vc, currentVC);
        const moved = walkToVc(matrix, currentVC, endpoint.vc, svMinor, allow9x, vcPhases, preferLandingMinor, preferLandingReason, endpointReason);
        if (!moved.ok) return { label, unreachable: true, reason: moved.reason };
        atVc = moved.vc;
        svMinor = moved.svMinor;
      }
      if (svMinorDistance(matrix, svMinor, endpoint.landingMinor) > 0) {
        const climbCtx = { vc: atVc, svMinor, allow9x };
        if (!climbSvTo(matrix, climbCtx, endpoint.landingMinor, vcPhases,
          targetSV ? svTargetReason : 'target-requires-newer-sv')) {
          return { label, unreachable: true, reason: `No vCenter reachable within this path's bound is compatible with Supervisor ${endpoint.landingMinor}, which the requested target needs.` };
        }
        svMinor = climbCtx.svMinor;
        atVc = climbCtx.vc;
      }
      endpoint.path = atVc === currentVC ? [currentVC] : [currentVC, atVc];
    }

    if (targetSV) {
      const tgtCompat = (matrix.sv_vc_compatibility || {})[targetSV];
      if (tgtCompat) {
        const reachableVcs = new Set([currentVC, ...vcReachable(matrix, currentVC, allow9x).keys()]);
        if (!tgtCompat.some((v) => reachableVcs.has(v))) {
          return { label, unreachable: true, reason: `Target Supervisor ${targetSV} is only compatible with vCenter ${tgtCompat.join(', ')}, none of which is your current vCenter (${currentVC}) or reachable from it within this path's bound.` };
        }
      }
      const tgtMinor = parseSvMinor(targetSV) || targetSV;
      const landedVc = endpoint.path[endpoint.path.length - 1];
      const svOrder = allSvMinorsOrdered(matrix);
      const ci = svOrder.indexOf(svMinor);
      const ti = svOrder.indexOf(tgtMinor);
      if (ti === -1) {
        return { label, unreachable: true, reason: `Target Supervisor ${tgtMinor} is not a Supervisor version this data knows about.` };
      }
      const advanced = vcPhases.filter((x) => x.phase === 'Supervisor');
      const movedBy = advanced.length ? advanced[advanced.length - 1] : null;
      const because = movedBy && movedBy.to !== starting.svMinor
        ? ` The plan has already advanced Supervisor to ${movedBy.to}${movedBy.reason === 'overlap-required' ? ' because the vCenter upgrade above requires it' : ''}, so your target is behind where the plan now stands.`
        : '';
      if (ti < ci) {
        return { label, unreachable: true, reason: `Target Supervisor ${targetSV} (${tgtMinor}) is older than Supervisor ${svMinor}.${because} Supervisor is never downgraded, so no combination of vCenter or Supervisor versions produces a plan for this — pick a target at or ahead of ${svMinor}.` };
      }
      if (ti === ci && starting.svFull && targetSV.includes('+vmware.') &&
        compareSv(matrix, targetSV, starting.svFull) < 0) {
        return { label, unreachable: true, reason: `Target Supervisor ${targetSV} is an older build than your current ${starting.svFull} — same Kubernetes version, lower vmware build number. Supervisor is never downgraded.` };
      }
      const targetIsSpecific = /^v?\d+\.\d+\.\d+/.test(targetSV);
      const alreadyOnTarget = starting.svFull === targetSV;
      if (targetIsSpecific && targetSV.includes('-vsc') && !alreadyOnTarget) {
        const landOn = targetVC || (endpoint.vc || currentVC);
        if (!svBuildInstallableOn(matrix, landOn, targetSV)) {
          const emb = (matrix.vc_sv_matrix[landOn] || {}).sv_version_suffix;
          const sfx = parseVscSuffix(targetSV);
          const runsThere = ((matrix.sv_vc_compatibility || {})[targetSV] || []).includes(landOn);
          const why = vcFamily(landOn) === '9.x'
            ? (runsThere && sfx && compareLineage(matrix, sfx, emb) < 0
              ? `it is a ${sfx} build, older than the ${emb} build vCenter ${landOn} ships. It can keep running ` +
              `there, but an older build is never installed on a newer vCenter. Pick a -vsc${emb} build or the patch.`
              : `vCenter ${landOn} cannot run it.`)
            : `vCenter ${landOn} ships Supervisor build ${emb} only, so it does not carry the bits for ` +
            `${parseVscSuffix(targetSV)}.`;
          return { label, unreachable: true, reason: `Target Supervisor ${targetSV} cannot be installed on ${landOn}: ${why}` };
        }
      }
      const landExactBuild = () => {
        if (!targetIsSpecific) return null;
        const priorSv = vcPhases.filter((x) => x.phase === 'Supervisor');
        const last = priorSv.length ? priorSv[priorSv.length - 1] : null;
        const from = last ? last.to : (starting.svFull || svMinor);
        if (from === targetSV) return null;
        if (starting.svFull && compareSv(matrix, targetSV, starting.svFull) <= 0) return null;
        const landedOnVc = targetVC || endpoint.vc || currentVC;
        // targetSV may be a bare patch (e.g. "1.33.9"); resolve it to the full
        // vmware build string shipped by the vCenter we land on, so this phase's
        // `to` is always a full build like every other Supervisor step.
        const resolvedTargetSV = targetSV.includes('-vsc')
          ? targetSV
          : resolveBarePatchBuild(matrix, landedOnVc, targetSV);
        if (!resolvedTargetSV) {
          return `Target Supervisor ${targetSV} has no build that vCenter ${landedOnVc} ships or can install, so there is no full Supervisor release to upgrade to on this path.`;
        }

        // Only a Supervisor step that already runs on the landing vCenter can become the exact
        // target; one before a later vCenter hop (an overlap climb) runs where the target build
        // may not be installable, so the target gets its own step after the hop instead.
        const vcAfterLast = last && vcPhases.slice(vcPhases.indexOf(last) + 1).some((x) => x.phase === 'vCenter');
        if (last && last.to === tgtMinor && !vcAfterLast) {
          last.to = resolvedTargetSV;
          if (last.reason !== 'async-sv-upgrade') last.reason = svTargetReason;
          last.landedOnVc = landedOnVc;
          return null;
        }
        vcPhases.push({ phase: 'Supervisor', from, to: resolvedTargetSV, reason: svTargetReason, landedOnVc });
        return null;
      };

      if (svMinor !== tgtMinor) {
        if (targetVC) {
          const supported = matrix.vc_sv_matrix[landedVc].supported_sv_k8s_minors;
          if (!supported.includes(tgtMinor) && !svMinorInstallableOn(matrix, landedVc, tgtMinor)) {
            return { label, unreachable: true, reason: `Supervisor ${tgtMinor} is not compatible with vCenter ${landedVc} (which is compatible with ${supported.join(', ')}). Pick a target vCenter that is compatible with it, or leave Target vCenter blank so one can be chosen for you.` };
          }
        }
        const climbCtx = { vc: landedVc, svMinor, allow9x };
        if (!climbSvTo(matrix, climbCtx, tgtMinor, vcPhases, svTargetReason)) {
          return { label, unreachable: true, reason: `No vCenter reachable within this path's bound is compatible with Supervisor ${tgtMinor}.` };
        }
        endpoint.path = endpoint.path.concat(climbCtx.vc === landedVc ? [] : [climbCtx.vc]);
        svMinor = climbCtx.svMinor;
      }
      const landError = landExactBuild();
      if (landError) return { label, unreachable: true, reason: landError };
    }

    resolveDisplaySvBuilds(matrix, vcPhases, currentVC, starting.svFull);
    // Make rule 7's planned Supervisor landing explicit before stranding checks.
    // Its VKS prerequisites must be planned against that action, not invented at
    // the preceding vCenter hop or appended after compatibility was checked.
    adviseSvReplatform(matrix, vcPhases, currentVC, starting.svFull, starting.svMinor, resolvedTargetVKS, input.targetSV);
    const plannedSv = vcPhases.filter((p) => p.phase === 'Supervisor').pop();
    if (plannedSv) svMinor = svMinorOf(plannedSv.to);
    const ctx = { vc: endpoint.path[endpoint.path.length - 1], svMinor, allow9x };

    let strandGuard = 0, strandFromIndex = 0;
    while (pathVKS) {
      if (++strandGuard > 64) return { label, unreachable: true, reason: 'VKS stranding check failed to converge' };
      const strand = findEarliestVksStrand(matrix, vcPhases, currentVC, starting.svMinor, pathVKS, resolvedTargetVKS, strandFromIndex, pathVKr, starting.svFull);
      if (!strand) break;
      if (!strand.chosenVks) {
        return { label, unreachable: true, reason: `Landing on Supervisor ${strand.minor} strands VKS ${pathVKS} — no VKS at or above it is compatible there.` };
      }
      const before = vcPhases.length;
      const hop = applyVksHop(matrix, {
        toVks: strand.chosenVks, svMinor: strand.insertMinor, vkr: pathVKr,
        walkGraph: buildVkrWalkGraph(matrix), phases: vcPhases, reason: 'vc-sv-forces-vks-bump', ctx,
        fromVks: pathVKS,
        targetVkrCap: input.targetVKr,
      });
      if (!hop.ok) return { label, unreachable: true, reason: hop.reason };
      const inserted = vcPhases.splice(before);
      vcPhases.splice(strand.index, 0, ...inserted);
      strandFromIndex = strand.index + inserted.length;
      if (svMinorDistance(matrix, svMinor, hop.svMinor) > 0) { svMinor = hop.svMinor; ctx.svMinor = svMinor; }
      pathVKS = strand.chosenVks;
      pathVKr = hop.vkr;
    }

    // Same-minor finalization belongs at the end. Its prerequisites have now
    // been inserted using the exact planned build; re-add the action after the
    // workload walk. A minor climb stays in place because later VKS work may
    // depend on that newer Supervisor minor.
    if (plannedSv && plannedSv.reason === 'sv-replatform-to-vc-build') {
      const index = vcPhases.indexOf(plannedSv);
      if (index !== -1) vcPhases.splice(index, 1);
    }

    let defaultedVKSAim = null;
    let pathTargetVKS = vksCeiling;
    if (!pathTargetVKS && pathVKS) {
      let allowed = [...vksAllowedForSvMinor(matrix, svMinor)].sort(compareVks);
      if (targetVKr) allowed = allowed.filter((v) => vkrAllowedForVks(matrix, v).has(targetVKr));
      const latest = allowed[allowed.length - 1];
      if (latest) {
        if (recommend && compareVks(latest, pathVKS) > 0) {
          pathTargetVKS = latest;
          defaultedVKSAim = latest;
        }
      }
    }
    let pathTargetVKr = targetVKr;
    if (hasVkr && !pathTargetVKr) {
      const aimVks = pathTargetVKS || pathVKS;
      const allowed = [...vkrAllowedForVks(matrix, aimVks)]
        .filter((v) => !isVkrSuperseded(matrix, v))
        .sort(compareVkr);
      const latest = allowed[allowed.length - 1];
      pathTargetVKr = pathVKr;
      if (recommend) {
        pathTargetVKr = latest && compareVkr(latest, pathVKr) > 0 ? latest : pathVKr;
      }
    }

    const vkrResult = hasVkr
      ? walkVkrTrajectory(matrix, pathVKr, pathTargetVKr, svMinor, pathTargetVKS, pathVKS, ctx,
        defaultedVKSAim ? 'vks-currency-default' : 'target-vks-requested')
      : { unreachable: false, phases: [], endingSvMinor: svMinor, endingVks: pathVKS };
    if (vkrResult.unreachable) return { label, unreachable: true, reason: vkrResult.reason };

    let finalSvMinor = vkrResult.endingSvMinor;

    let landedVks = vkrResult.endingVks || pathVKS;
    const landOnVks = resolvedTargetVKS || defaultedVKSAim;
    if (resolvedTargetVKS && landedVks !== landOnVks && compareVks(landedVks, landOnVks) > 0) {
      return {
        label, unreachable: true,
        reason: `Target VKS ${resolvedTargetVKS} cannot be reached: the Supervisor build this ` +
          `path lands on is not compatible with it — that build requires VKS ${landedVks} or newer. ` +
          `Pick a target VKS at or above ${landedVks}, or a vCenter/Supervisor combination whose ` +
          `embedded build doesn't force it.`,
      };
    }
    if (landOnVks && landedVks !== landOnVks) {
      const bumped = ensureSvSupportsVks(matrix, finalSvMinor, landOnVks, vcPhases, 'vks-requires-newer-sv', ctx);
      if (bumped) finalSvMinor = bumped;
      const vksWalk = walkVksSegment(matrix, landedVks, landOnVks,
        resolvedTargetVKS ? 'target-vks-requested' : 'vks-currency-default');
      if (!vksWalk.ok) return { label, unreachable: true, reason: vksWalk.reason };
      vcPhases.push(...vksWalk.phases);
      landedVks = landOnVks;
    }

    const phases = [...vcPhases, ...vkrResult.phases];
    annotateVkrPhases(matrix, phases, trueStartingVKS);
    resolveDisplaySvBuilds(matrix, phases, currentVC, starting.svFull);
    const illegalSv = illegalSvStep(matrix, phases, currentVC);
    if (illegalSv) return { label, unreachable: true, reason: illegalSv };
    adviseSvReplatform(matrix, phases, currentVC, starting.svFull, starting.svMinor, pathVKS, input.targetSV);
    const replay = replayPlanState(matrix, phases, {
      vc: currentVC,
      sv: starting.svFull || displaySvBuildForMinor(matrix, currentVC, starting.svMinor),
      vks: trueStartingVKS, vkr: currentVKr,
    });
    const stateError = replay.error || namedEndpointError(replay.state, input);
    if (stateError) return { label, unreachable: true, reason: stateError };
    annotateTransitions(matrix, phases, pathVKS, hasVkr);
    annotateTargetReached(matrix, phases, {
      targetVC, targetSV: input.targetSV, targetVKS: input.targetVKS, targetVKr: input.targetVKr,
    }, recommend);
    const vcHopPhases = phases.filter((x) => x.phase === 'vCenter');
    const landedVC = vcHopPhases.length ? vcHopPhases[vcHopPhases.length - 1].to : currentVC;
    // The Kubernetes Release the plan really ends on: a later VKS step can raise the VKr floor past
    // the aim the VKr walk was given, so read it off the emitted phases, not the aim.
    const vkrPhases = phases.filter((x) => x.phase === 'VKr');
    const landedVkr = vkrPhases.length ? vkrPhases[vkrPhases.length - 1].to : (pathTargetVKr || null);
    const { assumedTargets, notIncluded } = describePathDefaults(matrix, {
      phases, input, recommend, svDisclosed: Boolean(targetSV && !input.targetSV),
      startingSvMinor: starting.svMinor, startingVks: trueStartingVKS,
      startingVkr: currentVKr, landedVks, landedVkr, defaultedVKSAim,
    });
    return {
      label, unreachable: false, vcHops: endpoint.hops, phases, noop: phases.length === 0,
      requiresWorkloadPrecheck: phases.some((p) => (p.transitionNotes || []).some((n) => n.kind === 'workload-vkr-precheck')),
      landedVKS: landedVks, landedVKr: landedVkr, landedVC, assumedTargets, notIncluded
    };
  }

  const isCurrently8x = vcFamily(currentVC) === '8.x';
  const pathA = isCurrently8x ? buildPath(false, 'Path A — in-family 8.x', defaultCeiling) : null;
  const pathB = buildPath(true, isCurrently8x ? 'Path B — 9.x modernization' : 'Path — 9.x',
    defaultCeiling, isCurrently8x);

  const recommendedPaths = [pathA, pathB].filter((p) => p && !p.unreachable);
  const landedDestForAim = recommendedPaths[recommendedPaths.length - 1] || null;
  const naturallyLandedVKS = (landedDestForAim && landedDestForAim.landedVKS) ||
    (pathA && !pathA.unreachable && pathA.landedVKS) ||
    (pathB && !pathB.unreachable && pathB.landedVKS) || null;

  let pathC = null;
  if (targetVKr && !targetVKS) {
    const latest = bestVksForVkr(matrix, targetVKr, null, null);
    if (latest && (!naturallyLandedVKS || compareVks(latest, naturallyLandedVKS) > 0)) {
      pathC = buildPath(!isCurrently8x, `Path C — latest VKS (${latest})`, latest);
      if (pathC && !pathC.unreachable) pathC.aimsAt = latest;
    }
  }

  let pathD = null;
  if (targetVKr && !targetVKS) {
    const supportedAim = lowestSupportedVksForVkr(matrix, targetVKr, input.asOf);
    const duplicatesC = pathC && pathC.aimsAt === supportedAim;
    if (supportedAim && !duplicatesC &&
      (!naturallyLandedVKS || compareVks(supportedAim, naturallyLandedVKS) > 0)) {
      const eos = ((matrix.lifecycle || {}).vks || {})[supportedAim] || {};
      const until = eos.eos ? `, supported to ${eos.eos}` : '';
      pathD = buildPath(!isCurrently8x, `Path D — supported VKS (${supportedAim}${until})`, supportedAim);
      if (pathD && !pathD.unreachable) pathD.aimsAt = supportedAim;
    }
  }

  const recommended = recommendedPaths;
  const targetDefaults = describeTargetDefaults(recommended);
  const notes = [];
  if (assumptionNotes.length || targetDefaults.length) {
    notes.push(
      `Assumed defaults: These versions were not specified, so the plan ` +
      (recommend
        ? 'aims at the latest compatible at each layer: '
        : 'assumes them, and leaves each target layer you did not name where your requested upgrade requires: ') +
      `${[...assumptionNotes, ...targetDefaults].join('; ')}. ` +
      `Specify the actual versions to replace any of these assumptions.`
    );
  }
  // Rule 14p: with recommendations off, newer compatible versions are offered, never presented as
  // targets the plan reaches.
  const optional = describeTargetDefaults(recommended.map((p) => ({ label: p.label, assumedTargets: p.notIncluded })))
    .map((d) => d.replace(/^target /, ''));
  if (optional.length) {
    notes.push(
      `Not included, because Broadcom recommendation is off: newer compatible versions are ` +
      `available — ${optional.join('; ')}. Turn on Broadcom recommendation, or name them as ` +
      `targets, to add these upgrades.`
    );
  }
  if (!hasVkr) {
    notes.push('No current VKr specified: this plan assumes no VKS Clusters exist and covers only the VC/Supervisor/VKS layers.');
  } else if (vkrResolution.forced) {
    notes.push(`Current VKr ${currentVKr} is not compatible with target VKS ${resolvedTargetVKS}. Reaching that VKS requires upgrading the Kubernetes Release to ${resolvedTargetVKr} — the latest patch of the minimum VKr minor that target VKS is compatible with.`);
  }

  const landedDest = landedDestForAim;
  const advisories = eosAdvisories(matrix, {
    vks: resolvedTargetVKS || (landedDest && landedDest.landedVKS) || naturallyLandedVKS || null,
    vkr: targetVKr || (landedDest && landedDest.landedVKr) || resolvedTargetVKr,
    vc: targetVC || (landedDest && landedDest.landedVC) || currentVC || null,
  }, input.asOf);

  const anyReachable = [pathA, pathB, pathC, pathD].some((p) => p && !p.unreachable);
  for (const p of [pathA, pathB, pathC, pathD]) {
    if (p && p.phases) p.phases = annotateExportPhases(p.phases, starting);
  }
  return {
    startingSv: starting,
    resolvedTarget: {
      targetVKS: resolvedTargetVKS,
      targetVKr: targetVKr || (landedDest && landedDest.landedVKr) || resolvedTargetVKr,
      aimedVKS: resolvedTargetVKS || (landedDest && landedDest.landedVKS) || naturallyLandedVKS || null,
    },
    notes: anyReachable ? notes : [],
    advisories: anyReachable ? advisories : [],
    pathA, pathB, pathC, pathD,
  };
}
