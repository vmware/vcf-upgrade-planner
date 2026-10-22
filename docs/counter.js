/**
 * Visitor Counter & Event Tracking Implementation
 * - Scenario Subpages: Load live historical counts from official hits.sh endpoints.
 *   On first human session visit, increments the subpage count AND increments the shared clean index counter on hits.sh.
 * - Home Page (index.html): Displays live count directly from the clean hits.sh subpage-driven index endpoint.
 * - Bot Guard & Session Control: Uses sessionStorage to prevent page reloads & crawlers from double-counting.
 * - No local storage used: Pure global hits.sh synchronization.
 */

window.trackEvent = function (url) {
    if (!url) return;
    try {
        const img = new Image();
        img.src = url;
    } catch (e) {}
};

(function () {
    const INDEX_HITS_URL = 'https://hits.sh/vmware.github.io/vcf-upgrade-planner-subpages/index.svg?label=Visitors&color=0098C7&labelColor=092138';

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
        'vsphere-no-vcf': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vsphere-no-vcf.svg?label=Visitors&color=00C48C&labelColor=092138',
        'vks-upgrade-planner': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/vks-upgrade-planner.svg?label=Visitors&color=0088B5&labelColor=092138',
        'supervisor-vks-config': 'https://hits.sh/vmware.github.io/vcf-upgrade-planner/supervisor-vks-config.svg?label=Supervisor%2FVKS%20Configs&color=0088B5&labelColor=092138'
    };

    /**
     * Track when user selects/configures Supervisor, VKS, or VKR on index or subpages
     */
    window.trackSupervisorConfig = function() {
        const sessionKey = 'vcf_planner_logged_supervisor_vks_config';
        if (!sessionStorage.getItem(sessionKey)) {
            const hitsUrl = SUBPAGE_CONFIG['supervisor-vks-config'];
            if (hitsUrl) {
                window.trackEvent(hitsUrl + '&_t=' + Date.now());
                sessionStorage.setItem(sessionKey, 'true');
            }
        }
    };

    /**
     * Main initialization function
     */
    function initVisitorCounter() {
        const containers = document.querySelectorAll('.sidebar-counter, .vks-counter, [data-slug]');
        if (!containers || containers.length === 0) return;

        containers.forEach(container => {
            const slug = container.getAttribute('data-slug');
            if (!slug) return;

            const sessionKey = 'vcf_planner_logged_' + slug;
            const cachedImgSrc = sessionStorage.getItem(sessionKey);

            container.innerHTML = '';
            const img = document.createElement('img');
            img.alt = 'Visitor counter';

            // --- 1. HOME PAGE (index.html): Display clean subpage-driven index counter from hits.sh ---
            if (slug === 'index') {
                if (cachedImgSrc) {
                    img.src = cachedImgSrc;
                } else {
                    const freshUrl = INDEX_HITS_URL + '&_t=' + Date.now();
                    img.src = freshUrl;
                    sessionStorage.setItem(sessionKey, freshUrl);
                }
                container.appendChild(img);
                return;
            }

            // --- 2. SCENARIO SUBPAGES & VKS PLANNER: Live Historical hits.sh Counts ---
            if (!SUBPAGE_CONFIG[slug]) return;

            const hitsUrl = SUBPAGE_CONFIG[slug];

            if (cachedImgSrc) {
                // Already logged in this session: reuse cached URL to avoid duplicate counts
                img.src = cachedImgSrc;
            } else {
                // First visit of session: load badge AND increment counter on hits.sh
                const freshUrl = hitsUrl + '&_t=' + Date.now();
                img.src = freshUrl;
                sessionStorage.setItem(sessionKey, freshUrl);

                if (slug !== 'supervisor-vks-config') {
                    // Increment clean index counter on hits.sh whenever subpage is visited in a new session
                    window.trackEvent(INDEX_HITS_URL + '&_t=' + Date.now());
                }
            }

            container.appendChild(img);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initVisitorCounter);
    } else {
        initVisitorCounter();
    }
})();