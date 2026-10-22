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
