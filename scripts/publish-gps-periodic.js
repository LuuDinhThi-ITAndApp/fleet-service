#!/usr/bin/env node

/**
 * Script để publish GPS data định kỳ mỗi 10 giây vào MQTT broker
 * Theo đúng model GPSDataPoint (có speed field)
 * Usage: node scripts/publish-gps-periodic.js
 */

const mqtt = require('mqtt');
const crypto = require('crypto');

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://103.216.116.186:1883';
const DEVICES = ['vehicle_001', 'vehicle_002', 'vehicle_003'];
const PUBLISH_INTERVAL = 10000; // 10 seconds

// Sample GPS coordinates (Hanoi area)
const BASE_COORDINATES = [
  { lat: 21.027763, lon: 105.834160, name: 'Hoan Kiem Lake' },
  { lat: 21.028511, lon: 105.804817, name: 'Ba Dinh Square' },
  { lat: 21.007307, lon: 105.843162, name: 'Hai Ba Trung District' },
];

// Tracking vehicle states
const vehicleStates = {};

const client = mqtt.connect(BROKER_URL, {
  clientId: `gps_publisher_${Math.random().toString(16).slice(3)}`,
});

client.on('connect', () => {
  console.log('✅ Đã kết nối tới MQTT broker');
  console.log(`📍 Broker: ${BROKER_URL}`);
  console.log(`⏱️  Publish interval: ${PUBLISH_INTERVAL / 1000}s`);
  console.log(`🚗 Devices: ${DEVICES.join(', ')}`);
  console.log('📤 Bắt đầu publish GPS data...\n');

  // Initialize vehicle states
  DEVICES.forEach((deviceId, index) => {
    const baseCoord = BASE_COORDINATES[index % BASE_COORDINATES.length];
    vehicleStates[deviceId] = {
      lat: baseCoord.lat,
      lon: baseCoord.lon,
      speed: 0,
      direction: Math.random() * 360, // Random initial direction
      baseIndex: index,
    };
  });

  // Publish immediately for all devices
  DEVICES.forEach((deviceId) => {
    publishGPSData(deviceId);
  });

  // Then publish periodically every 10 seconds
  setInterval(() => {
    DEVICES.forEach((deviceId) => {
      publishGPSData(deviceId);
    });
  }, PUBLISH_INTERVAL);
});

client.on('error', (error) => {
  console.error('❌ MQTT Error:', error);
  process.exit(1);
});

/**
 * Simulate vehicle movement
 */
function updateVehiclePosition(state) {
  // Random speed between 0-80 km/h
  const speedVariation = (Math.random() - 0.5) * 10;
  state.speed = Math.max(0, Math.min(80, state.speed + speedVariation));

  // Random direction change
  const directionChange = (Math.random() - 0.5) * 30;
  state.direction = (state.direction + directionChange + 360) % 360;

  // Calculate movement (speed in km/h converted to degrees)
  // Approximate: 1 degree lat/lon ≈ 111 km
  const distanceKm = (state.speed / 3600) * (PUBLISH_INTERVAL / 1000); // Distance in km
  const distanceDeg = distanceKm / 111;

  // Update position based on direction
  const radians = (state.direction * Math.PI) / 180;
  state.lat += distanceDeg * Math.cos(radians);
  state.lon += distanceDeg * Math.sin(radians);

  // Keep vehicle within reasonable bounds (Hanoi area)
  state.lat = Math.max(20.95, Math.min(21.15, state.lat));
  state.lon = Math.max(105.75, Math.min(105.90, state.lon));
}

/**
 * Generate GPS data points
 */
function generateGPSPoints(state, numPoints = 3) {
  const gpsData = [];
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < numPoints; i++) {
    // Simulate movement for each point
    if (i > 0) {
      updateVehiclePosition(state);
    }

    // Add small random variations for accuracy
    const latNoise = (Math.random() - 0.5) * 0.0001;
    const lonNoise = (Math.random() - 0.5) * 0.0001;

    gpsData.push({
      gps_timestamp: now - ((numPoints - i - 1) * 3), // 3 seconds apart
      latitude: parseFloat((state.lat + latNoise).toFixed(6)),
      longitude: parseFloat((state.lon + lonNoise).toFixed(6)),
      accuracy: parseFloat((Math.random() * 2 + 1).toFixed(2)), // 1-3 meters
      speed: parseFloat(state.speed.toFixed(2)), // km/h
    });
  }

  return gpsData;
}

/**
 * Publish GPS data for a device
 */
function publishGPSData(deviceId) {
  const state = vehicleStates[deviceId];
  const numPoints = Math.floor(Math.random() * 2) + 2; // 2-3 GPS points per message
  const now = Math.floor(Date.now() / 1000);

  const gpsData = generateGPSPoints(state, numPoints);

  const payload = {
    time_stamp: now,
    message_id: crypto.createHash('md5').update(`${deviceId}_${now}`).digest('hex'),
    gps_data: gpsData,
  };

  const topic = `fms/${deviceId}/operation_monitoring/gps_data`;

  client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
    if (err) {
      console.error(`❌ Failed to publish to ${topic}:`, err);
    } else {
      const lastPoint = gpsData[gpsData.length - 1];
      console.log(`✅ [${new Date().toLocaleTimeString()}] ${deviceId}`);
      console.log(`   📍 Position: ${lastPoint.latitude.toFixed(6)}, ${lastPoint.longitude.toFixed(6)}`);
      console.log(`   🚗 Speed: ${lastPoint.speed.toFixed(1)} km/h`);
      console.log(`   📊 Points: ${gpsData.length}, Accuracy: ${lastPoint.accuracy}m`);
      console.log('');
    }
  });
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Đang đóng kết nối...');
  client.end();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Đang đóng kết nối...');
  client.end();
  process.exit(0);
});
