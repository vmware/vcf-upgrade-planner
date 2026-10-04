/**
 * Visitor Counter Implementation with sessionStorage, Bot Guard, and Baseline Offsets
 * Safe DOM rendering using Blob URLs adhering to AGENTS.md security guidelines.
 */

/**
 * Reliable Event Tracking Helper
 * Uses Image() loading to avoid CORS restrictions and prevent fetch() errors
 */
window.trackEvent = function (url) {
    if (!url) return;
    try {
        const img = new Image();
        img.src = url;
    } catch (e) {}
};

(function () {
    // Baseline starting visitor numbers per page slug
    const COUNTER_CONFIG = {
        'index': { baseline: 85000, label: 'Visitors', color: '#0098C7' },
        'vcf-5.2-to-9.1-with-automation': { baseline: 5988, label: 'Visitors', color: '#7B61FF' },
        'vcf-5.2-to-9.1-no-automation': { baseline: 5059, label: 'Visitors', color: '#EC4899' },
        'vcf-5.2-to-9.1-vcf-instance': { baseline: 2723, label: 'Visitors', color: '#EC4899' },
        'vcf-5.2-to-9.1-workload-domain': { baseline: 2079, label: 'Visitors', color: '#EC4899' },
        'vcf-9.0-to-9.1-with-automation': { baseline: 7059, label: 'Visitors', color: '#FF6B35' },
        'vcf-9.0-to-9.1-no-automation': { baseline: 5005, label: 'Visitors', color: '#F59E0B' },
        'vcf-9.0-to-9.1-vcf-instance': { baseline: 2654, label: 'Visitors', color: '#F59E0B' },
        'vcf-9.0-to-9.1-workload-domain': { baseline: 1827, label: 'Visitors', color: '#F59E0B' },
        'vsphere-to-vcf-with-automation': { baseline: 8481, label: 'Visitors', color: '#F43F5E' },
        'vsphere-to-vcf-no-automation': { baseline: 10858, label: 'Visitors', color: '#00BCD4' },
        'vsphere-to-vcf-instance': { baseline: 2047, label: 'Visitors', color: '#00BCD4' },
        'vsphere-to-vcf-workload-domain': { baseline: 2414, label: 'Visitors', color: '#00BCD4' },
        'vsphere-to-vvf-ms': { baseline: 5401, label: 'Visitors', color: '#00C48C' },
        'vsphere-no-vcf': { baseline: 14376, label: 'Visitors', color: '#00C48C' }
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
    function renderSvgBadge(container, svgText) {
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
        if (!slug || !COUNTER_CONFIG[slug]) return;

        const config = COUNTER_CONFIG[slug];
        const storageKey = 'vcf_planner_visits_v2_' + slug;
        const sessionKey = 'vcf_planner_session_v2_' + slug;

        // Retrieve stored visit total or initialize with baseline
        let storedCount = parseInt(localStorage.getItem(storageKey), 10);
        if (isNaN(storedCount) || storedCount < config.baseline) {
            storedCount = config.baseline;
            localStorage.setItem(storageKey, storedCount);
        }

        const isSessionLogged = sessionStorage.getItem(sessionKey);
        const isBot = navigator.webdriver ||
                      document.visibilityState === 'prerender' ||
                      /bot|crawler|spider|headlesschrome|lighthouse|preview|inspect|slack|teams|discord|facebook|twitter|linkedin/i.test(navigator.userAgent || '');

        if (!isSessionLogged && !isBot) {
            // First visit of human session: increment total count
            storedCount += 1;
            localStorage.setItem(storageKey, storedCount);
            sessionStorage.setItem(sessionKey, '1');

            // Send hits.sh event hit for external reporting portal
            const hitsUrl = `https://hits.sh/vmware.github.io/vcf-upgrade-planner-v2/${slug}.svg`;
            window.trackEvent(hitsUrl);
        }

        // Render badge SVG with updated counter safely
        const badgeSvg = createBadgeSvg(config.label, storedCount, '#092138', config.color);
        renderSvgBadge(container, badgeSvg);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initVisitorCounter);
    } else {
        initVisitorCounter();
    }
})();
