# Casterly Endpoint Agent v5 - PRD Summary

**Version:** v5.0  
**Status:** Active Development (Phase 1)  
**Prepared By:** Ravikiran N  
**Date:** 23-May-2026

## Project Overview
Casterly Endpoint Agent is an AI-driven endpoint lifecycle management platform designed to extend device lifespan, reduce operational costs, and improve ESG metrics through autonomous telemetry, remediation, and self-update capabilities.

**Core Platform:**
- Multi-OS support (Windows, macOS, Linux)
- Zero Trust architecture
- TPM-sealed security
- Ring-based update system
- MQTT telemetry streaming
- Hardware attestation

---

## Phase 1: Foundation (Months 1-9) - **CURRENT**

### Core Features
- ✅ Endpoint telemetry pipeline (all OS platforms)
- ✅ Hardware fingerprinting & baseline enrollment
- ✅ Device health scoring (composite 0-100 model)
- ✅ MQTT telemetry stream to Command Center
- ✅ Subscription validation & enforcement
- ✅ System tray application (Windows + macOS)
- ✅ MSI installer with Intune/SCCM/GPO support
- ✅ Windows NT Service + macOS launchd daemon
- ✅ 20,000 endpoint onboarding capacity
- **NEW v5:** Self-Update Ring 0 + Ring 1 Canary infrastructure
- **NEW v5:** Remote Assistance Consent UI + basic WebRTC (view-only)

### KPIs - Phase 1
| Category | Metric | Target |
|----------|--------|--------|
| **Reliability** | Telemetry pipeline availability | >= 99.95% |
| **Remote Assist** | User consent-to-session establishment | < 30 seconds |
| **Remote Assist** | Session establishment success rate | >= 99% |
| **Remote Assist** | Remote resolution rate vs on-site visits | >= 75% |
| **Self-Update** | Fleet update compliance within 7 days | >= 98% |
| **Self-Update** | Automatic rollback rate (health failure) | < 0.5% |
| **Self-Update** | Zero endpoints bricked by agent update | 100% |

---

## Phase 2: Intelligence (Months 9-18)

### Additional Features
- ONNX on-device AI models (battery, SSD, thermal)
- Full hardware attestation with TPM signing
- Warranty governance engine & state machine
- Self-healing automation framework
- ADE operations console v1
- ESG lifecycle scoring & carbon accounting
- 35,000 endpoint capacity
- **NEW v5:** Self-Update full ring system + differential binary patching
- **NEW v5:** Remote Assistance interactive mode + session recording
- **NEW v5:** Unattended server mode + file transfer governance

---

## Phase 3: Autonomy (Months 18-36)

### Advanced Features
- Fully autonomous remediation workflows
- Advanced AI: refurbishment grading, fraud detection
- Visual AI diagnostics (camera-based condition assessment)
- Circular economy marketplace integration
- Multi-country APAC deployment
- 50,000+ endpoint capacity
- **NEW v5:** Self-Update AI-predicted update timing
- **NEW v5:** Remote Assistance AI-assisted sessions with auto-suggested remediation

---

## Complete KPIs (All Phases)

### Reliability
- Telemetry pipeline availability: >= 99.95%
- Agent uptime (installed devices): >= 99.9%

### AI Performance
- Autonomous remediation rate: >= 40%
- Hardware change detection accuracy: >= 98%
- Failure prediction precision: >= 85%

### Financial
- OPEX reduction for customers: 20-30%

### Lifecycle
- Device lifespan extension: 15-30%

### ESG
- Carbon reduction per device: 25-40%

### Operations
- Mean Time to Resolution (MTTR): 50% reduction vs baseline

### Customer
- Subscription renewal rate: >= 90%

### Security
- Zero agent binary tampering incidents: 100%

### Scale
- Phase 1 Endpoints: 20,000
- Phase 2 Endpoints: 35,000
- Phase 3 Endpoints: 50,000+

### Remote Assistance (NEW v5)
- User consent-to-session: < 30 seconds
- Session success rate: >= 99%
- Remote resolution rate: >= 75%

### Self-Update (NEW v5)
- Fleet update compliance (7 days): >= 98%
- Automatic rollback rate: < 0.5%
- Zero endpoints bricked: 100%

---

## Confidentiality Notice
This document is classified CONFIDENTIAL. © 2025 Casterly AI Managed Services. All Rights Reserved.
