#!/usr/bin/env node

/**
 * Test script to publish sample GPS data to MQTT broker
 * Usage: node scripts/test-gps-publish.js
 */

const mqtt = require('mqtt');
const crypto = require('crypto');

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const DEVICES = ['vehicle_001', 'vehicle_002', 'vehicle_003'];

// Sample GPS coordinates (Hanoi area)
const BASE_COORDINATES = [
  { lat: 21.027763, lon: 105.834160 }, // Hoan Kiem Lake
  { lat: 21.028511, lon: 105.804817 }, // Ba Dinh Square
  { lat: 21.007307, lon: 105.843162 }, // Hai Ba Trung District
];

const client = mqtt.connect(BROKER_URL, {
  clientId: `test_gps_publisher_${Math.random().toString(16).slice(3)}`,
});

client.on('connect', () => {
  console.log('✅ Connected to MQTT broker');
  console.log('📤 Publishing GPS test messages...\n');

  // Publish test messages for each device
  publishInitialGPSData();

  // Publish GPS data every 10 seconds (simulating periodic location updates)
  setInterval(() => {
    publishRandomGPSData();
  }, 10000);
});

client.on('error', (error) => {
  console.error('❌ MQTT Error:', error);
  process.exit(1);
});

function publishInitialGPSData() {
  DEVICES.forEach((deviceId, index) => {
    setTimeout(() => {
      publishGPSDataForDevice(deviceId, index);
    }, index * 2000);
  });
}

function publishRandomGPSData() {
  const deviceIndex = Math.floor(Math.random() * DEVICES.length);
  const deviceId = DEVICES[deviceIndex];
  publishGPSDataForDevice(deviceId, deviceIndex);
}

function publishGPSDataForDevice(deviceId, baseIndex) {
  const baseCoord = BASE_COORDINATES[baseIndex % BASE_COORDINATES.length];
  const numPoints = Math.floor(Math.random() * 3) + 2; // 2-4 GPS points per message

  const gpsData = [];
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < numPoints; i++) {
    // Add small random variations to simulate movement
    const latVariation = (Math.random() - 0.5) * 0.01; // ~1km variation
    const lonVariation = (Math.random() - 0.5) * 0.01;

    gpsData.push({
      gps_timestamp: now - ((numPoints - i - 1) * 5), // 5 seconds apart
      latitude: parseFloat((baseCoord.lat + latVariation).toFixed(6)),
      longitude: parseFloat((baseCoord.lon + lonVariation).toFixed(6)),
      accuracy: parseFloat((Math.random() * 2 + 0.5).toFixed(2)), // 0.5-2.5 meters
      gnss_status: Math.random() > 0.1, // 90% chance of good GPS signal
    });
  }

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
      console.log(`✅ Published GPS data to ${topic}:`);
      console.log(`   Device: ${deviceId}`);
      console.log(`   Points: ${gpsData.length}`);
      console.log(`   First point: ${gpsData[0].latitude}, ${gpsData[0].longitude}`);
      console.log(`   Last point: ${gpsData[gpsData.length - 1].latitude}, ${gpsData[gpsData.length - 1].longitude}`);
      console.log('');
    }
  });
}

// Handle exit
process.on('SIGINT', () => {
  console.log('\n👋 Closing connection...');
  client.end();
  process.exit(0);
});
