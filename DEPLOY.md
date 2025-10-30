# 🚀 Quick Start - Deploy từ GHCR

## Pull và chạy image từ GitHub Container Registry

### 1. Pull image mới nhất

```bash
docker pull ghcr.io/luudinhth-itandapp/fleet-service:latest
```

### 2. Tạo file .env

```bash
cat > .env << 'EOF'
# MQTT Configuration
MQTT_BROKER_URL=mqtt://103.216.116.186:1883
MQTT_USERNAME=
MQTT_PASSWORD=
MQTT_TOPIC=fms/+/operation_monitoring/gps_data

# Redis Configuration
REDIS_HOST=103.216.116.186
REDIS_PORT=6379
REDIS_PASSWORD=098poiA#
REDIS_TTL=3600

# PostgreSQL/TimescaleDB Configuration
POSTGRES_HOST=103.216.116.186
POSTGRES_PORT=5432
POSTGRES_DB=fleet_telemetry
POSTGRES_USER=fleet
POSTGRES_PASSWORD=098poiA#

# Socket.IO Configuration
SOCKETIO_PORT=3000
SOCKETIO_CORS_ORIGIN=*

# Logging
LOG_LEVEL=info
EOF
```

### 3. Chạy container

```bash
docker run -d \
  --name mqtt-gps-collector \
  -p 3000:3000 \
  --env-file .env \
  --restart unless-stopped \
  ghcr.io/luudinhth-itandapp/fleet-service:latest
```

### 4. Kiểm tra logs

```bash
docker logs -f mqtt-gps-collector
```

### 5. Stop container

```bash
docker stop mqtt-gps-collector
docker rm mqtt-gps-collector
```

## 🐳 Sử dụng Docker Compose

### 1. Tạo docker-compose.yml

```yaml
version: '3.8'

services:
  collector:
    image: ghcr.io/luudinhth-itandapp/fleet-service:latest
    container_name: mqtt-gps-collector
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### 2. Chạy với docker-compose

```bash
# Start
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

## 🔄 Update lên phiên bản mới

```bash
# Pull image mới
docker pull ghcr.io/luudinhth-itandapp/fleet-service:latest

# Restart container
docker-compose down
docker-compose up -d

# Hoặc với docker run
docker stop mqtt-gps-collector
docker rm mqtt-gps-collector
docker run -d --name mqtt-gps-collector -p 3000:3000 --env-file .env ghcr.io/luudinhth-itandapp/fleet-service:latest
```

## 📦 Các phiên bản có sẵn

```bash
# Latest (main branch)
docker pull ghcr.io/luudinhth-itandapp/fleet-service:latest

# Specific version
docker pull ghcr.io/luudinhth-itandapp/fleet-service:v1.0.0

# Specific branch
docker pull ghcr.io/luudinhth-itandapp/fleet-service:main
docker pull ghcr.io/luudinhth-itandapp/fleet-service:develop
```

## 🔍 Troubleshooting

### Kiểm tra container đang chạy

```bash
docker ps | grep collector
```

### Xem logs chi tiết

```bash
docker logs mqtt-gps-collector --tail 100 -f
```

### Vào trong container để debug

```bash
docker exec -it mqtt-gps-collector sh
```

### Kiểm tra resource usage

```bash
docker stats mqtt-gps-collector
```

### Test kết nối

```bash
# Test Socket.IO endpoint
curl http://localhost:3000

# Test từ bên ngoài
curl http://YOUR_SERVER_IP:3000
```
