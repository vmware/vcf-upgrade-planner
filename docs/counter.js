/**
 * Visitor Counter Implementation with sessionStorage, Bot Guard, and Baseline Offsets
 * Safe DOM rendering using Blob URLs adhering to AGENTS.md security guidelines.
 */

/**
 * Reliable Event Tracking Helper
 * Replaces new Image().src = ... to prevent request cancellations or garbage collection drops
 */
window.trackEvent = function (url) {
    if (!url) return;
    try {
        if (typeof fetch === 'function') {
            fetch(url, { mode: 'no-cors', cache: 'no-cache' }).catch(function () {});
        } else {
            const img = new Image();
            img.src = url;
        }
    } catch (e) {
        const img = new Image();
        img.src = url;
    }
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
        const sessionKey = 'vcf_planner_badge_svg_v2_' + slug;
        const cachedSvg = sessionStorage.getItem(sessionKey);

        // 1. Return cached SVG if present in sessionStorage for this tab session
        if (cachedSvg) {
            renderSvgBadge(container, cachedSvg);
            return;
        }

        // 2. Bot Guard: Check if visitor is a known bot / crawler / headless browser
        const isBot = navigator.webdriver ||
                      document.visibilityState === 'prerender' ||
                      /bot|crawler|spider|headlesschrome|lighthouse|preview|inspect|slack|teams|discord|facebook|twitter|linkedin/i.test(navigator.userAgent || '');

        if (isBot) {
            // Display baseline count without hitting hits.sh
            const botSvg = createBadgeSvg(config.label, config.baseline, '#092138', config.color);
            renderSvgBadge(container, botSvg);
            return;
        }

        // 3. New clean hit tracking URL on hits.sh
        const hitsUrl = `https://hits.sh/vcf-planner-v2/${slug}.svg`;

        fetch(hitsUrl)
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.text();
            })
            .then(svgText => {
                // Parse the raw hits count N from the returned hits.sh SVG
                let rawHits = 1;
                const match = svgText.match(/<title>Visitors:\s*([\d,]+)<\/title>/i) ||
                              svgText.match(/aria-label="Visitors:\s*([\d,]+)"/i) ||
                              svgText.match(/>([\d,]+)<\/text>/i);
                if (match) {
                    rawHits = parseInt(match[1].replace(/,/g, ''), 10) || 1;
                }

                // Compute true display count = baseline + (rawHits - 1)
                const totalVisits = config.baseline + (rawHits - 1);
                const finalBadgeSvg = createBadgeSvg(config.label, totalVisits, '#092138', config.color);

                // Cache SVG badge in sessionStorage
                sessionStorage.setItem(sessionKey, finalBadgeSvg);
                renderSvgBadge(container, finalBadgeSvg);
            })
            .catch(err => {
                console.warn('Visitor counter fetch fallback:', err);
                const fallbackSvg = createBadgeSvg(config.label, config.baseline, '#092138', config.color);
                renderSvgBadge(container, fallbackSvg);
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initVisitorCounter);
    } else {
        initVisitorCounter();
    }
})();
