/**
 * Casterly Endpoint Agent - Type Definitions
 * Core types for endpoint management and telemetry
 */

// Endpoint Status Enum
export enum EndpointStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
  UNREGISTERED = 'unregistered',
}

// Device Health Score Enum (0-100)
export enum HealthScoreLevel {
  CRITICAL = 'critical', // 0-20
  POOR = 'poor', // 21-40
  FAIR = 'fair', // 41-60
  GOOD = 'good', // 61-80
  EXCELLENT = 'excellent', // 81-100
}

// Subscription Tiers
export enum SubscriptionTier {
  TRIAL = 'trial',
  BASIC = 'basic',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}

// Hardware Information
export interface HardwareInfo {
  deviceId: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  bios: string;
  cpu: {
    cores: number;
    model: string;
  };
  ram: {
    total: number; // in GB
    usedPercent: number;
  };
  storage: StorageDevice[];
  tpm: {
    version: string;
    available: boolean;
  };
  networkInterfaces: NetworkInterface[];
}

export interface StorageDevice {
  name: string;
  type: 'SSD' | 'HDD' | 'NVMe';
  capacity: number; // in GB
  usedPercent: number;
  health: number; // 0-100
}

export interface NetworkInterface {
  name: string;
  macAddress: string;
  ipv4?: string;
  ipv6?: string;
  isActive: boolean;
}

// Device Health Score Model
export interface DeviceHealthScore {
  overallScore: number; // 0-100
  level: HealthScoreLevel;
  components: {
    cpu: number;
    memory: number;
    storage: number;
    battery?: number; // for laptops
    thermal: number;
    security: number;
  };
  timestamp: Date;
  factors: HealthFactor[];
}

export interface HealthFactor {
  name: string;
  impact: number; // -50 to +50
  description: string;
  recommendation?: string;
}

// Telemetry Event
export interface TelemetryEvent {
  id: string;
  endpointId: string;
  timestamp: Date;
  type: TelemetryEventType;
  data: Record<string, any>;
  severity: 'info' | 'warning' | 'error' | 'critical';
}

export enum TelemetryEventType {
  HEALTH_CHECK = 'health_check',
  PERFORMANCE_METRIC = 'performance_metric',
  ERROR_EVENT = 'error_event',
  SECURITY_EVENT = 'security_event',
  HARDWARE_CHANGE = 'hardware_change',
  UPDATE_CHECK = 'update_check',
  SUBSCRIPTION_CHECK = 'subscription_check',
}

// Endpoint Registration
export interface EndpointDevice {
  id: string;
  name: string;
  status: EndpointStatus;
  osType: 'windows' | 'macos' | 'linux';
  osVersion: string;
  agentVersion: string;
  hardwareInfo: HardwareInfo;
  hardwareFingerprint: string;
  baselineHash: string; // for detecting hardware changes
  healthScore: DeviceHealthScore;
  subscription: {
    tier: SubscriptionTier;
    expiresAt: Date;
    isValid: boolean;
  };
  lastHeartbeat: Date;
  enrollmentDate: Date;
  updatedAt: Date;
  remoteAssistanceEnabled: boolean;
  autoUpdateEnabled: boolean;
  ring: 'ring0' | 'ring1' | 'stable'; // for canary updates
}

// MQTT Message for Telemetry
export interface MQTTTelemetryPayload {
  endpointId: string;
  timestamp: string; // ISO string
  events: TelemetryEvent[];
  healthScore: DeviceHealthScore;
  status: EndpointStatus;
}

// Remote Assistance Session
export interface RemoteAssistanceSession {
  id: string;
  endpointId: string;
  technicianId: string;
  consentToken: string;
  status: 'pending' | 'active' | 'closed';
  mode: 'view-only' | 'interactive' | 'unattended';
  webrtcSdp?: string;
  iceServers?: RTCIceServer[];
  startedAt?: Date;
  endedAt?: Date;
  recordingEnabled: boolean;
  recordingPath?: string;
  auditLog: SessionAuditEntry[];
}

export interface SessionAuditEntry {
  timestamp: Date;
  action: string;
  actor: string;
  details: Record<string, any>;
}

// Self-Update Configuration
export interface UpdateRingConfig {
  endpointId: string;
  currentRing: 'ring0' | 'ring1' | 'stable';
  updatePolicy: {
    autoUpdate: boolean;
    predictedTime?: Date; // AI-predicted optimal update time
    maxDowntimeMins: number;
    allowRollback: boolean;
    healthCheckRequired: boolean;
  };
  rollbackConfig: {
    tpmSealed: boolean;
    previousVersion: string;
    rollbackAvailable: boolean;
    expiresAt: Date;
  };
}

// Subscription Validation
export interface SubscriptionValidation {
  endpointId: string;
  subscriptionId: string;
  tier: SubscriptionTier;
  status: 'valid' | 'expired' | 'invalid' | 'revoked';
  validFrom: Date;
  validUntil: Date;
  features: string[];
  maxEndpoints: number;
  currentEndpoints: number;
  lastValidationTime: Date;
  licenseKey: string;
}
