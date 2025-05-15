#!/bin/sh

echo "Running uname -m..."
ARCH="$(uname -m)"
echo "Raw architecture output: $ARCH"

case "$ARCH" in
  x86_64) ARCH_TAG="amd64" ;;
  aarch64|arm64) ARCH_TAG="arm64" ;;
  *)
    echo "Unsupported architecture: '$ARCH'"
    exit 1
    ;;
esac

echo "Detected architecture tag: $ARCH_TAG"

if [ -e "/var/run/docker.sock" ]; then
  # Install Docker CLI
  if [ -e "/usr/local/bin/docker" ]; then
    echo "Docker CLI is already installed."
  else
    echo "Installing Docker CLI..."
    curl -sSL "https://github.com/rancher-sandbox/rancher-desktop-docker-cli/releases/download/v28.1.1/docker-linux-${ARCH_TAG}" -o /usr/local/bin/docker
    chmod +x /usr/local/bin/docker
    echo "Docker CLI installed."
  fi

  # Install Docker Compose
  if [ -e "/usr/local/bin/docker-compose" ]; then
    echo "Docker Compose is already installed."
  else
    echo "Installing Docker Compose..."
    curl -sSL "https://github.com/docker/compose/releases/download/v2.18.0/docker-compose-linux-${ARCH_TAG}" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    echo "Docker Compose installed."
  fi
fi

if [ -e "/etc/rancher/k3s/k3s.yaml" ]; then
  # Install kubectl
  if [ -e "/usr/local/bin/kubectl" ]; then
    echo "kubectl is already installed."
  else
    echo "Installing kubectl..."
    curl -sSL "https://dl.k8s.io/release/v1.33.0/bin/linux/${ARCH_TAG}/kubectl" -o /usr/local/bin/kubectl
    chmod +x /usr/local/bin/kubectl
    echo "kubectl installed."
  fi

  mkdir -p ~/.kube
  cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
  sed -i 's/127.0.0.1/host.docker.internal/g' ~/.kube/config

  # Install Helm
  if [ -e "/usr/local/bin/helm" ]; then
    echo "Helm is already installed."
  else
    echo "Installing Helm..."
    curl -sSL "https://get.helm.sh/helm-v3.17.3-linux-${ARCH_TAG}.tar.gz" -o /tmp/helm.tar.gz
    tar -xzvf /tmp/helm.tar.gz -C /tmp
    mv /tmp/linux-${ARCH_TAG}/helm /usr/local/bin/helm
    chmod +x /usr/local/bin/helm
    rm -rf /tmp/helm.tar.gz /tmp/linux-${ARCH_TAG}
    echo "Helm installed."
  fi
fi

# Start mcpo
echo "Starting mcpo..."
exec mcpo --api-key "" --config /etc/mcpo/config.json
