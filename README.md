# MQTT Edge Service

Service nhận events từ edge devices qua MQTT, cache vào Redis, lưu vào TimescaleDB, và streaming realtime lên dashboard qua Socket.IO.

## 📋 Tính năng

- ✅ Subscribe MQTT topics để nhận events từ edge devices
- ✅ Cache device state vào Redis theo device_id
- ✅ Batch insert vào TimescaleDB (hypertable) để tối ưu performance
- ✅ Streaming realtime events lên dashboard qua Socket.IO
- ✅ REST API để query device history
- ✅ Graceful shutdown
- ✅ Structured logging với Winston
- ✅ TypeScript với type safety

## 🏗️ Kiến trúc

```
Edge Devices → MQTT Broker → MQTT Service
                                  ↓
                            ┌─────┴─────┐
                            ↓           ↓
                        Redis Cache  TimescaleDB
                            ↓
                       Socket.IO Server
                            ↓
                       Dashboard
```

## 📦 Yêu cầu

- Node.js >= 18
- Docker & Docker Compose (cho dependencies)
- npm hoặc yarn

## 🚀 Cài đặt

### 1. Clone và install dependencies

```bash
cd mqtt-service
npm install
```

### 2. Setup môi trường

```bash
cp .env.example .env
# Chỉnh sửa .env theo cấu hình của bạn
```

### 3. Start dependencies với Docker

```bash
docker-compose up -d
```

Các services sẽ chạy trên:
- MQTT Broker: `localhost:1883`
- Redis: `localhost:6379`
- TimescaleDB: `localhost:5432`
- pgAdmin: `http://localhost:5050` (admin@admin.com / admin)
- Redis Commander: `http://localhost:8081`

### 4. Start service

**Development mode:**
```bash
npm run dev
```

**Production mode:**
```bash
npm run build
npm start
```

## 📡 MQTT Message Format

Service expect messages với format sau:

```json
{
  "device_id": "device_001",
  "timestamp": "2025-10-28T10:30:00Z",
  "event_type": "sensor_reading",
  "data": {
    "temperature": 25.5,
    "humidity": 60,
    "pressure": 1013.25
  },
  "metadata": {
    "location": "warehouse_1",
    "firmware_version": "v1.2.3"
  }
}
```

**MQTT Topic format:**
```
edge/{device_id}/events
```

Ví dụ: `edge/device_001/events`, `edge/sensor_abc/events`

## 🔌 Socket.IO Events

### Client → Server

```javascript
// Subscribe to specific device
socket.emit('subscribe:device', 'device_001');

// Unsubscribe from device
socket.emit('unsubscribe:device', 'device_001');

// Get device state from cache
socket.emit('get:device:state', 'device_001');
```

### Server → Client

```javascript
// Initial devices list on connect
socket.on('initial:devices', (devices) => {
  console.log('All devices:', devices);
});

// Real-time event broadcast
socket.on('edge:event', (event) => {
  console.log('New event:', event);
});

// Device-specific events (when subscribed)
socket.on('edge:device:event', (event) => {
  console.log('Device event:', event);
});

// Device state response
socket.on('device:state', (state) => {
  console.log('Device state:', state);
});
```

## 🌐 REST API

### Health Check
```bash
GET /health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2025-10-28T10:30:00Z",
  "connectedClients": 5
}
```

### Get All Devices
```bash
GET /api/devices
```

### Get Device History
```bash
GET /api/devices/{device_id}/history?limit=100
```

## 🧪 Test với MQTT Client

### Publish test message

```bash
# Install mosquitto clients
sudo apt-get install mosquitto-clients

# Publish a test message
mosquitto_pub -h localhost -t "edge/device_001/events" -m '{
  "device_id": "device_001",
  "timestamp": "2025-10-28T10:30:00Z",
  "event_type": "temperature",
  "data": {
    "value": 25.5,
    "unit": "celsius"
  }
}'
```

### Subscribe to check messages

```bash
mosquitto_sub -h localhost -t "edge/+/events" -v
```

## 💻 Frontend Example (React/Vue)

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000');

// Connect
socket.on('connect', () => {
  console.log('Connected to server');
});

// Receive initial devices
socket.on('initial:devices', (devices) => {
  console.log('Devices:', devices);
});

// Subscribe to specific device
socket.emit('subscribe:device', 'device_001');

// Listen for real-time events
socket.on('edge:event', (event) => {
  console.log('New event:', event);
  // Update UI with new data
});

// Listen for device-specific events
socket.on('edge:device:event', (event) => {
  console.log('Device event:', event);
  // Update specific device dashboard
});
```

## 📊 TimescaleDB Queries

```sql
-- Get recent events for a device
SELECT * FROM edge_events 
WHERE device_id = 'device_001' 
ORDER BY timestamp DESC 
LIMIT 100;

-- Get average temperature per hour
SELECT 
  time_bucket('1 hour', timestamp) AS hour,
  device_id,
  AVG((data->>'temperature')::float) as avg_temp
FROM edge_events 
WHERE event_type = 'sensor_reading'
  AND timestamp > NOW() - INTERVAL '24 hours'
GROUP BY hour, device_id
ORDER BY hour DESC;

-- Count events by type
SELECT 
  event_type, 
  COUNT(*) as count 
FROM edge_events 
WHERE timestamp > NOW() - INTERVAL '1 day'
GROUP BY event_type;
```

## 🔧 Configuration

Các biến môi trường trong `.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `MQTT_BROKER_URL` | MQTT broker URL | `mqtt://localhost:1883` |
| `MQTT_TOPIC` | MQTT topic pattern | `edge/+/events` |
| `REDIS_HOST` | Redis host | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_TTL` | Cache TTL (seconds) | `3600` |
| `POSTGRES_HOST` | TimescaleDB host | `localhost` |
| `POSTGRES_PORT` | TimescaleDB port | `5432` |
| `POSTGRES_DB` | Database name | `edge_events` |
| `SOCKETIO_PORT` | Socket.IO server port | `3000` |
| `LOG_LEVEL` | Logging level | `info` |

## 🎯 Performance Tips

1. **Batch Insert**: Service tự động batch events (50 events hoặc 5 seconds) trước khi insert vào DB
2. **Redis Cache**: Device state được cache để giảm load trên DB
3. **Connection Pooling**: TimescaleDB sử dụng connection pool (max 20)
4. **Indexed Queries**: Đã tạo indexes cho device_id và event_type

## 🐛 Debugging

Bật debug logs:
```bash
LOG_LEVEL=debug npm run dev
```

Monitor MQTT messages:
```bash
mosquitto_sub -h localhost -t "#" -v
```

Check Redis keys:
```bash
redis-cli
> KEYS device:*
> GET device:device_001
```

## 📝 License

MIT
