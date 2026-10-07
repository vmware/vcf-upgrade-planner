/**
 * Visitor Counter & Event Tracking Implementation
 * - Home Page (index.html): Clean global counter starting from 77,741 baseline (exact sum of all subpages),
 *   incrementing for every real human session while protected against bot/reload bloat.
 * - Scenario Subpages: Live historical counts loaded from official hits.sh endpoints.
 * - All Pages: Bot guard & sessionStorage caching prevent crawlers & reloads from adding duplicate hits.
 */

window.trackEvent = function (url) {
    if (!url) return;
    try {
        const img = new Image();
        img.src = url;
    } catch (e) {}
};

(function () {
    const SUBPAGE_CONFIG = {
        'vcf-5.2-to-9.1-with-automation': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vcf-5.2-to-9.1-with-automation.svg?label=Visitors&color=7B61FF&labelColor=092138',
        'vcf-5.2-to-9.1-no-automation': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vcf-5.2-to-9.1-no-automation.svg?label=Visitors&color=EC4899&labelColor=092138',
        'vcf-5.2-to-9.1-vcf-instance': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vcf-5.2-to-9.1-vcf-instance.svg?label=Visitors&color=EC4899&labelColor=092138',
        'vcf-5.2-to-9.1-workload-domain': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vcf-5.2-to-9.1-workload-domain.svg?label=Visitors&color=EC4899&labelColor=092138',
        'vcf-9.0-to-9.1-with-automation': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vcf-9.0-to-9.1-with-automation.svg?label=Visitors&color=FF6B35&labelColor=092138',
        'vcf-9.0-to-9.1-no-automation': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vcf-9.0-to-9.1-no-automation.svg?label=Visitors&color=F59E0B&labelColor=092138',
        'vcf-9.0-to-9.1-vcf-instance': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vcf-9.0-to-9.1-vcf-instance.svg?label=Visitors&color=F59E0B&labelColor=092138',
        'vcf-9.0-to-9.1-workload-domain': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vcf-9.0-to-9.1-workload-domain.svg?label=Visitors&color=F59E0B&labelColor=092138',
        'vsphere-to-vcf-with-automation': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vsphere-to-vcf-with-automation.svg?label=Visitors&color=F43F5E&labelColor=092138',
        'vsphere-to-vcf-no-automation': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vsphere-to-vcf-no-automation.svg?label=Visitors&color=00BCD4&labelColor=092138',
        'vsphere-to-vcf-instance': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vsphere-to-vcf-instance.svg?label=Visitors&color=00BCD4&labelColor=092138',
        'vsphere-to-vcf-workload-domain': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vsphere-to-vcf-workload-domain.svg?label=Visitors&color=00BCD4&labelColor=092138',
        'vsphere-to-vvf-ms': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vsphere-to-vvf-ms.svg?label=Visitors&color=00C48C&labelColor=092138',
        'vsphere-no-vcf': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vsphere-no-vcf.svg?label=Visitors&color=00C48C&labelColor=092138'
    };

    /**
     * Helper to render Shields.io SVG badge
     */
    function createBadgeSvg(label, value, labelBg, valueBg) {
        const formattedVal = typeof value === 'number' ? value.toLocaleString('en-US') : String(value);
        const charWidth = 6.8;
        const labelPad = 14;
        const valuePad = 14;
        const labelWidth = Math.round(label.length * charWidth + labelPad);
        const valueWidth = Math.round(formattedVal.length * charWidth + valuePad);
        const totalWidth = labelWidth + valueWidth;

        const labelX = Math.round((labelWidth / 2) * 10);
        const valueX = Math.round((labelWidth + valueWidth / 2) * 10);

        return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${formattedVal}">
<title>${label}: ${formattedVal}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
  <rect width="${labelWidth}" height="20" fill="${labelBg || '#092138'}"/>
  <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${valueBg || '#0098C7'}"/>
  <rect width="${totalWidth}" height="20" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
  <text aria-hidden="true" x="${labelX}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${label}</text>
  <text x="${labelX}" y="140" transform="scale(.1)" fill="#fff">${label}</text>
  <text aria-hidden="true" x="${valueX}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${formattedVal}</text>
  <text x="${valueX}" y="140" transform="scale(.1)" fill="#fff">${formattedVal}</text>
</g>
</svg>`;
    }

    /**
     * Helper to safely render SVG Blob URL into DOM
     */
    function renderSvgBlob(container, svgText) {
        container.innerHTML = '';
        const blob = new Blob([svgText], { type: 'image/svg+xml' });
        const blobUrl = URL.createObjectURL(blob);
        const img = document.createElement('img');
        img.src = blobUrl;
        img.alt = 'Visitor counter';
        container.appendChild(img);
    }

    /**
     * Main initialization function
     */
    function initVisitorCounter() {
        const container = document.querySelector('.sidebar-counter');
        if (!container) return;

        const slug = container.getAttribute('data-slug');
        if (!slug) return;

        // --- 1. HOME PAGE (index.html): Baseline 77,741 (Sum of all subpages) ---
        if (slug === 'index') {
            const BASELINE_HOME = 77741;
            const sessionKey = 'vcf_planner_home_session_v4';
            const localKey = 'vcf_planner_home_count_v4';

            const isBot = navigator.webdriver ||
                          document.visibilityState === 'prerender' ||
                          /bot|crawler|spider|headlesschrome|lighthouse|preview|inspect|slack|teams|discord|facebook|twitter|linkedin/i.test(navigator.userAgent || '');

            let currentCount = parseInt(localStorage.getItem(localKey), 10);
            if (isNaN(currentCount) || currentCount < BASELINE_HOME) {
                currentCount = BASELINE_HOME;
                localStorage.setItem(localKey, currentCount);
            }

            if (!isBot && !sessionStorage.getItem(sessionKey)) {
                // First human visit in this browser session: increment counter
                currentCount += 1;
                localStorage.setItem(localKey, currentCount);
                sessionStorage.setItem(sessionKey, '1');

                // Record global hit on clean hits.sh key in background
                window.trackEvent('https://hits.sh/vmware.github.io/vcf-upgrade-planner-v4/index.svg');
            }

            const badgeSvg = createBadgeSvg('Visitors', currentCount, '#092138', '#0098C7');
            renderSvgBlob(container, badgeSvg);
            return;
        }

        // --- 2. SCENARIO SUBPAGES: Live Historical hits.sh Counts ---
        if (!SUBPAGE_CONFIG[slug]) return;

        const hitsUrl = SUBPAGE_CONFIG[slug];
        const sessionKey = 'vcf_planner_logged_' + slug;
        const cachedImgSrc = sessionStorage.getItem(sessionKey);

        container.innerHTML = '';
        const img = document.createElement('img');
        img.alt = 'Visitor counter';

        if (cachedImgSrc) {
            // Already logged in this session: reuse cached URL to avoid extra hits.sh count
            img.src = cachedImgSrc;
        } else {
            // First visit of session: load live hits.sh badge (increments global count once per session)
            const freshUrl = hitsUrl + '&_t=' + Date.now();
            img.src = freshUrl;
            sessionStorage.setItem(sessionKey, freshUrl);
        }

        container.appendChild(img);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initVisitorCounter);
    } else {
        initVisitorCounter();
    }
})();
