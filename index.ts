// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as fs from "fs";
import * as k8s from "@pulumi/kubernetes";
import * as k8sjs from "./k8sjs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";

// =========================================================================
// Guestbook Application
// =========================================================================

const redisLeader = new k8sjs.ServiceDeployment("redis-leader", {
    image: "redis:6.0.5",
    ports: [6379],
});

const redisReplica = new k8sjs.ServiceDeployment("redis-replica", {
    image: "pulumi/guestbook-redis-replica",
    ports: [6379],
});

const frontend = new k8sjs.ServiceDeployment("frontend", {
    replicas: 3,
    image: "pulumi/guestbook-php-redis",
    ports: [80],
    serviceType: "NodePort",
    nodePort: 30080,
});

// =========================================================================
// Monitoring Infrastructure (Namespace & Exporters)
// =========================================================================

const monitoringNamespace = new k8s.core.v1.Namespace("monitoring", {
    metadata: {
        name: "monitoring",
    },
});

// 1. Blackbox Exporter for Synthetic HTTP Probing of Guestbook Frontend
const blackboxConfig = new k8s.core.v1.ConfigMap("blackbox-config", {
    metadata: {
        namespace: monitoringNamespace.metadata.name,
        name: "blackbox-config",
    },
    data: {
        "blackbox.yaml": `modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      valid_http_versions: ["HTTP/1.1", "HTTP/2.0"]
      valid_status_codes: []
      method: GET
`,
    },
}, { parent: monitoringNamespace });

const blackboxDeployment = new k8s.apps.v1.Deployment("blackbox-exporter", {
    metadata: {
        namespace: monitoringNamespace.metadata.name,
        name: "blackbox-exporter",
        labels: { app: "blackbox-exporter" },
    },
    spec: {
        replicas: 1,
        selector: { matchLabels: { app: "blackbox-exporter" } },
        template: {
            metadata: { labels: { app: "blackbox-exporter" } },
            spec: {
                containers: [{
                    name: "blackbox-exporter",
                    image: "prom/blackbox-exporter:v0.25.0",
                    args: ["--config.file=/etc/blackbox_exporter/blackbox.yaml"],
                    ports: [{ containerPort: 9115, name: "http" }],
                    resources: {
                        requests: { cpu: "20m", memory: "32Mi" },
                        limits: { cpu: "100m", memory: "128Mi" },
                    },
                    volumeMounts: [{
                        name: "config",
                        mountPath: "/etc/blackbox_exporter",
                    }],
                }],
                volumes: [{
                    name: "config",
                    configMap: { name: blackboxConfig.metadata.name },
                }],
            },
        },
    },
}, { parent: monitoringNamespace });

const blackboxService = new k8s.core.v1.Service("blackbox-exporter", {
    metadata: {
        namespace: monitoringNamespace.metadata.name,
        name: "blackbox-exporter",
        labels: { app: "blackbox-exporter" },
    },
    spec: {
        ports: [{ port: 9115, targetPort: 9115, name: "http" }],
        selector: { app: "blackbox-exporter" },
        type: "ClusterIP",
    },
}, { parent: monitoringNamespace });

// 2. Redis Exporter for Redis Leader
const redisLeaderExporterDeployment = new k8s.apps.v1.Deployment("redis-leader-exporter", {
    metadata: {
        namespace: monitoringNamespace.metadata.name,
        name: "redis-leader-exporter",
        labels: { app: "redis-leader-exporter" },
    },
    spec: {
        replicas: 1,
        selector: { matchLabels: { app: "redis-leader-exporter" } },
        template: {
            metadata: { labels: { app: "redis-leader-exporter" } },
            spec: {
                containers: [{
                    name: "redis-exporter",
                    image: "oliver006/redis_exporter:v1.67.0",
                    env: [
                        { name: "REDIS_ADDR", value: "redis-leader.default.svc.cluster.local:6379" },
                        { name: "REDIS_ALIAS", value: "redis-leader" },
                    ],
                    ports: [{ containerPort: 9121, name: "metrics" }],
                    resources: {
                        requests: { cpu: "20m", memory: "32Mi" },
                        limits: { cpu: "100m", memory: "128Mi" },
                    },
                }],
            },
        },
    },
}, { parent: monitoringNamespace });

const redisLeaderExporterService = new k8s.core.v1.Service("redis-leader-exporter", {
    metadata: {
        namespace: monitoringNamespace.metadata.name,
        name: "redis-leader-exporter",
        labels: { app: "redis-leader-exporter" },
    },
    spec: {
        ports: [{ port: 9121, targetPort: 9121, name: "metrics" }],
        selector: { app: "redis-leader-exporter" },
        type: "ClusterIP",
    },
}, { parent: monitoringNamespace });

// 3. Redis Exporter for Redis Replica
const redisReplicaExporterDeployment = new k8s.apps.v1.Deployment("redis-replica-exporter", {
    metadata: {
        namespace: monitoringNamespace.metadata.name,
        name: "redis-replica-exporter",
        labels: { app: "redis-replica-exporter" },
    },
    spec: {
        replicas: 1,
        selector: { matchLabels: { app: "redis-replica-exporter" } },
        template: {
            metadata: { labels: { app: "redis-replica-exporter" } },
            spec: {
                containers: [{
                    name: "redis-exporter",
                    image: "oliver006/redis_exporter:v1.67.0",
                    env: [
                        { name: "REDIS_ADDR", value: "redis-replica.default.svc.cluster.local:6379" },
                        { name: "REDIS_ALIAS", value: "redis-replica" },
                    ],
                    ports: [{ containerPort: 9121, name: "metrics" }],
                    resources: {
                        requests: { cpu: "20m", memory: "32Mi" },
                        limits: { cpu: "100m", memory: "128Mi" },
                    },
                }],
            },
        },
    },
}, { parent: monitoringNamespace });

const redisReplicaExporterService = new k8s.core.v1.Service("redis-replica-exporter", {
    metadata: {
        namespace: monitoringNamespace.metadata.name,
        name: "redis-replica-exporter",
        labels: { app: "redis-replica-exporter" },
    },
    spec: {
        ports: [{ port: 9121, targetPort: 9121, name: "metrics" }],
        selector: { app: "redis-replica-exporter" },
        type: "ClusterIP",
    },
}, { parent: monitoringNamespace });

// =========================================================================
// Prometheus (Pulumi Helm Release)
// =========================================================================

const prometheusChartPath = path.resolve(__dirname, "charts/prometheus");

const extraScrapeConfigs = `
- job_name: 'guestbook-http-probe'
  metrics_path: /probe
  params:
    module: [http_2xx]
  static_configs:
    - targets:
      - http://frontend.default.svc.cluster.local:80/
      - http://frontend.default.svc.cluster.local:80/guestbook.php?cmd=get&key=messages
  relabel_configs:
    - source_labels: [__address__]
      target_label: __param_target
    - source_labels: [__param_target]
      target_label: instance
    - target_label: __address__
      replacement: blackbox-exporter.monitoring.svc.cluster.local:9115

- job_name: 'redis-leader-exporter'
  static_configs:
    - targets: ['redis-leader-exporter.monitoring.svc.cluster.local:9121']
      labels:
        role: leader
        service: redis-leader

- job_name: 'redis-replica-exporter'
  static_configs:
    - targets: ['redis-replica-exporter.monitoring.svc.cluster.local:9121']
      labels:
        role: replica
        service: redis-replica
`;

const prometheusRelease = new k8s.helm.v3.Release("prometheus", {
    chart: prometheusChartPath,
    namespace: monitoringNamespace.metadata.name,
    values: {
        extraScrapeConfigs: extraScrapeConfigs,
        server: {
            image: {
                tag: "v2.54.1",
            },
            service: {
                type: "NodePort",
                nodePort: 30090,
            },
            persistentVolume: {
                enabled: false,
            },
            resources: {
                requests: { cpu: "100m", memory: "256Mi" },
                limits: { cpu: "500m", memory: "1Gi" },
            },
        },
        alertmanager: {
            enabled: false,
        },
        "prometheus-node-exporter": {
            enabled: false,
        },
        "prometheus-pushgateway": {
            enabled: false,
        },
        "kube-state-metrics": {
            enabled: true,
            image: {
                tag: "v2.20.0",
            },
        },
    },
}, { parent: monitoringNamespace, deleteBeforeReplace: true, dependsOn: [blackboxService, redisLeaderExporterService, redisReplicaExporterService] });

// Stable ClusterIP Service for internal Prometheus DNS resolution
const prometheusServerService = new k8s.core.v1.Service("prometheus-server", {
    metadata: {
        namespace: monitoringNamespace.metadata.name,
        name: "prometheus-server",
    },
    spec: {
        ports: [{ port: 80, targetPort: 9090, name: "http" }],
        selector: {
            "app.kubernetes.io/component": "server",
            "app.kubernetes.io/name": "prometheus",
        },
        type: "ClusterIP",
    },
}, { parent: monitoringNamespace, dependsOn: [prometheusRelease] });

// =========================================================================
// Grafana (Pulumi Helm Release)
// =========================================================================

const grafanaChartPath = path.resolve(__dirname, "charts/grafana");
const dashboardContent = fs.readFileSync(path.join(__dirname, "dashboard.json"), "utf8");

const grafanaRelease = new k8s.helm.v3.Release("grafana", {
    chart: grafanaChartPath,
    namespace: monitoringNamespace.metadata.name,
    values: {
        image: {
            tag: "11.3.0",
        },
        service: {
            type: "NodePort",
            nodePort: 30300,
        },
        persistence: {
            enabled: false,
        },
        adminUser: "admin",
        datasources: {
            "datasources.yaml": {
                apiVersion: 1,
                datasources: [
                    {
                        name: "Prometheus",
                        uid: "prometheus",
                        type: "prometheus",
                        url: "http://prometheus-server.monitoring.svc.cluster.local",
                        access: "proxy",
                        isDefault: true,
                    },
                ],
            },
        },
        dashboardProviders: {
            "dashboardproviders.yaml": {
                apiVersion: 1,
                providers: [
                    {
                        name: "default",
                        orgId: 1,
                        folder: "",
                        type: "file",
                        disableDeletion: false,
                        editable: true,
                        options: {
                            path: "/var/lib/grafana/dashboards/default",
                        },
                    },
                ],
            },
        },
        dashboards: {
            default: {
                "guestbook-sre-overview": {
                    json: dashboardContent,
                },
            },
        },
    },
}, { parent: monitoringNamespace, deleteBeforeReplace: true, dependsOn: [prometheusServerService] });

// =========================================================================
// Outputs
// =========================================================================

// The chart stores a generated password in its admin Secret. Read that Secret
// instead of setting adminPassword, which would replace the live password.
const grafanaAdminSecret = k8s.core.v1.Secret.get(
    "grafana-admin",
    pulumi.interpolate`${monitoringNamespace.metadata.name}/${grafanaRelease.name}`,
    { parent: monitoringNamespace, dependsOn: [grafanaRelease] },
);

export const frontendIp = frontend.service.spec.clusterIP;
export const guestbookUrl = "http://localhost:31080";
export const prometheusUrl = "http://localhost:31090";
export const grafanaUrl = "http://localhost:31300";
export const grafanaAdminUser = "admin";
export const grafanaAdminPassword = pulumi.secret(
    grafanaAdminSecret.data.apply(data => Buffer.from(data["admin-password"], "base64").toString()),
);
export const grafanaCredentialsInstruction = "pulumi stack output grafanaAdminPassword --show-secrets";
