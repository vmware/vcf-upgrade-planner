/* DSM <-> VKS compatibility helpers.
 *
 * Data: window._compatData.compatibility.dsm_vks  (from compat-data.json, refreshed by refresh_compat.py)
 *   shape: { <dsmVersion>: { <vksVersion>: 'yes' | 'no' | { s: 'yes'|'no', n: '<note>' } } }
 *
 * Exposes window.DsmVksCompat:
 *   lookup(dsm, vks)            -> { status: 'yes'|'no'|'unknown', note }
 *   evaluate({srcDsm,tgtDsm,srcVks,tgtVks}) -> evaluation object (see below)
 *   annotatePhases(phases, ev)  -> attaches notices/steps to the plan's existing DSM phases
 *   loadData()                  -> Promise that resolves once compat data is in window._compatData
 */
(function () {
    'use strict';

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function matrix() {
        var d = window._compatData;
        return (d && d.compatibility && d.compatibility.dsm_vks) || null;
    }

    function lookup(dsm, vks) {
        var m = matrix();
        if (!m || !dsm || !vks) return { status: 'unknown', note: '' };
        var row = m[dsm];
        if (!row || !Object.prototype.hasOwnProperty.call(row, vks)) return { status: 'unknown', note: '' };
        var v = row[vks];
        if (typeof v === 'string') return { status: v, note: '', incompatible: false };
        // incompatible = red X in the matrix (known broken), as opposed to the grey "not supported" dash
        return { status: v.s || 'unknown', note: v.n || '', incompatible: !!v.x };
    }

    // ---- DSM <-> vCenter ------------------------------------------------------------------
    function vcMatrix() {
        var d = window._compatData;
        return (d && d.compatibility && d.compatibility.dsm_vcenter) || null;
    }
    // 'yes' | 'no' | 'unknown' for a DSM version with a vCenter version
    function lookupVcenter(dsm, vc) {
        var m = vcMatrix();
        if (!m || !dsm || !vc || !m[dsm] || !Object.prototype.hasOwnProperty.call(m[dsm], vc)) return 'unknown';
        var v = m[dsm][vc];
        return typeof v === 'string' ? v : (v.s || 'unknown');
    }
    function lookupVcenterCI(dsm, vc) {
        var m = vcMatrix();
        if (!m || !dsm || !vc || !m[dsm]) return 'unknown';
        if (Object.prototype.hasOwnProperty.call(m[dsm], vc)) return lookupVcenter(dsm, vc);
        var low = String(vc).toLowerCase(), keys = Object.keys(m[dsm]);
        for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === low) return lookupVcenter(dsm, keys[i]);
        return 'unknown';
    }

    // Target vCenter version of the plan (same mapping the plan pages use for the vCenter upgrade phase).
    function targetVcenter() {
        var raw = String(window.targetVcf91Version || localStorage.getItem('target-vcf91-version') || '9.1.0').trim();
        var map = { '9.1.0.0400': '9.1.0.0300', '9.1.1.0100': '9.1.1.0', '9.1.1.0200': '9.1.1.0100' };
        raw = map[raw] || raw;
        return raw.split('.').length < 4 ? raw + '.0' : raw;
    }
    // Unknown pairs are never filtered out: only an explicit 'no' removes a DSM version.
    function dsmAllowedWithVcenter(dsm, vc) { return lookupVcenterCI(dsm, vc) !== 'no'; }

    // numeric compare of the leading x.y.z of a VKS version such as '3.7.2+v1.36'
    function cmpVks(a, b) {
        function nums(s) { return (String(s || '').split('+')[0].match(/\d+/g) || []).map(Number); }
        var pa = nums(a), pb = nums(b);
        for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
            var d = (pa[i] || 0) - (pb[i] || 0);
            if (d !== 0) return d;
        }
        return 0;
    }
    // VKS versions newer than `vks` that DSM `dsm` supports with no Data Plane Bundle limit, nearest first.
    function unrestrictedVksAbove(dsm, vks) {
        var m = matrix(), out = [];
        if (!m || !m[dsm]) return out;
        Object.keys(m[dsm]).forEach(function (r) { if (m[dsm][r] === 'yes' && cmpVks(r, vks) > 0) out.push(r); });
        return out.sort(cmpVks);
    }

    // Highest DSM Data Plane Bundle allowed by a note such as
    // "Requires DSM 9.0.2.0 or older Data Plane Bundle" / "Requires DSM 9.0.0.0 Data Plane Bundle".
    function dpbCap(note) {
        var m = /Requires DSM\s+([0-9.]+)\s+(or older\s+)?Data Plane Bundle/i.exec(note || '');
        return m ? { version: m[1], orOlder: !!m[2] } : null;
    }

    function cmpVer(a, b) {
        var pa = String(a || '').split('.'), pb = String(b || '').split('.');
        for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
            var d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
            if (d !== 0) return d;
        }
        return 0;
    }
    function isNineOrHigher(v) { return (parseInt(String(v || '').split('.')[0], 10) || 0) >= 9; }

    // Does a Data Plane Bundle version break the limit in a matrix note?
    function dpbBreaches(dpb, cap) {
        if (!dpb || !cap) return false;
        return cap.orOlder ? cmpVer(dpb, cap.version) > 0 : cmpVer(dpb, cap.version) !== 0;
    }

    // VKS versions supported with `dsm` whose Data Plane Bundle limit (if any) still allows `dpb`.
    function compatibleVksForDpb(dsm, dpb) {
        var m = matrix(), out = [];
        if (!m || !m[dsm]) return out;
        Object.keys(m[dsm]).forEach(function (r) {
            var v = m[dsm][r];
            var s = typeof v === 'string' ? v : v.s;
            var cap = typeof v === 'string' ? null : dpbCap(v.n);
            if (s === 'yes' && !dpbBreaches(dpb, cap)) out.push(r);
        });
        return out;
    }

    function compatibleVks(dsm) {
        var m = matrix(), out = [];
        if (!m || !m[dsm]) return out;
        Object.keys(m[dsm]).forEach(function (r) {
            var v = m[dsm][r];
            if ((typeof v === 'string' ? v : v.s) === 'yes') out.push(r);
        });
        return out;
    }

    function evaluate(o) {
        o = o || {};
        var st = {
            current:  lookup(o.srcDsm, o.srcVks),   // today
            dsmFirst: lookup(o.tgtDsm, o.srcVks),   // DSM upgraded, VKS not yet
            vksFirst: lookup(o.srcDsm, o.tgtVks),   // VKS upgraded, DSM not yet
            target:   lookup(o.tgtDsm, o.tgtVks)    // end state
        };
        var known = st.current.status !== 'unknown' || st.target.status !== 'unknown';
        var ev = { input: o, states: st, order: 'unknown', intermediateVks: [], compatibleVksForTarget: [], notes: [] };
        // DSM <-> VKS interoperability only applies when both source and target DSM are 9.x or higher.
        if (!isNineOrHigher(o.srcDsm) || !isNineOrHigher(o.tgtDsm)) { ev.order = 'not-applicable'; return ev; }
        if (!matrix() || !known) return ev;

        if (st.target.status === 'no') {
            ev.order = 'target-unsupported';
            ev.compatibleVksForTarget = compatibleVks(o.tgtDsm);
        } else if (st.target.status === 'yes') {
            var dOk = st.dsmFirst.status === 'yes', vOk = st.vksFirst.status === 'yes';
            var dsmChanges = o.srcDsm !== o.tgtDsm, vksChanges = o.srcVks !== o.tgtVks;
            if (!dsmChanges || !vksChanges) ev.order = 'either';
            else if (dOk && vOk) ev.order = 'either';
            else if (dOk) ev.order = 'dsm-first';
            else if (vOk) ev.order = 'vks-first';
            else {
                ev.order = 'needs-intermediate';
                var a = compatibleVks(o.srcDsm), b = compatibleVks(o.tgtDsm);
                ev.intermediateVks = a.filter(function (x) { return b.indexOf(x) >= 0; });
            }
        }

        // Notes that apply to the states the plan will pass through.
        var path = ['current', 'target'];
        if (ev.order === 'dsm-first') path.splice(1, 0, 'dsmFirst');
        if (ev.order === 'vks-first') path.splice(1, 0, 'vksFirst');
        var seen = {};
        path.forEach(function (k) {
            var s = st[k];
            if (s.note && !seen[s.note + k]) {
                seen[s.note + k] = 1;
                var cap = dpbCap(s.note);
                ev.notes.push({ state: k, note: s.note, cap: cap, breach: k === 'current' && dpbBreaches(o.srcDpb, cap) });
            }
        });
        return ev;
    }

    function dsmVksLabel(d, v) { return 'DSM ' + d + ' with VKS ' + v; }

    // Extra first steps describing where the user's current Data Plane Bundle stands against the limit.
    function dpbStatusSteps(ev, dpbNotes) {
        var o = ev.input, e = escapeHtml, out = [];
        if (!o.srcDpb) {
            out.push('Select your current Data Plane Bundle version on the first page of the planner to confirm whether it is within this limit.');
            return out;
        }
        var breach = dpbNotes.filter(function (n) { return n.breach; })[0];
        if (breach) {
            var alt = compatibleVksForDpb(o.srcDsm, o.srcDpb).slice(0, 6).map(e).join(', ');
            var cleared = o.srcVks !== o.tgtVks && !dpbNotes.some(function (n) { return n.state === 'target'; });
            out.push('<strong>Your current Data Plane Bundle (DSM ' + e(o.srcDpb) + ') is newer than the limit for this combination (' + e(breach.note) + ').</strong> ' +
                (cleared ? 'The planned VKS upgrade to ' + e(o.tgtVks) + ' removes this restriction.'
                         : 'This DSM and VKS pairing is not supported as-is; use a VKS version without this restriction' + (alt ? ' (for example: ' + alt + ')' : '') + '.'));
        } else {
            out.push('Your current Data Plane Bundle (DSM ' + e(o.srcDpb) + ') is within the supported limit.');
        }
        return out;
    }

    // Findings are attached to the DSM phases the plan already has (no standalone phases):
    //   order / unsupported-pair notices -> the DSM appliance upgrade phase
    //   Data Plane Bundle limits         -> the "Upgrade DSM Data Plane Bundles" phase (notice + steps)
    function buildAnnotations(ev) {
        var out = { applianceNotices: [], dpbNotices: [], dpbSteps: [] };
        if (!ev || ev.order === 'unknown' || ev.order === 'not-applicable') return out;
        var o = ev.input, e = escapeHtml;

        if (ev.order === 'target-unsupported') {
            var list = ev.compatibleVksForTarget.slice(0, 8).map(e).join(', ') || 'none listed';
            var known = ev.states.target.incompatible;
            out.applianceNotices.push({
                type: 'warning',
                title: 'DSM ' + e(o.tgtDsm) + (known ? ' is incompatible with VKS ' : ' does not support VKS ') + e(o.tgtVks),
                bullets: [
                    known ? 'The Broadcom Interoperability Matrix marks this DSM / VKS combination as <strong>incompatible</strong> (known not to work). Do not use it, even temporarily.'
                          : 'This DSM / VKS combination is not supported in the Broadcom Interoperability Matrix.',
                    'Choose a VKS version that DSM ' + e(o.tgtDsm) + ' supports (' + list + '), or a different DSM target.'
                ]
            });
        } else if (ev.order === 'dsm-first' || ev.order === 'vks-first') {
            var dsmFirst = ev.order === 'dsm-first';
            out.applianceNotices.push({
                type: 'warning',
                title: 'DSM and VKS upgrade order matters',
                bullets: dsmFirst ? [
                    'Upgrade DSM to ' + e(o.tgtDsm) + ' <strong>before</strong> upgrading VKS from ' + e(o.srcVks) + ' to ' + e(o.tgtVks) + '. Current DSM ' + e(o.srcDsm) + ' does not support VKS ' + e(o.tgtVks) + '.'
                ] : [
                    'Upgrade VKS from ' + e(o.srcVks) + ' to ' + e(o.tgtVks) + ' <strong>before</strong> upgrading DSM to ' + e(o.tgtDsm) + '. DSM ' + e(o.tgtDsm) + ' does not support VKS ' + e(o.srcVks) + '.'
                ]
            });
        } else if (ev.order === 'needs-intermediate') {
            var inter = ev.intermediateVks.slice(0, 6).map(e).join(', ');
            out.applianceNotices.push({
                type: 'warning',
                title: 'No direct DSM / VKS upgrade order is supported',
                bullets: [
                    'DSM ' + e(o.tgtDsm) + ' does not support VKS ' + e(o.srcVks) + ', and DSM ' + e(o.srcDsm) + ' does not support VKS ' + e(o.tgtVks) + '.',
                    inter ? 'Upgrade VKS to an intermediate version supported by both DSM versions (' + inter + '), then upgrade DSM, then upgrade VKS to ' + e(o.tgtVks) + '.'
                          : 'No VKS version is supported by both DSM versions. Review the Broadcom Interoperability Matrix before proceeding.'
                ]
            });
        }

        // Only the end state and today's state matter for the Data Plane Bundle. Limits that hold only while DSM and
        // VKS are half upgraded do not apply: the Data Plane Bundle phase runs after the VKS upgrade phase.
        var capNotes   = ev.notes.filter(function (n) { return n.cap && (n.state === 'target' || n.state === 'current'); });
        var targetNote = capNotes.filter(function (n) { return n.state === 'target'; })[0];
        function who(n) {
            return n.state === 'current' ? dsmVksLabel(e(o.srcDsm), e(o.srcVks))
                : n.state === 'dsmFirst' ? dsmVksLabel(e(o.tgtDsm), e(o.srcVks))
                : n.state === 'vksFirst' ? dsmVksLabel(e(o.srcDsm), e(o.tgtVks))
                : dsmVksLabel(e(o.tgtDsm), e(o.tgtVks));
        }
        if (capNotes.length) {
            var bullets = capNotes.map(function (n) { return who(n) + ': ' + e(n.note); });
            out.dpbSteps = dpbStatusSteps(ev, capNotes);

            // Limit that still holds in the end state: offer both ways out.
            if (targetNote) {
                var capText = targetNote.cap.version + (targetNote.cap.orOlder ? ' or older' : '');
                var above = unrestrictedVksAbove(o.tgtDsm, o.tgtVks).slice(0, 4).map(e).join(', ');
                out.dpbSteps.push('<strong>Option A - stay on VKS ' + e(o.tgtVks) + ':</strong> keep the Data Plane Bundle at DSM <strong>' + e(capText) + '</strong>. Do not upgrade Data Plane Bundles or managed databases beyond DSM ' + e(targetNote.cap.version) + ' while this VKS version is in use.');
                if (above) {
                    out.dpbSteps.push('<strong>Option B - choose a VKS upgrade path that lands on ' + above + ' (or newer):</strong> DSM ' + e(o.tgtDsm) + ' has no Data Plane Bundle limit with those versions, so the Data Plane Bundles can be upgraded to ' + e(o.tgtDsm) + ' after the VKS upgrade. Compare the minimal and recommended VKS paths: only a path that lands on one of these versions removes the limit.');
                }
            }
            out.dpbNotices.push({
                type: 'warning',
                title: 'Data Plane Bundle limit from the VKS interoperability matrix',
                bullets: bullets
            });
        }
        return out;
    }

    // ---- DSM <-> vCenter plan check -------------------------------------------------------
    // vCenter 9.1.x supports only DSM 9.1.x; DSM 9.0.x supports vCenter up to 9.0.x. So DSM has to reach 9.1.x
    // BEFORE vCenter is upgraded to 9.1.x (for a 2.x source that means both DSM upgrades come first).
    function evaluateVcenter(o) {
        o = o || {};
        var L = lookupVcenterCI;
        var ev = {
            input: o, order: 'unknown',
            states: {
                current:  L(o.srcDsm, o.srcVc),
                vcFirst:  L(o.srcDsm, o.tgtVc),   // vCenter upgraded, DSM not yet
                dsmFirst: L(o.tgtDsm, o.srcVc),   // DSM upgraded, vCenter not yet
                target:   L(o.tgtDsm, o.tgtVc),
                hop:      /^2\./.test(o.srcDsm || '') ? L('9.0.1.0', o.tgtVc) : 'n/a'
            }
        };
        var s = ev.states;
        if (!vcMatrix() || !o.tgtVc) return ev;
        if (s.target === 'no') ev.order = 'target-unsupported';
        else if (s.vcFirst === 'no' && s.dsmFirst === 'no') ev.order = 'needs-intermediate';
        else if (s.vcFirst === 'no') ev.order = 'dsm-first';
        else if (s.dsmFirst === 'no') ev.order = 'vcenter-first';
        else ev.order = (s.current === 'no') ? 'current-unsupported' : 'either';
        return ev;
    }

    function annotateVcenter(phases, ev) {
        if (!ev || ev.order === 'unknown' || ev.order === 'either') return;
        var o = ev.input, e = escapeHtml, notices = [];
        var first = lastPhase(phases, ['dsm_appliance_step1']) || lastPhase(phases, ['dsm_appliance_upgrade']) || lastPhase(phases, ['dsm_dataplane']);
        if (!first) return;
        var migrate = !!first.ariaMigration;
        var two = /^2\./.test(o.srcDsm || '');

        if (migrate) {
            // "Build new DSM and migrate": the old DSM is kept (unmigrated) across the vCenter upgrade.
            if (ev.states.vcFirst === 'no') {
                notices.push({ type: 'warning', title: 'Existing DSM ' + e(o.srcDsm) + ' is not supported with vCenter ' + e(o.tgtVc),
                    bullets: ['The Broadcom Interoperability Matrix lists DSM ' + e(o.srcDsm) + ' with vCenter ' + e(o.tgtVc) + ' as unsupported. In this approach the existing DSM is only kept until the database is migrated to the new DSM; keep that window short and complete the migration promptly after the upgrade.'] });
            }
        } else if (ev.order === 'target-unsupported') {
            notices.push({ type: 'warning', title: 'DSM ' + e(o.tgtDsm) + ' is not supported with vCenter ' + e(o.tgtVc),
                bullets: ['This DSM / vCenter combination is not supported in the Broadcom Interoperability Matrix. Choose a different target version.'] });
        } else if (ev.order === 'dsm-first') {
            notices.push({ type: 'warning', title: 'Upgrade DSM before vCenter',
                bullets: [two
                    ? 'DSM ' + e(o.srcDsm) + ' cannot go directly to ' + e(o.tgtDsm) + '. Upgrade to 9.0.1.0 first, then to ' + e(o.tgtDsm) + ' &mdash; <strong>both before the vCenter upgrade</strong>. The matrix does not support DSM 9.0.x with vCenter ' + e(o.tgtVc) + '.'
                    : 'Complete the DSM upgrade to ' + e(o.tgtDsm) + ' <strong>before</strong> upgrading vCenter to ' + e(o.tgtVc) + '. DSM ' + e(o.srcDsm) + ' does not support vCenter ' + e(o.tgtVc) + '.'] });
        } else if (ev.order === 'vcenter-first') {
            notices.push({ type: 'warning', title: 'Upgrade vCenter before DSM',
                bullets: ['Upgrade vCenter to ' + e(o.tgtVc) + ' <strong>before</strong> upgrading DSM to ' + e(o.tgtDsm) + '. DSM ' + e(o.tgtDsm) + ' does not support vCenter ' + e(o.srcVc) + '.'] });
        } else if (ev.order === 'needs-intermediate') {
            notices.push({ type: 'warning', title: 'No direct DSM / vCenter upgrade order is supported',
                bullets: ['DSM ' + e(o.tgtDsm) + ' does not support vCenter ' + e(o.srcVc) + ', and DSM ' + e(o.srcDsm) + ' does not support vCenter ' + e(o.tgtVc) + '. Review the Broadcom Interoperability Matrix for an intermediate version.'] });
        } else if (ev.order === 'current-unsupported') {
            notices.push({ type: 'warning', title: 'DSM ' + e(o.srcDsm) + ' is not supported with vCenter ' + e(o.srcVc) + ' today',
                bullets: ['The current DSM / vCenter combination is not supported in the Broadcom Interoperability Matrix.'] });
        }
        if (notices.length) addNotices(first, notices);

        // The 2.x notice says the final DSM upgrade happens after vCenter; the matrix says it must come before.
        if (!migrate && two && ev.states.hop === 'no' && first.data && first.data.notices) {
            first.data.notices.forEach(function (n) {
                if (!n.bullets) return;
                n.bullets = n.bullets.map(function (b) {
                    return /after vCenter upgrade/i.test(b)
                        ? 'DSM 2.x cannot be upgraded directly to ' + e(o.tgtDsm) + '. Upgrade the DSM Provider Appliance to 9.0.1.0 first, then to ' + e(o.tgtDsm) + ' &mdash; both before the vCenter upgrade, because DSM 9.0.x does not support vCenter ' + e(o.tgtVc) + ' (Broadcom Interoperability Matrix).'
                        : b;
                });
            });
        }
    }

    function lastPhase(phases, ids) {
        for (var i = phases.length - 1; i >= 0; i--) {
            if (ids.indexOf(phases[i].componentId) >= 0 && phases[i].data) return phases[i];
        }
        return null;
    }
    function addNotices(phase, notices) {
        if (!phase || !notices.length) return;
        phase.data.notices = (phase.data.notices || []).concat(notices);
    }

    // Attach the findings to the DSM phases already present in `phases`.
    function annotatePhases(phases, ev) {
        var a = buildAnnotations(ev);
        var dataPlane = lastPhase(phases, ['dsm_dataplane']);
        var appliance = lastPhase(phases, ['dsm_appliance_upgrade', 'dsm_appliance_step1']) || dataPlane;
        addNotices(appliance, a.applianceNotices);
        addNotices(dataPlane, a.dpbNotices);
        if (dataPlane && a.dpbSteps.length) {
            dataPlane.data.steps = (dataPlane.data.steps || []).concat(a.dpbSteps);
        }
        return a;
    }

    var loadPromise = null;
    function loadData() {
        if (window._compatData) return Promise.resolve(window._compatData);
        if (!loadPromise) {
            loadPromise = fetch('compat-data.json')
                .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
                .then(function (d) { window._compatData = d; return d; })
                .catch(function (err) { console.warn('compat-data.json load failed:', err); return null; });
        }
        return loadPromise;
    }

    window.DsmVksCompat = {
        lookup: lookup,
        evaluate: evaluate,
        buildAnnotations: buildAnnotations,
        annotatePhases: annotatePhases,
        loadData: loadData,
        dpbCap: dpbCap,
        cmpVer: cmpVer,
        isNineOrHigher: isNineOrHigher,
        lookupVcenter: lookupVcenter,
        evaluateVcenter: evaluateVcenter,
        annotateVcenter: annotateVcenter,
        targetVcenter: targetVcenter,
        dsmAllowedWithVcenter: dsmAllowedWithVcenter,
        unrestrictedVksAbove: unrestrictedVksAbove,
        dpbBreaches: dpbBreaches
    };
})();
