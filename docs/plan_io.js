/**
 * VCF Upgrade Planner - Configuration Export & Import Utility (JSON)
 * Allows users to export their environment selections and plan page sub-component choices
 * to a JSON file, and re-import them to edit or add missed components.
 */

let _isSyncing = false;

/**
 * Normalizes dynamic, replaced, or virtual plan page filenames (e.g. VCF-9.1-to-VCF-9.1.0100-...)
 * to the actual physical HTML file on disk.
 */
function normalizePlanPageFilename(pageName) {
    if (!pageName || typeof pageName !== 'string') return '';
    let clean = pageName.trim();
    // Handle query strings, hashes, or path prefixes
    clean = clean.split('/').pop().split('?')[0].split('#')[0];
    try {
        clean = decodeURIComponent(clean);
    } catch(e) {}

    if (!clean || clean === 'index.html') return 'index.html';

    const exactFiles = [
        'vks-upgrade-planner.html',
        'vSphere and VCF Operations to VVF 9.1 (with VCF Management Services).html',
        'vSphere and VCF Operations to VVF 9.1 (without VCF Management Services).html',
        'vSphere-to-VCF-9.1-(VCF-Automation-included).html',
        'vSphere-to-VCF-9.1-(VCF-Automation-not-included).html',
        'vSphere-to-VCF-9.1-(Additonal-VCF-Instance).html',
        'vSphere-to-VCF-9.1-(import).html',
        'VCF-5.2-to-VCF-9.1-(VCF-Automation-included).html',
        'VCF-5.2-to-VCF-9.1-(VCF-Automation-not-included).html',
        'VCF-5.2-to-VCF-9.1-(VCF-Instance).html',
        'VCF-5.2-to-VCF-9.1-(Workload-Domain).html',
        'VCF-9.0-to-VCF-9.1-(VCF-Automation-included).html',
        'VCF-9.0-to-VCF-9.1-(VCF-Automation-not-included).html',
        'VCF-9.0-to-VCF-9.1-(VCF-Instance).html',
        'VCF-9.0-to-VCF-9.1-(Workload-Domain).html'
    ];

    if (exactFiles.includes(clean)) {
        return clean;
    }

    const lower = clean.toLowerCase();

    // 1. VCF 5.2 source pages
    if (lower.includes('5.2')) {
        if (lower.includes('automation-included') || lower.includes('with-automation')) {
            return 'VCF-5.2-to-VCF-9.1-(VCF-Automation-included).html';
        }
        if (lower.includes('automation-not-included') || lower.includes('no-automation')) {
            return 'VCF-5.2-to-VCF-9.1-(VCF-Automation-not-included).html';
        }
        if (lower.includes('instance')) {
            return 'VCF-5.2-to-VCF-9.1-(VCF-Instance).html';
        }
        if (lower.includes('workload-domain') || lower.includes('workload')) {
            return 'VCF-5.2-to-VCF-9.1-(Workload-Domain).html';
        }
    }

    // 2. vSphere source pages
    if (lower.includes('vsphere')) {
        if (lower.includes('automation-included')) {
            return 'vSphere-to-VCF-9.1-(VCF-Automation-included).html';
        }
        if (lower.includes('automation-not-included')) {
            return 'vSphere-to-VCF-9.1-(VCF-Automation-not-included).html';
        }
        if (lower.includes('additonal-vcf-instance') || lower.includes('additional-vcf-instance') || lower.includes('instance')) {
            return 'vSphere-to-VCF-9.1-(Additonal-VCF-Instance).html';
        }
        if (lower.includes('import')) {
            return 'vSphere-to-VCF-9.1-(import).html';
        }
        if (lower.includes('with vcf management services')) {
            return 'vSphere and VCF Operations to VVF 9.1 (with VCF Management Services).html';
        }
        if (lower.includes('without vcf management services')) {
            return 'vSphere and VCF Operations to VVF 9.1 (without VCF Management Services).html';
        }
    }

    // 3. VCF 9.x source pages (e.g. VCF 9.0, VCF 9.1, VCF 9.1.x, VCF 9.1.0, VCF 9.1.0100)
    if (lower.includes('automation-included') || lower.includes('with-automation')) {
        return 'VCF-9.0-to-VCF-9.1-(VCF-Automation-included).html';
    }
    if (lower.includes('automation-not-included') || lower.includes('no-automation')) {
        return 'VCF-9.0-to-VCF-9.1-(VCF-Automation-not-included).html';
    }
    if (lower.includes('instance')) {
        return 'VCF-9.0-to-VCF-9.1-(VCF-Instance).html';
    }
    if (lower.includes('workload-domain') || lower.includes('workload')) {
        return 'VCF-9.0-to-VCF-9.1-(Workload-Domain).html';
    }

    return clean;
}

/**
 * Clears all saved planner selections from localStorage while preserving user preferences like theme.
 */
function clearPlannerStorage() {
    try {
        const theme = localStorage.getItem('theme');
        localStorage.clear();
        if (theme) {
            localStorage.setItem('theme', theme);
        }
    } catch (e) {
        console.error('Error clearing planner storage:', e);
    }

    if (typeof window !== 'undefined') {
        window.selectedAdvancedProducts = {};
        window.deploymentType = 'simple';
        window.deploymentSize = 'small';
    }
}

/**
 * Resets all planner state and navigates back to the index page.
 * @param {boolean} [confirmNeeded=false] - Whether to prompt the user before clearing state.
 */
function startOverPlanner(confirmNeeded = false) {
    if (confirmNeeded) {
        if (!confirm('Start over? This will return to the beginning and clear all selections.')) {
            return;
        }
    }
    clearPlannerStorage();
    window.location.href = 'index.html';
}

function goToPlanPage(url, isImported) {
    if (url) {
        const targetUrl = normalizePlanPageFilename(url);
        localStorage.setItem('selected-plan-page', targetUrl);
        if (!isImported) {
            // Fresh run from index page without JSON import:
            // Default Deployment Configuration to Simple & Small, and reset optional feature/component selections
            localStorage.removeItem('selected-advanced-products');
            localStorage.setItem('deployment-type', 'simple');
            localStorage.setItem('deployment-size', 'small');
            window.deploymentType = 'simple';
            window.deploymentSize = 'small';
            window.selectedAdvancedProducts = {};
        }
        window.location.href = targetUrl;
    }
}

function savePlanPageStateToStorage() {
    if (_isSyncing) return;

    const haRadio = document.getElementById('haRadio');
    const simpleRadio = document.getElementById('simpleRadio');
    const depSizeEl = document.getElementById('deploymentSize');

    if (haRadio && haRadio.checked) {
        localStorage.setItem('deployment-type', 'ha');
    } else if (simpleRadio && simpleRadio.checked) {
        localStorage.setItem('deployment-type', 'simple');
    } else {
        localStorage.setItem('deployment-type', 'simple');
    }

    if (depSizeEl && depSizeEl.value) {
        localStorage.setItem('deployment-size', depSizeEl.value);
    } else {
        localStorage.setItem('deployment-size', 'small');
    }

    if (window.selectedAdvancedProducts) {
        const cleanProds = {};
        Object.keys(window.selectedAdvancedProducts).forEach(k => {
            if (window.selectedAdvancedProducts[k] === true) {
                cleanProds[k] = true;
            }
        });
        localStorage.setItem('selected-advanced-products', JSON.stringify(cleanProds));
    }

    const depotCheck = document.getElementById('depotCheck');
    if (depotCheck) {
        localStorage.setItem('depot-selected', depotCheck.checked ? 'true' : 'false');
    }

    const vidbCheck = document.getElementById('vidbCheck');
    if (vidbCheck) {
        localStorage.setItem('vidb-selected', vidbCheck.checked ? 'true' : 'false');
    }
    if (typeof window.vidbIsEmbedded !== 'undefined' && window.vidbIsEmbedded !== null) {
        localStorage.setItem('vidb-is-embedded', window.vidbIsEmbedded === true ? 'true' : 'false');
    } else {
        localStorage.removeItem('vidb-is-embedded');
    }
    if (typeof window.vidbOnOverlay !== 'undefined' && window.vidbOnOverlay !== null) {
        localStorage.setItem('vidb-on-overlay', window.vidbOnOverlay === true ? 'true' : 'false');
    } else {
        localStorage.removeItem('vidb-on-overlay');
    }
}

function exportPlanConfigJSON() {
    try {
        savePlanPageStateToStorage();
        const storageData = {};
        const keysToSave = [
            'starting-point', 'vsphere-intent', 'vcf-intent',
            'vcenter-version', 'esx-version',
            'nsx-selected', 'nsx-version',
            'operations-selected', 'operations-version',
            'automation-selected', 'automation-version',
            'vxrail-selected', 'vxrail-version',
            'vcd-selected', 'supervisor-selected', 'supervisor-version',
            'vks-selected', 'vks-version',
            'srm-selected', 'srm-version',
            'replication-selected', 'replication-version',
            'avi-selected', 'avi-version',
            'vcf-version', 'vcf-detailed-version', 'target-vcf91-version',
            'selected-plan-page', 'deployment-type', 'deployment-size',
            'depot-selected', 'vidb-selected', 'vidb-is-embedded', 'vidb-on-overlay',
            'use-recommended-path', 'target-supervisor-version', 'target-vks-version', 'target-vkr-version'
        ];

        keysToSave.forEach(k => {
            const val = localStorage.getItem(k);
            if (val !== null) storageData[k] = val;
        });

        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.startsWith('fleet_check_') || key.startsWith('vxrail-'))) {
                storageData[key] = localStorage.getItem(key);
            }
        }

        // Determine current page filename if on a plan page
        let currentPlanPage = localStorage.getItem('selected-plan-page') || '';
        const pathName = decodeURIComponent(window.location.pathname.split('/').pop() || '');
        if (pathName && pathName !== 'index.html' && pathName.endsWith('.html')) {
            currentPlanPage = normalizePlanPageFilename(pathName);
            localStorage.setItem('selected-plan-page', currentPlanPage);
            storageData['selected-plan-page'] = currentPlanPage;
        } else if (currentPlanPage) {
            currentPlanPage = normalizePlanPageFilename(currentPlanPage);
            storageData['selected-plan-page'] = currentPlanPage;
        }

        // Determine deploymentSize cleanly as a string (default: small)
        let currentDeploymentSize = localStorage.getItem('deployment-size') || 'small';
        const depSizeSelect = document.getElementById('deploymentSize');
        if (depSizeSelect && depSizeSelect.value && typeof depSizeSelect.value === 'string') {
            currentDeploymentSize = depSizeSelect.value;
        } else if (typeof window.deploymentSize === 'string') {
            currentDeploymentSize = window.deploymentSize;
        }

        // Determine deploymentType cleanly (default: simple)
        let currentDeploymentType = localStorage.getItem('deployment-type') || 'simple';
        const haRadio = document.getElementById('haRadio');
        const simpleRadio = document.getElementById('simpleRadio');
        if (currentDeploymentSize === 'medium' || currentDeploymentSize === 'large') {
            currentDeploymentType = 'ha';
        } else if (simpleRadio && simpleRadio.checked) {
            currentDeploymentType = 'simple';
        } else if (haRadio && haRadio.checked) {
            currentDeploymentType = 'ha';
        }

        storageData['deployment-type'] = currentDeploymentType;
        storageData['deployment-size'] = currentDeploymentSize;

        // Get selected advanced products (only include active 'true' selections)
        let selectedAdvancedProducts = {};
        const rawProds = window.selectedAdvancedProducts || {};
        Object.keys(rawProds).forEach(k => {
            if (rawProds[k] === true) selectedAdvancedProducts[k] = true;
        });
        if (!Object.keys(selectedAdvancedProducts).length) {
            const storedProds = localStorage.getItem('selected-advanced-products');
            if (storedProds) {
                try {
                    const parsed = JSON.parse(storedProds);
                    Object.keys(parsed).forEach(k => {
                        if (parsed[k] === true) selectedAdvancedProducts[k] = true;
                    });
                } catch(e) {}
            }
        }

        const depotCheckEl = document.getElementById('depotCheck');
        const depotSelectedVal = depotCheckEl ? depotCheckEl.checked : (localStorage.getItem('depot-selected') === 'true');

        const vidbCheckEl = document.getElementById('vidbCheck');
        const vidbSelectedVal = vidbCheckEl ? vidbCheckEl.checked : (localStorage.getItem('vidb-selected') === 'true');
        const vidbEmbeddedVal = (typeof window.vidbIsEmbedded !== 'undefined' && window.vidbIsEmbedded !== null)
            ? window.vidbIsEmbedded
            : (localStorage.getItem('vidb-is-embedded') === 'true' ? true : (localStorage.getItem('vidb-is-embedded') === 'false' ? false : null));
        const vidbOverlayVal = (typeof window.vidbOnOverlay !== 'undefined' && window.vidbOnOverlay !== null)
            ? window.vidbOnOverlay
            : (localStorage.getItem('vidb-on-overlay') === 'true' ? true : (localStorage.getItem('vidb-on-overlay') === 'false' ? false : null));

        storageData['depot-selected'] = depotSelectedVal ? 'true' : 'false';
        storageData['vidb-selected'] = vidbSelectedVal ? 'true' : 'false';
        if (vidbSelectedVal) {
            selectedAdvancedProducts['vidb'] = true;
        }

        const fullExport = {
            meta: {
                appName: "VCF Upgrade Planner",
                schemaVersion: "1.0",
                exportedAt: new Date().toISOString()
            },
            selectedPlanPage: currentPlanPage,
            environmentConfig: storageData,
            planPageConfig: {
                selectedAdvancedProducts: selectedAdvancedProducts,
                deploymentType: currentDeploymentType,
                deploymentSize: currentDeploymentSize,
                depotSelected: depotSelectedVal,
                vidbSelected: vidbSelectedVal,
                vidbIsEmbedded: vidbEmbeddedVal,
                vidbOnOverlay: vidbOverlayVal
            }
        };

        const defaultFileName = `vcf-upgrade-plan-config-${new Date().toISOString().slice(0, 10)}.json`;
        let userFileName = prompt("Enter a filename for your JSON export:", defaultFileName);
        
        // If user cancels the prompt, cancel export
        if (userFileName === null) return;
        
        userFileName = userFileName.trim();
        if (!userFileName) {
            userFileName = defaultFileName;
        }
        if (!userFileName.toLowerCase().endsWith('.json')) {
            userFileName += '.json';
        }

        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(fullExport, null, 2));
        const downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", userFileName);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
    } catch (err) {
        alert("Error exporting configuration: " + err.message);
    }
}

function syncPlanPageFromStorage() {
    _isSyncing = true;
    try {
        const simpleRadio = document.getElementById('simpleRadio');
        const haRadio = document.getElementById('haRadio');
        const depSizeEl = document.getElementById('deploymentSize');

        // 1. Get stored deployment-size & deployment-type (default: simple, small)
        let depSize = localStorage.getItem('deployment-size') || 'small';
        let depType = localStorage.getItem('deployment-type') || 'simple';

        // High availability is required if size is explicit Medium or Large
        if (depSize === 'medium' || depSize === 'large') {
            depType = 'ha';
            localStorage.setItem('deployment-type', 'ha');
        }

        // 2. Set Radio Button states cleanly without trigger events
        if (depType === 'ha' && haRadio) {
            haRadio.checked = true;
            if (simpleRadio) simpleRadio.checked = false;
            window.deploymentType = 'ha';
        } else if (simpleRadio) {
            simpleRadio.checked = true;
            if (haRadio) haRadio.checked = false;
            window.deploymentType = 'simple';
        }

        // 3. Ensure deploymentSize dropdown contains and selects restored value
        if (typeof updateDeploymentSize === 'function') {
            updateDeploymentSize();
        }
        if (depSizeEl) {
            let hasOpt = Array.from(depSizeEl.options).some(opt => opt.value === depSize);
            if (!hasOpt) {
                const opt = document.createElement('option');
                opt.value = depSize;
                opt.textContent = depSize.charAt(0).toUpperCase() + depSize.slice(1);
                depSizeEl.appendChild(opt);
            }
            depSizeEl.value = depSize;
        }
        window.deploymentSize = depSize;

        // 4. Restore selectedAdvancedProducts & gSelected
        const rawProds = localStorage.getItem('selected-advanced-products');
        let savedProds = {};
        if (rawProds) {
            try { savedProds = JSON.parse(rawProds); } catch(e) {}
        }
        window.selectedAdvancedProducts = savedProds;

        if (typeof gSelected !== 'undefined') {
            gSelected.clear();
            Object.keys(savedProds).forEach(id => {
                if (savedProds[id] === true) {
                    gSelected.add(id);
                }
            });
            if (typeof gBuildIndex === 'function') gBuildIndex();
            if (typeof gSyncCheckboxes === 'function') gSyncCheckboxes();
            if (typeof gUpdateSummary === 'function') gUpdateSummary();
            if (typeof gRender === 'function') gRender('');
        }

        // 5. Restore Software Depot & Identity Broker selections & question UI state
        const depotCheck = document.getElementById('depotCheck');
        const storedDepotSel = localStorage.getItem('depot-selected');
        if (depotCheck) {
            if (storedDepotSel === 'true') {
                depotCheck.checked = true;
            } else if (storedDepotSel === 'false') {
                depotCheck.checked = false;
            }
        }

        const vidbCheck = document.getElementById('vidbCheck');
        const storedVidbSel = localStorage.getItem('vidb-selected');
        const storedVidbEmb = localStorage.getItem('vidb-is-embedded');
        const storedVidbOvl = localStorage.getItem('vidb-on-overlay');

        if (vidbCheck) {
            if (storedVidbSel === 'true') {
                vidbCheck.checked = true;
            } else if (storedVidbSel === 'false') {
                vidbCheck.checked = false;
            }
        }

        const embQ = document.getElementById('vidbEmbeddedQuestion');
        const overlayQ = document.getElementById('vidbOverlayQuestion');
        const storedVcfVer = (localStorage.getItem('vcf-version') || '').trim();
        const storedVcfDet = (localStorage.getItem('vcf-detailed-version') || '').trim();
        const is91xPlan = storedVcfVer.startsWith('9.1') || storedVcfDet.startsWith('9.1') || (typeof window.vcfVersion !== 'undefined' && (window.vcfVersion || '').startsWith('9.1'));

        if (is91xPlan) {
            window.vidbIsEmbedded = null;
            window.vidbOnOverlay = null;
            document.querySelectorAll('input[name=vidbEmbedded]').forEach(r => { r.checked = false; });
            document.querySelectorAll('input[name=vidbOverlay]').forEach(r => { r.checked = false; });
            if (embQ) embQ.style.display = 'none';
            if (overlayQ) overlayQ.style.display = 'none';
        } else if (storedVidbEmb === 'true') {
            window.vidbIsEmbedded = true;
            window.vidbOnOverlay = null;
            document.querySelectorAll('input[name=vidbEmbedded]').forEach(r => {
                r.checked = (r.value === 'yes');
            });
            document.querySelectorAll('input[name=vidbOverlay]').forEach(r => {
                r.checked = false;
            });
            if (embQ) embQ.style.display = 'block';
            if (overlayQ) overlayQ.style.display = 'none';
        } else if (storedVidbEmb === 'false') {
            window.vidbIsEmbedded = false;
            document.querySelectorAll('input[name=vidbEmbedded]').forEach(r => {
                r.checked = (r.value === 'no');
            });
            if (embQ) embQ.style.display = 'block';

            if (storedVidbOvl === 'true') {
                window.vidbOnOverlay = true;
                document.querySelectorAll('input[name=vidbOverlay]').forEach(r => {
                    r.checked = (r.value === 'yes');
                });
                if (overlayQ) overlayQ.style.display = 'block';
            } else if (storedVidbOvl === 'false') {
                window.vidbOnOverlay = false;
                document.querySelectorAll('input[name=vidbOverlay]').forEach(r => {
                    r.checked = (r.value === 'no');
                });
                if (overlayQ) overlayQ.style.display = 'block';
            } else {
                window.vidbOnOverlay = null;
                document.querySelectorAll('input[name=vidbOverlay]').forEach(r => {
                    r.checked = false;
                });
                if (overlayQ) overlayQ.style.display = 'block';
            }
        } else {
            window.vidbIsEmbedded = null;
            window.vidbOnOverlay = null;
            document.querySelectorAll('input[name=vidbEmbedded]').forEach(r => { r.checked = false; });
            document.querySelectorAll('input[name=vidbOverlay]').forEach(r => { r.checked = false; });
            if (vidbCheck && !vidbCheck.checked) {
                if (embQ) embQ.style.display = 'none';
                if (overlayQ) overlayQ.style.display = 'none';
            } else if (vidbCheck && vidbCheck.checked) {
                if (embQ) embQ.style.display = 'block';
                if (overlayQ) overlayQ.style.display = 'none';
            }
        }
    } finally {
        _isSyncing = false;
    }
}

function importPlanConfigJSON(file) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if (!data || !data.environmentConfig) {
                alert("Invalid configuration file format: missing environmentConfig.");
                return;
            }

            // 1. Restore localStorage
            Object.entries(data.environmentConfig).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    localStorage.setItem(key, value);
                }
            });

            // Target plan page if defined in JSON or localStorage
            let targetPlanPage = data.selectedPlanPage || (data.environmentConfig && data.environmentConfig['selected-plan-page']) || localStorage.getItem('selected-plan-page') || '';
            targetPlanPage = normalizePlanPageFilename(targetPlanPage);
            if (targetPlanPage) {
                localStorage.setItem('selected-plan-page', targetPlanPage);
            }

            // 2. Restore deploymentSize as a clean string first (default: small)
            let depSize = 'small';
            if (data.planPageConfig && typeof data.planPageConfig.deploymentSize === 'string') {
                depSize = data.planPageConfig.deploymentSize;
            } else if (typeof data.deploymentSize === 'string') {
                depSize = data.deploymentSize;
            } else if (data.environmentConfig['deployment-size']) {
                depSize = data.environmentConfig['deployment-size'];
            }
            localStorage.setItem('deployment-size', depSize);
            window.deploymentSize = depSize;

            // 3. Restore deploymentType (default: simple unless medium/large)
            let depType = 'simple';
            if (depSize === 'medium' || depSize === 'large') {
                depType = 'ha';
            } else if (data.planPageConfig && typeof data.planPageConfig.deploymentType === 'string') {
                depType = data.planPageConfig.deploymentType;
            } else if (data.environmentConfig['deployment-type']) {
                depType = data.environmentConfig['deployment-type'];
            }
            localStorage.setItem('deployment-type', depType);
            window.deploymentType = depType;

            // 4. Restore advanced products to localStorage
            let importedProds = {};
            if (data.planPageConfig && data.planPageConfig.selectedAdvancedProducts) {
                importedProds = data.planPageConfig.selectedAdvancedProducts;
            }
            localStorage.setItem('selected-advanced-products', JSON.stringify(importedProds));
            window.selectedAdvancedProducts = importedProds;

            // 5. Restore Software Depot and Identity Broker explicit selections if present in planPageConfig
            if (data.planPageConfig) {
                if (data.planPageConfig.depotSelected !== undefined) {
                    localStorage.setItem('depot-selected', data.planPageConfig.depotSelected ? 'true' : 'false');
                }
                if (data.planPageConfig.vidbSelected !== undefined) {
                    const isVidb = data.planPageConfig.vidbSelected === true || data.planPageConfig.vidbSelected === 'true';
                    localStorage.setItem('vidb-selected', isVidb ? 'true' : 'false');
                }
                if (data.planPageConfig.vidbIsEmbedded !== undefined && data.planPageConfig.vidbIsEmbedded !== null) {
                    localStorage.setItem('vidb-is-embedded', data.planPageConfig.vidbIsEmbedded ? 'true' : 'false');
                }
                if (data.planPageConfig.vidbOnOverlay !== undefined && data.planPageConfig.vidbOnOverlay !== null) {
                    localStorage.setItem('vidb-on-overlay', data.planPageConfig.vidbOnOverlay ? 'true' : 'false');
                }
            }

            if (localStorage.getItem('vidb-selected') === 'true') {
                importedProds['vidb'] = true;
            }
            localStorage.setItem('selected-advanced-products', JSON.stringify(importedProds));
            window.selectedAdvancedProducts = importedProds;

            const rawCurrentFileName = decodeURIComponent(window.location.pathname.split('/').pop() || '');
            const currentFileName = normalizePlanPageFilename(rawCurrentFileName);

            // 5. Auto-Navigation Logic
            if (currentFileName === 'index.html' || currentFileName === '' || (targetPlanPage && currentFileName !== targetPlanPage)) {
                if (targetPlanPage && targetPlanPage !== 'index.html') {
                    goToPlanPage(targetPlanPage, true);
                    return;
                }

                if (typeof restoreUIFromStorage === 'function') {
                    restoreUIFromStorage();
                    setTimeout(() => {
                        const pathCard = document.querySelector('.path-card');
                        if (pathCard) pathCard.click();
                    }, 250);
                    return;
                }
            }

            // If already on the matching plan page, sync UI and refresh plan live
            syncPlanPageFromStorage();
            if (typeof autoGenerateUpgradePlan === 'function') {
                if (typeof loadSelectionsFromStorage === 'function') {
                    loadSelectionsFromStorage();
                }
                autoGenerateUpgradePlan();
                alert("Plan selections imported successfully! The plan has been updated.");
            } else {
                location.reload();
            }
        } catch (err) {
            alert("Error reading JSON configuration file: " + err.message);
        }
    };
    reader.readAsText(file);
}

// Intercept autoGenerateUpgradePlan so syncPlanPageFromStorage ALWAYS runs BEFORE autoGenerateUpgradePlan on page load!
let _syncedOnce = false;

(function() {
    function hookAutoGenerate() {
        if (typeof window.autoGenerateUpgradePlan === 'function' && !window.autoGenerateUpgradePlan._hooked) {
            const orig = window.autoGenerateUpgradePlan;
            window.autoGenerateUpgradePlan = function() {
                if (!_syncedOnce) {
                    _syncedOnce = true;
                    syncPlanPageFromStorage();
                } else {
                    savePlanPageStateToStorage();
                }
                return orig.apply(this, arguments);
            };
            window.autoGenerateUpgradePlan._hooked = true;
        }
    }

    hookAutoGenerate();
    if (typeof window !== 'undefined') {
        window.addEventListener('DOMContentLoaded', hookAutoGenerate);
        window.addEventListener('load', hookAutoGenerate);
        setTimeout(hookAutoGenerate, 50);
        setTimeout(hookAutoGenerate, 200);
    }
})();
