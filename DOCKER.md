# Docker Deployment Guide

## 📦 Build và Deploy

### 1. Build Docker Image

```bash
# Build image
docker build -t mqtt-gps-collector:latest .

# Kiểm tra image size
docker images mqtt-gps-collector:latest
```

### 2. Sử dụng Docker Compose

#### **Production với .env từ host**

```bash
# Copy .env.docker thành .env và điều chỉnh cấu hình
cp .env.docker .env

# Chỉnh sửa .env theo môi trường production
nano .env

# Start tất cả services
docker-compose up -d

# Xem logs
docker-compose logs -f collector

# Stop services
docker-compose down
```

#### **Chỉ chạy collector (sử dụng external services)**

Nếu Redis và TimescaleDB đã có sẵn trên server khác:

```bash
# Chỉnh sửa .env để trỏ tới external services
MQTT_BROKER_URL=mqtt://103.216.116.186:1883
REDIS_HOST=103.216.116.186
POSTGRES_HOST=103.216.116.186

# Chỉ start collector service
docker-compose up -d collector
```

### 3. Kiểm tra trạng thái

```bash
# Xem các container đang chạy
docker-compose ps

# Xem logs real-time
docker-compose logs -f collector

# Kiểm tra health check
docker inspect mqtt-gps-collector | grep -A 10 Health

# Vào container để debug
docker exec -it mqtt-gps-collector sh
```

## 🔧 Cấu hình .env

File `.env` được mount từ host vào container. Bạn có thể thay đổi cấu hình mà không cần rebuild image:

```bash
# Chỉnh sửa .env
nano .env

# Restart container để áp dụng thay đổi
docker-compose restart collector
```

### Ví dụ .env cho Production

```env
# MQTT Configuration (external broker)
MQTT_BROKER_URL=mqtt://103.216.116.186:1883
MQTT_TOPIC=fms/+/operation_monitoring/gps_data

# Redis Configuration (external)
REDIS_HOST=103.216.116.186
REDIS_PORT=6379
REDIS_PASSWORD=098poiA#
REDIS_TTL=3600

# PostgreSQL Configuration (external)
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
```

## 📊 Monitoring

### View Logs

```bash
# Tất cả services
docker-compose logs -f

# Chỉ collector
docker-compose logs -f collector

# Last 100 lines
docker-compose logs --tail=100 collector
```

### Resource Usage

```bash
# CPU, Memory usage
docker stats mqtt-gps-collector

# Container details
docker inspect mqtt-gps-collector
```

## 🚀 Production Deployment

### 1. Sử dụng docker-compose.prod.yml

```bash
# Deploy production stack
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Scale collector instances
docker-compose up -d --scale collector=3
```

### 2. Sử dụng Docker Swarm

```bash
# Initialize swarm
docker swarm init

# Deploy stack
docker stack deploy -c docker-compose.yml fleet-collector

# List services
docker service ls

# Scale service
docker service scale fleet-collector_collector=3
```

### 3. Environment Variables qua Docker

Thay vì sử dụng file .env, có thể truyền trực tiếp:

```bash
docker run -d \
  --name mqtt-gps-collector \
  -p 3000:3000 \
  -e MQTT_BROKER_URL=mqtt://103.216.116.186:1883 \
  -e REDIS_HOST=103.216.116.186 \
  -e POSTGRES_HOST=103.216.116.186 \
  mqtt-gps-collector:latest
```

## 🔐 Security Best Practices

1. **Không commit .env vào Git**
   ```bash
   echo ".env" >> .gitignore
   ```

2. **Sử dụng Docker secrets (Swarm mode)**
   ```bash
   echo "my-password" | docker secret create postgres_password -
   ```

3. **Chạy container với non-root user** (đã cấu hình trong Dockerfile)

4. **Giới hạn resources**
   ```yaml
   services:
     collector:
       deploy:
         resources:
           limits:
             cpus: '1'
             memory: 512M
           reservations:
             cpus: '0.5'
             memory: 256M
   ```

## 🐛 Troubleshooting

### Container không start

```bash
# Xem logs
docker-compose logs collector

# Kiểm tra .env file
cat .env

# Kiểm tra network
docker network ls
docker network inspect fleet-network
```

### Kết nối database bị lỗi

```bash
# Test kết nối từ trong container
docker exec -it mqtt-gps-collector sh
nc -zv timescaledb 5432
```

### Memory issues

```bash
# Xem memory usage
docker stats --no-stream

# Restart với memory limit
docker-compose down
docker-compose up -d --memory=512m collector
```

## 📝 Image Size Optimization

Dockerfile hiện tại sử dụng multi-stage build để tối ưu size:

- **Base image**: `node:20-alpine` (~50MB)
- **Final image**: ~150-200MB (thay vì ~900MB với full node image)

### Kiểm tra image layers

```bash
docker history mqtt-gps-collector:latest
```

## 🔄 Update và Rollback

### Update image

```bash
# Pull latest changes
git pull

# Rebuild image
docker-compose build collector

# Rolling update (zero downtime)
docker-compose up -d --no-deps --build collector
```

### Rollback

```bash
# Tag current version
docker tag mqtt-gps-collector:latest mqtt-gps-collector:backup

# Revert to previous version
docker-compose down
docker-compose up -d
```

## 📚 Additional Resources

- [Docker Best Practices](https://docs.docker.com/develop/dev-best-practices/)
- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Node.js Docker Guide](https://nodejs.org/en/docs/guides/nodejs-docker-webapp/)
