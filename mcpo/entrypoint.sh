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
    DOCKER_CLI_URL="https://github.com/rancher-sandbox/rancher-desktop-docker-cli/releases/download/v29.1.4/docker-linux-${ARCH_TAG}"
    DOCKER_CLI_CHECKSUM_amd64="0b8c7f38d283dea530fc2dbd03449dddcc089d58bace41089e481c365f008e5f"
    DOCKER_CLI_CHECKSUM_arm64="f6e4b6d3655eb57f91a97b831194dc7dc7f2db3aa9d5d993372d4363f35b6694"
    curl -sSL "${DOCKER_CLI_URL}" -o /usr/local/bin/docker
    echo "Verifying Docker CLI checksum..."
    if [ "$ARCH_TAG" = "amd64" ]; then
      echo "${DOCKER_CLI_CHECKSUM_amd64}  /usr/local/bin/docker" | sha256sum -c -
    else
      echo "${DOCKER_CLI_CHECKSUM_arm64}  /usr/local/bin/docker" | sha256sum -c -
    fi
    if [ $? -ne 0 ]; then
      echo "Docker CLI checksum verification failed. Exiting."
      exit 1
    fi
    chmod +x /usr/local/bin/docker
    echo "Docker CLI installed."
  fi

  # Install Docker Compose
  if [ -e "/usr/local/bin/docker-compose" ]; then
    echo "Docker Compose is already installed."
  else
    echo "Installing Docker Compose..."
    DOCKER_COMPOSE_URL="https://github.com/docker/compose/releases/download/v5.0.1/docker-compose-linux-${ARCH_TAG}"
    DOCKER_COMPOSE_CHECKSUM_amd64="766d6f9b305d89c3b8fe88cb6fb207fd7f531fbd63982b6136d058c1f98767bd"
    DOCKER_COMPOSE_CHECKSUM_arm64="ac7810e0cd56a5b58576688196fafa843e07e8241fb91018a736d549ea20a3f3"
    curl -sSL "${DOCKER_COMPOSE_URL}" -o /usr/local/bin/docker-compose
    echo "Verifying Docker Compose checksum..."
    if [ "$ARCH_TAG" = "amd64" ]; then
      echo "${DOCKER_COMPOSE_CHECKSUM_amd64}  /usr/local/bin/docker-compose" | sha256sum -c -
    else
      echo "${DOCKER_COMPOSE_CHECKSUM_arm64}  /usr/local/bin/docker-compose" | sha256sum -c -
    fi
    if [ $? -ne 0 ]; then
      echo "Docker Compose checksum verification failed. Exiting."
      exit 1
    fi
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
    KUBECTL_URL="https://dl.k8s.io/release/v1.35.0/bin/linux/${ARCH_TAG}/kubectl"
    KUBECTL_CHECKSUM_amd64="a2e984a18a0c063279d692533031c1eff93a262afcc0afdc517375432d060989"
    KUBECTL_CHECKSUM_arm64="58f82f9fe796c375c5c4b8439850b0f3f4d401a52434052f2df46035a8789e25"
    curl -sSL "${KUBECTL_URL}" -o /usr/local/bin/kubectl
    echo "Verifying kubectl checksum..."
    if [ "$ARCH_TAG" = "amd64" ]; then
      echo "${KUBECTL_CHECKSUM_amd64}  /usr/local/bin/kubectl" | sha256sum -c -
    else
      echo "${KUBECTL_CHECKSUM_arm64}  /usr/local/bin/kubectl" | sha256sum -c -
    fi
    if [ $? -ne 0 ]; then
      echo "kubectl checksum verification failed. Exiting."
      exit 1
    fi
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
    HELM_URL="https://get.helm.sh/helm-v4.0.5-linux-${ARCH_TAG}.tar.gz"
    HELM_CHECKSUM_amd64="730e4e9fbff94168249ddd0b9b1b8c357b7f64815462dd88c6b39f09bf18b814"
    HELM_CHECKSUM_arm64="206a7747702d13994a93629eaed4259bd9d0aec6e23ca52d640f47f7edfdc863"
    curl -sSL "${HELM_URL}" -o /tmp/helm.tar.gz
    echo "Verifying Helm checksum..."
    if [ "$ARCH_TAG" = "amd64" ]; then
      echo "${HELM_CHECKSUM_amd64}  /tmp/helm.tar.gz" | sha256sum -c -
    else
      echo "${HELM_CHECKSUM_arm64}  /tmp/helm.tar.gz" | sha256sum -c -
    fi
    if [ $? -ne 0 ]; then
      echo "Helm checksum verification failed. Exiting."
      exit 1
    fi
    tar -xzvf /tmp/helm.tar.gz -C /tmp
    mv /tmp/linux-${ARCH_TAG}/helm /usr/local/bin/helm
    chmod +x /usr/local/bin/helm
    rm -rf /tmp/helm.tar.gz /tmp/linux-${ARCH_TAG}
    echo "Helm installed."
  fi
fi

# Install https://pypi.org/project/mcp-openapi-proxy/
uvx mcp-openapi-proxy==0.1.1745367160

# Start mcpo
echo "Starting mcpo..."
exec mcpo --api-key "" --config /etc/mcpo/config.json