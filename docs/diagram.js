/**
 * VCF Upgrade Planning Tool - Native Interactive Stepper Diagram Component
 * Replaces external Mermaid.js with a 0ms, interactive, theme-aware native HTML/CSS pipeline.
 */

(function () {
    // Inject Stepper Component CSS into document head
    const style = document.createElement('style');
    style.id = 'vcf-stepper-styles';
    style.textContent = `
        /* --- Native Stepper Diagram Styles --- */
        .diagram-container {
            margin: 24px 0;
            padding: 20px;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.03);
            transition: background 0.3s, border-color 0.3s;
        }

        .diagram-header-bar {
            display: flex;
            justify-content: flex-start;
            align-items: center;
            margin-bottom: 12px;
        }

        .diagram-header-hint {
            font-size: 0.8rem;
            font-weight: 500;
            color: var(--text-secondary);
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: var(--bg);
            padding: 4px 10px;
            border-radius: 6px;
            border: 1px solid var(--border-color);
        }

        .stepper-pipeline {
            display: flex;
            align-items: stretch;
            gap: 12px;
            overflow-x: auto;
            padding: 8px 4px 16px 4px;
            scroll-behavior: smooth;
            -webkit-overflow-scrolling: touch;
        }

        .stepper-pipeline::-webkit-scrollbar {
            height: 8px;
        }

        .stepper-pipeline::-webkit-scrollbar-track {
            background: var(--bg);
            border-radius: 4px;
        }

        .stepper-pipeline::-webkit-scrollbar-thumb {
            background: var(--border-color);
            border-radius: 4px;
        }

        .stepper-node {
            flex: 1;
            min-width: 220px;
            max-width: 320px;
            background: var(--card-bg);
            border: 2px solid var(--border-color);
            border-radius: 10px;
            padding: 14px 16px;
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            position: relative;
            user-select: none;
        }

        .stepper-node:hover {
            border-color: var(--vmw-blue);
            transform: translateY(-3px);
            box-shadow: 0 6px 16px rgba(0, 136, 181, 0.18);
        }

        /* Active Phase */
        .stepper-node.active {
            border-color: var(--vmw-blue);
            box-shadow: 0 0 0 3px rgba(0, 136, 181, 0.25), 0 6px 16px rgba(0, 0, 0, 0.1);
            background: var(--card-bg);
        }

        /* Active Phase with Safe Stopping Point */
        .stepper-node.active-safestop {
            border-color: #6b3999;
            box-shadow: 0 0 0 3px rgba(107, 57, 153, 0.28), 0 6px 16px rgba(0, 0, 0, 0.1);
        }

        /* Completed Phase */
        .stepper-node.completed {
            border-color: #2e7d4f;
            background: rgba(46, 125, 79, 0.05);
        }

        .stepper-node.completed:hover {
            box-shadow: 0 6px 16px rgba(46, 125, 79, 0.2);
        }

        /* Upcoming Phase */
        .stepper-node.upcoming {
            border-color: var(--border-color);
            opacity: 0.88;
        }

        .stepper-node-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            gap: 6px;
            flex-wrap: wrap;
        }

        .stepper-phase-badge {
            font-size: 0.78rem;
            font-weight: 700;
            padding: 3px 9px;
            border-radius: 12px;
            text-transform: uppercase;
            letter-spacing: 0.4px;
        }

        .stepper-phase-badge.active {
            background: var(--vmw-blue);
            color: #ffffff;
        }

        .stepper-phase-badge.active-safestop {
            background: #6b3999;
            color: #ffffff;
        }

        .stepper-phase-badge.completed {
            background: #2e7d4f;
            color: #ffffff;
        }

        .stepper-phase-badge.upcoming {
            background: var(--bg);
            color: var(--text-secondary);
            border: 1px solid var(--border-color);
        }

        .stepper-safestop-pill {
            font-size: 0.73rem;
            font-weight: 600;
            background: #f3e8ff;
            color: #6b3999;
            border: 1px solid #d8b4fe;
            padding: 2px 7px;
            border-radius: 10px;
            display: inline-flex;
            align-items: center;
            gap: 3px;
        }

        [data-theme="dark"] .stepper-safestop-pill {
            background: #2e1065;
            color: #e9d5ff;
            border-color: #7e22ce;
        }

        .stepper-node-title {
            font-size: 0.92rem;
            font-weight: 700;
            color: var(--text-primary);
            margin-bottom: 10px;
            line-height: 1.35;
        }

        .stepper-steps-list {
            margin-top: auto;
            padding-top: 8px;
            border-top: 1px dashed var(--border-color);
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .stepper-step-item {
            font-size: 0.78rem;
            color: var(--text-secondary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .stepper-step-item .dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--border-color);
            flex-shrink: 0;
        }

        .stepper-node.active .stepper-step-item .dot {
            background: var(--vmw-blue);
        }

        .stepper-node.active-safestop .stepper-step-item .dot {
            background: #6b3999;
        }

        .stepper-node.completed .stepper-step-item .dot {
            background: #2e7d4f;
        }

        .stepper-connector {
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--border-color);
            font-size: 1.2rem;
            font-weight: bold;
            flex-shrink: 0;
            padding: 0 2px;
            user-select: none;
        }

        .stepper-start-end {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-width: 85px;
            padding: 12px;
            background: var(--bg);
            border: 2px solid var(--border-color);
            border-radius: 10px;
            font-size: 0.8rem;
            font-weight: 700;
            color: var(--text-secondary);
            text-align: center;
            flex-shrink: 0;
        }

        .stepper-start-end.complete {
            border-color: #2e7d4f;
            color: #2e7d4f;
            background: rgba(46, 125, 79, 0.08);
        }

        @media (max-width: 768px) {
            .stepper-pipeline {
                flex-direction: column;
                align-items: stretch;
            }
            .stepper-node {
                max-width: 100%;
                min-width: 0;
            }
            .stepper-connector {
                transform: rotate(90deg);
                padding: 4px 0;
            }
            .stepper-start-end {
                width: 100%;
                min-width: 0;
            }
        }

        /* --- Print & PDF Export Styles --- */
        @media print {
            /* Hide interactive UI elements */
            .sidebar,
            .theme-toggle,
            .diagram-header-hint,
            .btn,
            .btn-export,
            .export-bar,
            .phase-nav-btn,
            button,
            nav,
            header {
                display: none !important;
            }

            /* Reset page background and layout */
            body, .main-wrapper, .container, .app-container {
                background: #ffffff !important;
                color: #000000 !important;
                margin: 0 !important;
                padding: 0 !important;
                width: 100% !important;
                max-width: 100% !important;
                box-shadow: none !important;
            }

            /* Display diagram and phase details cleanly */
            .diagram-container, #diagramContainer, #phaseContainer {
                display: block !important;
                overflow: visible !important;
                border: 1px solid #d0d7de !important;
                background: #ffffff !important;
                margin-bottom: 20px !important;
                page-break-inside: auto;
            }

            .stepper-pipeline {
                flex-wrap: wrap !important;
                overflow: visible !important;
                padding: 0 !important;
                gap: 8px !important;
            }

            .stepper-node {
                min-width: 180px !important;
                max-width: 220px !important;
                border: 1px solid #0077bb !important;
                background: #f8fafc !important;
                color: #000000 !important;
                break-inside: avoid !important;
                page-break-inside: avoid !important;
                print-color-adjust: exact;
                -webkit-print-color-adjust: exact;
            }

            .stepper-phase-badge {
                border: 1px solid #0077bb !important;
                print-color-adjust: exact;
                -webkit-print-color-adjust: exact;
            }

            .stepper-connector {
                color: #666666 !important;
            }

            /* Phase cards and details formatting */
            .phase, .section, #phaseContainer > div {
                border: 1px solid #d0d7de !important;
                background: #ffffff !important;
                color: #000000 !important;
                margin-bottom: 20px !important;
                padding: 16px !important;
                break-inside: avoid !important;
                page-break-inside: avoid !important;
            }

            /* Prevent page breaks inside tables, lists, and warnings */
            table, tr, td, th, ul, ol, .notice-box, .prereq-box {
                break-inside: avoid !important;
                page-break-inside: avoid !important;
            }

            table {
                width: 100% !important;
                border-collapse: collapse !important;
                table-layout: fixed !important;
                word-wrap: break-word !important;
                font-size: 0.82rem !important;
            }

            th {
                background: #f0f4f8 !important;
                color: #000000 !important;
                font-weight: 700 !important;
                border-bottom: 2px solid #b0c4de !important;
                print-color-adjust: exact;
                -webkit-print-color-adjust: exact;
            }

            td, th {
                padding: 6px 8px !important;
                border: 1px solid #d0d7de !important;
            }

            pre, code {
                background: #f6f8fa !important;
                color: #000000 !important;
                border: 1px solid #d0d7de !important;
                white-space: pre-wrap !important;
                word-wrap: break-word !important;
                font-size: 0.8rem !important;
            }
        }
    `;

    if (!document.getElementById('vcf-stepper-styles')) {
        document.head.appendChild(style);
    }
})();

/**
 * Jump directly to a specific step index in the upgrade workflow
 */
function jumpToStep(stepIndex) {
    if (typeof allSteps === 'undefined' || !allSteps || stepIndex < 0 || stepIndex >= allSteps.length) return;
    currentStepIndex = stepIndex;
    if (typeof displayStepsView === 'function') {
        displayStepsView();
    }
}

/**
 * Main function to generate the native interactive stepper timeline
 */
function generateDiagram() {
    const container = document.getElementById('diagramContainer');
    if (!container) return;

    if (typeof allSteps === 'undefined' || !allSteps || allSteps.length === 0) {
        container.innerHTML = '';
        return;
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    let html = `
        <div class="diagram-header-bar">
            <div class="diagram-header-hint">
                <span>💡 Click any phase card to jump directly to its details below</span>
            </div>
        </div>
        <div class="stepper-pipeline">
            <div class="stepper-start-end">
                <span>Start</span>
                <span>Upgrade</span>
            </div>
            <div class="stepper-connector">➔</div>
    `;

    allSteps.forEach((step, index) => {
        const isCurrent = index === currentStepIndex;
        const isCompleted = index < currentStepIndex;
        const hasSafeStop = step.phases && step.phases.some(p => p.data && p.data.safe_stopping_point);

        let nodeClass = 'upcoming';
        let badgeClass = 'upcoming';
        let badgeText = `Phase ${step.number}`;

        if (isCurrent) {
            if (hasSafeStop) {
                nodeClass = 'active active-safestop';
                badgeClass = 'active-safestop';
            } else {
                nodeClass = 'active';
                badgeClass = 'active';
            }
            badgeText = `Phase ${step.number}`;
        } else if (isCompleted) {
            nodeClass = 'completed';
            badgeClass = 'completed';
            badgeText = `✓ Phase ${step.number}`;
        }

        html += `
            <div class="stepper-node ${nodeClass}" onclick="jumpToStep(${index})" title="Click to view Phase ${step.number} details">
                <div>
                    <div class="stepper-node-top">
                        <span class="stepper-phase-badge ${badgeClass}">${badgeText}</span>
                        ${hasSafeStop ? `<span class="stepper-safestop-pill" title="Safe stopping point to pause and test">⏸️ Safe Stop</span>` : ''}
                    </div>
                    <div class="stepper-node-title">Phase ${step.number}: ${escapeHtml(step.title)}</div>
                </div>
        `;

        if (step.phases && step.phases.length > 0) {
            html += `<div class="stepper-steps-list">`;
            step.phases.forEach((phase, phaseIdx) => {
                html += `
                    <div class="stepper-step-item">
                        <span class="dot"></span>
                        <span>Step ${phaseIdx + 1}: ${escapeHtml(phase.title)}</span>
                    </div>
                `;
            });
            html += `</div>`;
        }

        html += `</div>`;
        html += `<div class="stepper-connector">➔</div>`;
    });

    const isAllComplete = currentStepIndex >= allSteps.length;
    html += `
            <div class="stepper-start-end ${isAllComplete ? 'complete' : ''}">
                <span>${isAllComplete ? '✓ All Done' : 'Complete'}</span>
            </div>
        </div>
    `;

    container.innerHTML = html;

    // Smooth scroll active node into view in the horizontal pipeline
    setTimeout(() => {
        const activeNode = container.querySelector('.stepper-node.active');
        if (activeNode) {
            activeNode.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
    }, 50);
}

// Backward compatibility stubs for zoom controls
function diagramZoom(delta) {}
function diagramZoomReset() {}

/**
 * Clean HTML diagram generator for PDF Runbook exports
 */
function generatePrintDiagram() {
    if (typeof allSteps === 'undefined' || !allSteps || allSteps.length === 0) return '';

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    var out = '<div style="margin-bottom:24px; padding:16px; background:#f8fafc; border-radius:8px; border:1px solid #d0d7de; page-break-inside:avoid; print-color-adjust:exact; -webkit-print-color-adjust:exact;">'
            + '<div style="font-size:0.95rem; font-weight:700; color:#1a2d40; margin-bottom:12px; border-bottom:1px solid #e1e4e8; padding-bottom:6px;">🗺️ Upgrade Workflow Map</div>'
            + '<div style="display:flex; flex-wrap:wrap; gap:8px; align-items:stretch;">';

    allSteps.forEach(function(step, idx) {
        var hasSafeStop = step.phases && step.phases.some(function(p) { return p.data && p.data.safe_stopping_point; });
        out += '<div style="flex:1; min-width:160px; max-width:210px; background:#ffffff; border:1.5px solid #0077bb; border-radius:6px; padding:10px 12px; font-size:0.75rem; display:flex; flex-direction:column; justify-content:space-between; print-color-adjust:exact; -webkit-print-color-adjust:exact;">'
             + '<div>'
             + '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">'
             + '<span style="background:#0077bb; color:#ffffff; font-weight:700; padding:2px 6px; border-radius:10px; font-size:0.68rem;">PHASE ' + step.number + '</span>'
             + (hasSafeStop ? '<span style="background:#f3e8ff; color:#6b3999; font-weight:600; padding:1px 5px; border-radius:8px; font-size:0.65rem; border:1px solid #d8b4fe;">⏸️ Safe Stop</span>' : '')
             + '</div>'
             + '<div style="font-weight:700; color:#1a2332; margin-bottom:6px; font-size:0.82rem; line-height:1.3;">' + escapeHtml(step.title) + '</div>'
             + '</div>';

        if (step.phases && step.phases.length > 0) {
            out += '<div style="border-top:1px dashed #d0d7de; padding-top:6px; margin-top:6px;">';
            step.phases.forEach(function(phase, phaseIdx) {
                out += '<div style="color:#57606a; font-size:0.7rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:2px;">• Step ' + (phaseIdx + 1) + ': ' + escapeHtml(phase.title) + '</div>';
            });
            out += '</div>';
        }

        out += '</div>';
        if (idx < allSteps.length - 1) {
            out += '<div style="display:flex; align-items:center; color:#0077bb; font-size:1.1rem; font-weight:bold; padding:0 2px;">➔</div>';
        }
    });

    out += '</div></div>';
    return out;
}
