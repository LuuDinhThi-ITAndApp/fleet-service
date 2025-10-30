# 🚀 Quick Start Guide

Hướng dẫn chạy nhanh MQTT Edge Service trong 5 phút!

## Bước 1: Setup Dependencies

```bash
cd mqtt-service

# Start Docker services
docker-compose up -d

# Đợi vài giây để services khởi động
sleep 10
```

## Bước 2: Install & Configure

```bash
# Install Node packages
npm install

# Copy environment config
cp .env.example .env

# .env đã được config sẵn cho local development
```

## Bước 3: Start Service

Mở terminal 1:
```bash
npm run dev
```

Bạn sẽ thấy:
```
✅ All services started successfully
Socket.IO server listening on port 3000
Subscribed to topic: edge/+/events
```

## Bước 4: Test với MQTT Messages

Mở terminal 2:
```bash
# Publish test messages
node scripts/test-publish.js
```

Script này sẽ publish messages liên tục đến MQTT broker.

## Bước 5: View Dashboard

Mở file `examples/dashboard.html` trong browser:
```bash
# macOS
open examples/dashboard.html

# Linux
xdg-open examples/dashboard.html

# Windows
start examples/dashboard.html
```

Hoặc start một web server:
```bash
npx http-server examples -p 8080
# Truy cập http://localhost:8080/dashboard.html
```

## 🎉 Done!

Bạn sẽ thấy:
- ✅ Real-time events xuất hiện trên dashboard
- ✅ Device cards cập nhật khi có events mới
- ✅ Events list hiển thị 20 events gần nhất

## 🔍 Kiểm tra dữ liệu

### Redis Cache
```bash
docker exec -it redis-cache redis-cli
> KEYS device:*
> GET device:device_001
```

### TimescaleDB
```bash
docker exec -it timescaledb psql -U postgres -d edge_events
> SELECT * FROM edge_events ORDER BY timestamp DESC LIMIT 10;
> \q
```

### REST API
```bash
# Health check
curl http://localhost:3000/health

# Get all devices
curl http://localhost:3000/api/devices

# Get device history
curl http://localhost:3000/api/devices/device_001/history?limit=10
```

## 📊 Monitor Tools

- **pgAdmin**: http://localhost:5050 (admin@admin.com / admin)
- **Redis Commander**: http://localhost:8081

## 🛑 Stop Everything

```bash
# Stop service (Ctrl+C in terminal 1)
# Stop test publisher (Ctrl+C in terminal 2)

# Stop Docker services
docker-compose down

# Stop and remove volumes
docker-compose down -v
```

## ⚡ Tips

1. **High Volume Testing**: Giảm delay trong `test-publish.js` xuống 1000ms hoặc 500ms
2. **Custom Events**: Sửa `generateRandomData()` trong test-publish.js
3. **Production**: Đổi `allow_anonymous false` trong mosquitto.conf và setup authentication

## 🐛 Troubleshooting

**Service không connect được MQTT:**
```bash
# Check MQTT broker
docker logs mqtt-broker

# Test MQTT connection
mosquitto_sub -h localhost -t "#" -v
```

**Redis connection error:**
```bash
# Check Redis
docker logs redis-cache
redis-cli ping
```

**TimescaleDB error:**
```bash
# Check TimescaleDB
docker logs timescaledb

# Test connection
docker exec -it timescaledb psql -U postgres -d edge_events -c "SELECT 1;"
```

## 📚 Tiếp theo

- Đọc `README.md` để hiểu chi tiết architecture
- Customize message format trong `src/types/index.ts`
- Thêm custom processing logic trong `src/clients/mqtt.ts`
- Tích hợp với React/Vue dashboard thực tế
