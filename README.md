# Kubernetes Guestbook with Prometheus and Grafana

Pulumi deploys the Kubernetes Guestbook (PHP frontend, Redis leader, Redis replica) and adds Prometheus and Grafana from the local Helm charts in `charts/`.

The frontend has no Prometheus `/metrics` endpoint. Availability is a Blackbox HTTP probe. Redis command rate and memory come from Redis exporters. CPU and memory come from cAdvisor. Replica counts come from kube-state-metrics.

Run every command in the repository root. That is the directory that contains `Pulumi.yaml` after you clone this repository.

## Prerequisites

Install Docker, Kind, kubectl, Pulumi, and Node.js 18 or newer. npm is installed with Node.js. Docker must be running before you create the cluster. On macOS and Windows, start Docker Desktop and wait until it is ready.

Use one of the sections below, then check the tools:

```bash
docker version
node -v
npm -v
kind version
kubectl version --client
pulumi version
```

`docker version` must show a Server section. `node -v` must show v18 or newer.

### Ubuntu 24.04

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl unzip docker.io nodejs npm
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Log out and log back in so Docker runs without `sudo`.

```bash
curl -Lo /tmp/kind https://kind.sigs.k8s.io/dl/v0.33.0/kind-linux-amd64
chmod +x /tmp/kind
sudo mv /tmp/kind /usr/local/bin/kind

curl -Lo /tmp/kubectl "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 /tmp/kubectl /usr/local/bin/kubectl
rm -f /tmp/kubectl

curl -fsSL https://get.pulumi.com | sh
echo 'export PATH="$HOME/.pulumi/bin:$PATH"' >> "$HOME/.bashrc"
export PATH="$HOME/.pulumi/bin:$PATH"
```

Open a new terminal before the next section.

### macOS

Install Homebrew if `brew` is not found:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Apple Silicon:

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Intel:

```bash
echo 'eval "$(/usr/local/bin/brew shellenv)"' >> "$HOME/.zprofile"
eval "$(/usr/local/bin/brew shellenv)"
```

```bash
brew install node kind kubectl
brew install pulumi/tap/pulumi
brew install --cask docker
```

Open Docker Desktop from Applications and wait until it is running.

### Windows

In PowerShell:

```powershell
winget install --exact --id Docker.DockerDesktop
winget install --exact --id OpenJS.NodeJS.LTS
winget install --exact --id Kubernetes.kind
winget install --exact --id Kubernetes.kubectl
winget install --exact --id Pulumi.Pulumi
winget install --exact --id Git.Git
```

Close PowerShell, open a new one, and start Docker Desktop. If Docker Desktop asks for WSL 2, accept it. The commands after this section are bash. Open Git Bash and continue there.

## Deploying the example

Clone this repository and enter its root:

```bash
git clone <repository-url>
cd <repository-directory>
```

`<repository-directory>` is the folder that contains `Pulumi.yaml`, `index.ts`, `kind-submission.yaml`, and `charts/`.

`kind-submission.yaml` publishes the services on `127.0.0.1`:

| Service | NodePort | Host URL |
|---|---:|---|
| Guestbook | 30080 | http://localhost:31080 |
| Prometheus | 30090 | http://localhost:31090 |
| Grafana | 30300 | http://localhost:31300 |

Use `kind-submission.yaml`. `kind-config.yaml` publishes different host ports, and the Pulumi outputs use the addresses in this table.

```bash
npm install
kind create cluster --name guestbook-submission --config kind-submission.yaml
kubectl config use-context kind-guestbook-submission
kubectl config current-context
```

The context must be `kind-guestbook-submission`.

```bash
pulumi login --local
pulumi stack init submission
pulumi stack select submission
pulumi preview
pulumi up
```

`pulumi stack init` asks for a passphrase. Choose one and keep it. The same passphrase is required later to read the Grafana password. If the `submission` stack already exists, skip `pulumi stack init` and run `pulumi stack select submission`.

`pulumi up` asks for confirmation. The first run downloads container images and can take several minutes.

npm may report advisories in the Pulumi SDK. Do not run `npm audit fix --force`. Do not commit `Pulumi.submission.yaml` or the local state directory.

Stack outputs:

```text
frontendIp            : <ClusterIP>
guestbookUrl          : "http://localhost:31080"
prometheusUrl         : "http://localhost:31090"
grafanaUrl            : "http://localhost:31300"
grafanaAdminUser      : "admin"
grafanaAdminPassword  : [secret]
```

`frontendIp` is the address inside the cluster. It changes on each deploy. Open `guestbookUrl` from the host.

## Grafana administrator credentials

- URL: http://localhost:31300/login
- Username: `admin`
- Password:

```bash
pulumi stack output grafanaAdminPassword --show-secrets
```

`pulumi stack output` without `--show-secrets` hides the value. The password is the one Grafana generated. Pulumi stores it as a secret output.

## What Prometheus scrapes

Jobs added in `index.ts`:

1. `guestbook-http-probe` probes `http://frontend.default.svc.cluster.local:80/` and the guestbook PHP URL through Blackbox Exporter. `probe_success` is a synthetic check, not an application request counter.
2. `redis-leader-exporter` on port `9121`, pointed at `redis-leader.default.svc.cluster.local:6379`.
3. `redis-replica-exporter` on port `9121`, pointed at `redis-replica.default.svc.cluster.local:6379`.

Those exporters are separate Deployments. Series include `redis_up`, `redis_commands_processed_total`, and `redis_memory_used_bytes`.

The Prometheus chart also scrapes the Kubernetes API, nodes, and cAdvisor, and kube-state-metrics is enabled. Container usage is `container_cpu_usage_seconds_total` and `container_memory_working_set_bytes`.

Running images are Prometheus `v2.54.1`, Grafana `11.3.0`, and kube-state-metrics `v2.20.0`.

## Grafana dashboard

Datasource uid `prometheus`. Dashboard uid `guestbook-sre-overview`.

http://localhost:31300/d/guestbook-sre-overview/guestbook-sre-telemetry-and-availability

Sign in with the credentials above. Panels cover probe success and latency, Redis health, command rate, and memory, frontend replicas, and pod CPU and memory.

## Verifying the deployment

```bash
kubectl config current-context
pulumi stack --show-name
kubectl get pods -n default
kubectl get pods -n monitoring
```

The context is `kind-guestbook-submission` and the stack is `submission`. The frontend has 3 replicas. Redis leader, Redis replica, Blackbox, both Redis exporters, kube-state-metrics, Prometheus (`2/2`), and Grafana are Running.

```bash
curl -sS "http://localhost:31080/guestbook.php?cmd=set&key=messages&value=SubmissionCheck"
curl -sS "http://localhost:31080/guestbook.php?cmd=get&key=messages"
curl -sS -o /dev/null -w 'prometheus:%{http_code}\n' http://localhost:31090/-/ready
curl -sS -o /dev/null -w 'grafana:%{http_code}\n' http://localhost:31300/login
PASS=$(pulumi stack output grafanaAdminPassword --show-secrets)
curl -sS -o /dev/null -w 'grafana_api:%{http_code}\n' -u "admin:${PASS}" http://localhost:31300/api/user
unset PASS
```

The guestbook commands return `{"message": "Updated"}` and `{"data": "SubmissionCheck"}`. Prometheus ready, Grafana login, and `grafana_api` return HTTP 200.

```bash
curl -sG http://localhost:31090/api/v1/query --data-urlencode 'query=probe_success'
curl -sG http://localhost:31090/api/v1/query --data-urlencode 'query=redis_up'
curl -sG http://localhost:31090/api/v1/query --data-urlencode 'query=rate(redis_commands_processed_total[5m])'
curl -sG http://localhost:31090/api/v1/query --data-urlencode 'query=container_cpu_usage_seconds_total{namespace="default"}'
```

On a successful run, `probe_success` is `1` for both frontend targets, `redis_up` is `1` for leader and replica, the Redis command rate returns a number for both, and the CPU query returns series for the `default` namespace. Prometheus also lists these targets under Status, then Targets: `guestbook-http-probe`, `redis-leader-exporter`, and `redis-replica-exporter`.

## Troubleshooting

If `docker version` has no Server section, start Docker and run the Kind command again.

On Linux, kube-proxy can exit with `fsnotify watcher init: too many open files` when the host inotify limit is exhausted. kube-state-metrics then cannot reach the API, and the Prometheus release times out. Raise the limit, restart kube-proxy, and run `pulumi up` again:

```bash
sudo sysctl -w fs.inotify.max_user_instances=1024
kubectl --context kind-guestbook-submission delete pod -n kube-system -l k8s-app=kube-proxy
```

A Helm note that the Grafana chart is deprecated does not stop the install.

## Cleaning up

Confirm the context is `kind-guestbook-submission` and the stack is `submission`.

```bash
pulumi destroy
pulumi stack rm submission
kind delete cluster --name guestbook-submission
```
