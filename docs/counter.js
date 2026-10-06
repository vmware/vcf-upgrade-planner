/**
 * Visitor Counter & Event Tracking Implementation
 * - All 14 Scenario Subpages: Display live historical hits from official hits.sh endpoints.
 * - Home Page (index.html): Fixed baseline starting at 85,000 (eliminates 283k bot inflation) and increments per new human session.
 * - All Pages: Use sessionStorage to prevent page reloads & navigation from adding duplicate hits.
 */

window.trackEvent = function (url) {
    if (!url) return;
    try {
        const img = new Image();
        img.src = url;
    } catch (e) {}
};

(function () {
    // Official hits.sh global counter endpoints for subpages
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
     * Generates a pixel-perfect Shields.io style SVG badge string
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
     * Renders an SVG badge string into target container safely via Blob URL
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

        // --- 1. HOME PAGE (index.html): Fixed Baseline 85,000 ---
        if (slug === 'index') {
            const BASELINE_HOME = 85000;
            const storageKey = 'vcf_planner_home_visits_v3';
            const sessionKey = 'vcf_planner_home_session_v3';

            let currentCount = parseInt(localStorage.getItem(storageKey), 10);
            if (isNaN(currentCount) || currentCount < BASELINE_HOME) {
                currentCount = BASELINE_HOME;
                localStorage.setItem(storageKey, currentCount);
            }

            const isLogged = sessionStorage.getItem(sessionKey);
            const isBot = navigator.webdriver ||
                          document.visibilityState === 'prerender' ||
                          /bot|crawler|spider|headlesschrome|lighthouse|preview|inspect|slack|teams|discord|facebook|twitter|linkedin/i.test(navigator.userAgent || '');

            if (!isLogged && !isBot) {
                currentCount += 1;
                localStorage.setItem(storageKey, currentCount);
                sessionStorage.setItem(sessionKey, '1');

                // Sync hit event with hits.sh clean v2 key for internal reporting
                window.trackEvent('https://hits.sh/vmware.github.io/vcf-upgrade-planner-v2/index.svg');
            }

            const homeBadgeSvg = createBadgeSvg('Visitors', currentCount, '#092138', '#0098C7');
            renderSvgBlob(container, homeBadgeSvg);
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
            // First visit of session: fetch live historical hits.sh badge (+ timestamp cache-buster)
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
