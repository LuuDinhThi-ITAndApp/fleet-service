#!/usr/bin/env node

/**
 * Script để publish GPS data từ CSV file vào MQTT broker
 * Đọc từ dataClean-testRun20251106.csv và phát theo thứ tự
 * Usage: node scripts/publish-gps-from-csv.js
 */

const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const { time } = require('console');

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://103.216.116.186:1883';
const CSV_FILE = path.join(__dirname, 'dataClean-testRun20251106.csv');
const PUBLISH_INTERVAL = 200; // 2 seconds between messages

// Storage for GPS data by vehicle
const gpsDataByVehicle = {};
let currentIndexByVehicle = {};

const client = mqtt.connect(BROKER_URL, {
  clientId: `gps_csv_publisher_${Math.random().toString(16).slice(3)}`,
});

/**
 * Parse CSV file and load GPS data
 */
function loadGPSDataFromCSV() {
  console.log('📂 Đang đọc file CSV:', CSV_FILE);

  try {
    const csvContent = fs.readFileSync(CSV_FILE, 'utf-8');
    const lines = csvContent.trim().split('\n');

    // Skip header
    const dataLines = lines.slice(1);

    console.log(`📊 Tổng số dòng trong CSV: ${dataLines.length}`);

    dataLines.forEach((line, index) => {
      // Parse CSV line (handle quoted values)
      const matches = line.match(/"([^"]*)"/g);
      if (!matches || matches.length < 6) {
        console.warn(`⚠️  Bỏ qua dòng ${index + 2}: format không hợp lệ`);
        return;
      }

      const [timeStr, vehicleId, latStr, lonStr, speedStr, accuracyStr] = matches.map(s => s.replace(/"/g, ''));

      // Parse timestamp
      const timestamp = new Date(timeStr);
      if (isNaN(timestamp.getTime())) {
        console.warn(`⚠️  Bỏ qua dòng ${index + 2}: timestamp không hợp lệ`);
        return;
      }

      const gpsPoint = {
        time: timestamp,
        gps_timestamp: timestamp.getTime(), // Unix timestamp in seconds
        latitude: parseFloat(latStr),
        longitude: parseFloat(lonStr),
        speed: parseFloat(speedStr),
        accuracy: parseFloat(accuracyStr),
      };

      // Group by vehicle
      if (!gpsDataByVehicle[vehicleId]) {
        gpsDataByVehicle[vehicleId] = [];
        currentIndexByVehicle[vehicleId] = 0;
      }

      gpsDataByVehicle[vehicleId].push(gpsPoint);
    });

    // Sort each vehicle's data by time (oldest first)
    Object.keys(gpsDataByVehicle).forEach(vehicleId => {
      gpsDataByVehicle[vehicleId].sort((a, b) => a.time - b.time);
      console.log(`✅ Vehicle ${vehicleId}: ${gpsDataByVehicle[vehicleId].length} GPS points loaded`);
    });

    console.log('');
    return true;
  } catch (error) {
    console.error('❌ Lỗi khi đọc file CSV:', error.message);
    return false;
  }
}

client.on('connect', () => {
  console.log('✅ Đã kết nối tới MQTT broker');
  console.log(`📍 Broker: ${BROKER_URL}`);
  console.log(`⏱️  Publish interval: ${PUBLISH_INTERVAL / 1000}s`);
  console.log('');

  // Load CSV data
  const loaded = loadGPSDataFromCSV();
  if (!loaded || Object.keys(gpsDataByVehicle).length === 0) {
    console.error('❌ Không có dữ liệu để publish. Thoát...');
    process.exit(1);
  }

  const vehicles = Object.keys(gpsDataByVehicle);
  console.log(`🚗 Vehicles: ${vehicles.join(', ')}`);
  console.log('📤 Bắt đầu publish GPS data từ CSV...\n');

  // Publish immediately for all vehicles
  vehicles.forEach((vehicleId) => {
    publishNextGPSData(vehicleId);
  });

  // Then publish periodically
  setInterval(() => {
    vehicles.forEach((vehicleId) => {
      publishNextGPSData(vehicleId);
    });
  }, PUBLISH_INTERVAL);
});

client.on('error', (error) => {
  console.error('❌ MQTT Error:', error);
  process.exit(1);
});

/**
 * Publish next batch of GPS data for a vehicle
 */
function publishNextGPSData(vehicleId) {
  const vehicleData = gpsDataByVehicle[vehicleId];
  const currentIndex = currentIndexByVehicle[vehicleId];

  if (currentIndex >= vehicleData.length) {
    console.log(`ℹ️  [${vehicleId}] Đã hết dữ liệu CSV. Bắt đầu lại từ đầu...`);
    currentIndexByVehicle[vehicleId] = 0;
    return;
  }

  // Get next 1-3 GPS points for this message
  const batchSize = Math.min(1, vehicleData.length - currentIndex);
  const gpsPoints = [];

  for (let i = 0; i < batchSize; i++) {
    const point = vehicleData[currentIndex + i];
    gpsPoints.push({
      gps_timestamp: point.gps_timestamp,
      latitude: point.latitude,
      longitude: point.longitude,
      accuracy: point.accuracy,
      speed: Math.floor(point.speed),
    });
  }

  // Update index for next time
  currentIndexByVehicle[vehicleId] += batchSize;

  // Create payload with milliseconds timestamp
  const now = Date.now(); // milliseconds
  const payload = {
    time_stamp: now, // Use milliseconds (13 digits)
    message_id: `GPS_Data-${vehicleId}-${now}`,
    gps_data: gpsPoints,
  };

  const topic = `fms/${vehicleId}/operation_monitoring/gps_data`;

  client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
    if (err) {
      console.error(`❌ Failed to publish to ${topic}:`, err);
    } else {
      const lastPoint = gpsPoints[gpsPoints.length - 1];
      const progress = ((currentIndexByVehicle[vehicleId] / vehicleData.length) * 100).toFixed(1);

      console.log(`✅ [${new Date().toLocaleTimeString()}] ${vehicleId} (${progress}% complete)`);
      console.log(`   📍 Position: ${lastPoint.latitude.toFixed(8)}, ${lastPoint.longitude.toFixed(8)}`);
      console.log(`   🚗 Speed: ${lastPoint.speed.toFixed(2)} km/h`);
      console.log(`   📊 Points: ${gpsPoints.length}, Accuracy: ${lastPoint.accuracy.toFixed(2)}m`);
      console.log(`   📈 Progress: ${currentIndexByVehicle[vehicleId]}/${vehicleData.length} points sent`);
      console.log('');
    }
  });
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Đang đóng kết nối...');

  // Show final statistics
  console.log('\n📊 Thống kê cuối cùng:');
  Object.keys(gpsDataByVehicle).forEach(vehicleId => {
    const total = gpsDataByVehicle[vehicleId].length;
    const sent = currentIndexByVehicle[vehicleId];
    const percentage = ((sent / total) * 100).toFixed(1);
    console.log(`   ${vehicleId}: ${sent}/${total} points (${percentage}%)`);
  });

  client.end();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Đang đóng kết nối...');
  client.end();
  process.exit(0);
});
