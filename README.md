# VCF Upgrade Planning Tool

An interactive, browser-based tool for planning your VMware Cloud Foundation (VCF) upgrades. It provides a comphrensive step-by-step guidance across a variety of upgrade scenarios, helping users understand their specific pathway to VCF 9.1, outputs includes networking and resource requirements, overall upgrade workflow that is broken into smaller discreet phases for ease of upgrade consumption. All deliverables can be exported into a PDF document for offline usage.

👉 Access the [VCF Upgrade Planning Tool](https://vmware.github.io/vcf-upgrade-planner/)

## VC / Supervisor / VKS Upgrade Planner

A second, dedicated planner covers upgrades across vCenter → vSphere Supervisor → VKS → Kubernetes
Releases (VKr). Add-ons (NSX, ESX, Operations, Automation) are out of scope there — the main planner
above handles those.

👉 [VC / Supervisor / VKS Upgrade Planner](https://vmware.github.io/vcf-upgrade-planner/vks-upgrade-planner.html)

It offers three entry points — upgrading vCenter, upgrading Supervisor, or upgrading VKS/Kubernetes
Releases — each asking only for the versions that scenario needs, and returns a stage-by-stage plan
with the reason for every step, exportable as JSON or PDF. The third option exposes all four layers
on both sides, for customers who want to pin every version themselves.

Incompatible choices are greyed out as you go rather than rejected afterwards: versions behind your
current one, Supervisor builds no reachable vCenter can run, a VKS your Supervisor doesn't support,
and a Kubernetes Release your VKS doesn't support. vCenter 8.0U3 is the scope floor (VKS did not
exist before it), so nothing earlier is offered at all.

### Files

| File | Purpose |
|---|---|
| `docs/vks-upgrade-planner.html` | The page: scenario cards, inputs, validation, stage rendering. Carries the matrix inline (see below). |
| `docs/vks-solver.js` | The planning rules — everything that decides what the plan is. |
| `docs/k8s-upgrade-matrix.json` | Version/compatibility data: vCenter upgrade graph, vCenter↔Supervisor windows, Supervisor/VKS/VKr upgrade graphs, compatibility tables and lifecycle dates. |
| `docs/embed_vks_matrix.py` | Inlines the matrix into the page so it works from a `file://` URL. |

This is a separate data set from `docs/compat-data.json` (which `docs/refresh_compat.py` maintains
for the main planner); the two are not interchangeable.

### Keeping it in sync with wcp-interop

The planning logic is **not** maintained here. `docs/vks-solver.js` is an unmodified copy of the
solver from the `wcp-interop` repo (`vks-upgrade-planner/`), which is
specified by its `SPEC.md`. Fix planning bugs there and re-copy — never patch the solver in
this repo, so the two can't drift. The file header records the commit it was taken from.

To re-port the solver and refresh the data, run

    scripts/sync-vks-solver.sh --src /path/to/wcp-interop/vks-upgrade-planner [--dry-run]

which copies the solver body from `tools/upgrade-solver.js`, refreshes the matrix, re-embeds it and
smoke-tests the result (restoring the original files if anything fails). Afterwards, edit the
placeholder note it leaves in the `docs/vks-solver.js` header and review `git diff`.

The script does not import UI behavior or layout changes. Review upstream changes to
`tools/vks-upgrade-planner.html` separately and adapt relevant picker, filter, validation, and
accessibility improvements to this page. Keep this repo's sidebar, theme, and presentation.
The script's structural difference count is a reminder to perform that review, not a UI sync.

To sync the solver and matrix by hand:

1. Copy the embedded solver region out of that repo's `tools/vks-upgrade-planner.html` (upstream
   keeps it in lockstep with `tools/upgrade-solver.js`) into `docs/vks-solver.js`, and record the
   source commit in the file header.
2. Copy the matrix — either that repo's `data/k8s-upgrade-matrix.json`, or the JSON embedded in
   the same page — to `docs/k8s-upgrade-matrix.json`.
3. Run `python3 docs/embed_vks_matrix.py`.
4. Check for new reason codes: every code the solver emits needs matching text in the page's
   `REASON_TEXT`, or a step will render with a bare code instead of an explanation. Confirm the two
   lists match with no orphans on either side.

Step 3 matters: browsers block `fetch()` of a sibling JSON file when the page is opened directly, so
without the inlined copy every version picker comes up empty. The page reads the embedded blob first
and only falls back to fetching the JSON if it is missing or malformed.

## Feedback

We welcome all feedback. If you run into issues, have ideas for new features, or wish to contribute improvements, please open an issue. Thank You
