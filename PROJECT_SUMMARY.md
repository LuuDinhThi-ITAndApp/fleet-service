# 📦 MQTT Edge Service - Project Summary

## ✅ Đã tạo skeleton hoàn chỉnh với:

### 📁 Project Structure

```
mqtt-service/
├── src/
│   ├── clients/
│   │   ├── mqtt.ts          # MQTT subscriber với batch processing
│   │   ├── redis.ts         # Redis cache client
│   │   └── timescaledb.ts   # TimescaleDB client với hypertable
│   ├── config/
│   │   └── index.ts         # Configuration loader
│   ├── server/
│   │   └── socketio.ts      # Socket.IO server + REST API
│   ├── types/
│   │   └── index.ts         # TypeScript type definitions
│   ├── utils/
│   │   └── logger.ts        # Winston logger
│   └── index.ts             # Main entry point
├── scripts/
│   ├── test-publish.js      # MQTT test publisher (generic events)
│   └── test-gps-publish.js  # GPS data test publisher
├── examples/
│   └── dashboard.html       # Example real-time dashboard
├── docker/
│   └── mosquitto/
│       └── config/
│           └── mosquitto.conf
├── docker-compose.yml       # All dependencies
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md               # Chi tiết documentation
└── QUICKSTART.md          # Quick start guide
```

## 🎯 Core Features Implemented

### 1. **MQTT Subscriber** (src/clients/mqtt.ts)
- ✅ Auto-reconnect khi mất kết nối
- ✅ Batch insert (50 events hoặc 5 seconds)
- ✅ Topic pattern matching: `fms/+/operation_monitoring/gps_data`
- ✅ Extract device_id từ topic
- ✅ Parallel processing: cache + stream + batch
- ✅ Specialized GPS data handler với batch processing
- ✅ Support cho multiple GPS points per message

### 2. **Redis Cache** (src/clients/redis.ts)
- ✅ Cache device state theo device_id
- ✅ TTL configurable (default 1 hour)
- ✅ Store latest 100 events list
- ✅ Connection pooling và error handling

### 3. **TimescaleDB Storage** (src/clients/timescaledb.ts)
- ✅ Auto-create hypertable với 1-day chunks
- ✅ Indexes on device_id và event_type
- ✅ Batch insert optimization
- ✅ Connection pooling (max 20)
- ✅ Query methods cho history
- ✅ Separate `gps_data` hypertable với location indexes
- ✅ Time-range queries cho GPS tracking
- ✅ Optimized storage cho GPS coordinates

### 4. **Socket.IO Server** (src/server/socketio.ts)
- ✅ Real-time event broadcast
- ✅ Device-specific rooms/subscriptions
- ✅ REST API endpoints:
  - GET /health
  - GET /api/devices
  - GET /api/devices/:id/history
- ✅ CORS configuration
- ✅ Connection tracking

### 5. **Type Safety** (TypeScript)
- ✅ EdgeEvent interface
- ✅ CachedDeviceState interface
- ✅ GPSDataPayload và GPSDataPoint interfaces
- ✅ GPSDataRow interface cho database
- ✅ Strong typing cho tất cả functions

## 🔄 Data Flow

```
MQTT Message → Parse & Validate
                    ↓
              ┌─────┴─────────┐
              ↓               ↓
         Redis Cache    Socket.IO Emit
              ↓               ↓
         (TTL: 1h)      Dashboard
              
         Batch Buffer
              ↓
    (50 events or 5s timeout)
              ↓
         TimescaleDB
```

## 🚀 How to Run

1. **Install dependencies:**
   ```bash
   cd mqtt-service
   docker-compose up -d
   npm install
   cp .env.example .env
   ```

2. **Start service:**
   ```bash
   npm run dev
   ```

3. **Test:**
   ```bash
   # Terminal 2 - Test GPS data
   node scripts/test-gps-publish.js

   # Or test generic events
   node scripts/test-publish.js

   # Open dashboard
   open examples/dashboard.html
   ```

## 📊 Performance Characteristics

- **MQTT**: QoS 1 (at least once delivery)
- **Batch Size**: 50 events hoặc 5 seconds
- **Redis TTL**: 3600 seconds (1 hour)
- **DB Connections**: Max 20 concurrent
- **Socket.IO**: WebSocket + polling fallback

## 🔧 Configuration

Tất cả config qua environment variables trong `.env`:

| Variable | Purpose |
|----------|---------|
| MQTT_BROKER_URL | MQTT broker address |
| REDIS_HOST/PORT | Redis connection |
| POSTGRES_HOST/PORT | TimescaleDB connection |
| SOCKETIO_PORT | Server port |
| LOG_LEVEL | debug/info/warn/error |

## 📝 Message Formats

### GPS Data Message (fms/{device_id}/operation_monitoring/gps_data)

```json
{
  "time_stamp": 1761190484,
  "message_id": "device_id_hash",
  "gps_data": [
    {
      "gps_timestamp": 1761190484,
      "latitude": 21.027763,
      "longitude": 105.834160,
      "accuracy": 0.5,
      "gnss_status": true
    },
    {
      "gps_timestamp": 1761190489,
      "latitude": 21.027800,
      "longitude": 105.834200,
      "accuracy": 0.5,
      "gnss_status": true
    }
  ]
}
```

**Topic Structure:** `fms/{device_id}/operation_monitoring/gps_data`
- QoS: 1 (at least once delivery)
- Periodically sends location data to server
- Supports multiple GPS points per message for batch updates

### Generic Event Message (legacy format)

```json
{
  "device_id": "device_001",
  "timestamp": "2025-10-28T10:30:00Z",
  "event_type": "sensor_reading",
  "data": { ... },
  "metadata": { ... }
}
```

## 🎨 Frontend Integration

Socket.IO events cho dashboard:

**Receive:**
- `initial:devices` - Danh sách devices khi connect
- `edge:event` - Broadcast tất cả events
- `edge:device:event` - Events từ specific device
- `gps:data` - Broadcast GPS data từ tất cả devices
- `gps:device:data` - GPS data từ specific device

**Emit:**
- `subscribe:device` - Subscribe to device
- `unsubscribe:device` - Unsubscribe
- `get:device:state` - Request device state

## 🐛 Debugging

```bash
# Logs
LOG_LEVEL=debug npm run dev

# MQTT
mosquitto_sub -h localhost -t "#" -v

# Redis
docker exec -it redis-cache redis-cli

# TimescaleDB
docker exec -it timescaledb psql -U postgres -d edge_events
```

## 🎁 Extras

- ✅ Graceful shutdown handlers
- ✅ Health check endpoint
- ✅ Error handling với try-catch
- ✅ Winston structured logging
- ✅ Docker Compose với pgAdmin + Redis Commander
- ✅ Example HTML dashboard
- ✅ Test publisher script

## 📚 Next Steps

1. **Customize Event Types**: Sửa trong `src/types/index.ts`
2. **Add Data Processing**: Thêm logic trong `mqtt.ts` handleMessage
3. **Production Deploy**: 
   - Enable MQTT authentication
   - Add Redis Sentinel/Cluster
   - Setup TimescaleDB replication
   - Add monitoring (Prometheus/Grafana)
4. **Build Real Dashboard**: Integrate với React/Vue/Angular

## 💡 Production Tips

- Use environment-specific .env files
- Implement retry logic cho failed inserts
- Add dead-letter queue cho failed events
- Monitor memory usage (batch buffer)
- Setup alerts cho connection failures
- Consider using message queue (RabbitMQ/Kafka) cho high volume

---

**Ready to use!** 🚀 Chạy ngay với `npm run dev`
