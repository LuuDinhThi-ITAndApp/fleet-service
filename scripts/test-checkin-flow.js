#!/usr/bin/env node

/**
 * Script để test full check-in flow:
 * 1. Driver Request -> nhận driver_id và server trả về driver info
 * 2. Driver Check-in -> tạo trip mới
 *
 * Flow này test việc edge device gửi driver_id, nhận thông tin driver,
 * sau đó gửi check-in data để tạo trip
 */

const mqtt = require('mqtt');

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://103.216.116.186:1883';
const DEVICE_ID = process.argv[2] || 'vehicle_001';
const DRIVER_ID = process.argv[3] || '880e8400-e29b-41d4-a716-446655440001';

console.log('\n🧪 Check-in Flow Test');
console.log('='.repeat(70));
console.log(`📍 Broker: ${BROKER_URL}`);
console.log(`📱 Device ID: ${DEVICE_ID}`);
console.log(`👤 Driver ID: ${DRIVER_ID}`);
console.log('='.repeat(70) + '\n');

// Create MQTT client
const client = mqtt.connect(BROKER_URL, {
  clientId: `test_checkin_flow_${Math.random().toString(16).slice(3)}`,
});

// Subscribe to driver info response
const driverInfoTopic = `fms/${DEVICE_ID}/driving_session/driver_info`;
let driverInfoReceived = false;

client.on('connect', () => {
  console.log('✅ Connected to MQTT broker\n');

  // Subscribe to driver info response topic
  client.subscribe(driverInfoTopic, { qos: 1 }, (err) => {
    if (err) {
      console.error('❌ Failed to subscribe to driver info topic:', err);
      client.end();
      process.exit(1);
    } else {
      console.log(`📡 Subscribed to: ${driverInfoTopic}\n`);

      // Start the flow
      console.log('📋 Flow Steps:');
      console.log('  1️⃣  Send Driver Request with driver_id');
      console.log('  2️⃣  Receive Driver Info from server');
      console.log('  3️⃣  Send Driver Check-in to create trip');
      console.log('');

      // Step 1: Send Driver Request
      step1_sendDriverRequest();
    }
  });
});

// Handle incoming messages
client.on('message', (topic, message) => {
  if (topic === driverInfoTopic) {
    console.log('2️⃣  Step 2: Received Driver Info Response');
    console.log('-'.repeat(70));
    console.log('Topic:', topic);

    try {
      const driverInfo = JSON.parse(message.toString());
      console.log('Driver Info:', JSON.stringify(driverInfo, null, 2));
      console.log('');
      console.log('✅ Driver info received successfully!\n');

      driverInfoReceived = true;

      // Wait a bit then send check-in
      setTimeout(() => step3_sendCheckIn(driverInfo), 2000);
    } catch (err) {
      console.error('❌ Failed to parse driver info:', err);
      client.end();
      process.exit(1);
    }
  }
});

function step1_sendDriverRequest() {
  console.log('1️⃣  Step 1: Send Driver Request');
  console.log('-'.repeat(70));

  const payload = {
    time_stamp: Date.now(),
    message_id: `checkin_test_driver_req_${Date.now()}`,
    driver_id: DRIVER_ID
  };

  console.log('Topic:', `fms/${DEVICE_ID}/driving_session/driver_request`);
  console.log('Payload:', JSON.stringify(payload, null, 2));
  console.log('');

  client.publish(
    `fms/${DEVICE_ID}/driving_session/driver_request`,
    JSON.stringify(payload),
    { qos: 1 },
    (err) => {
      if (err) {
        console.error('❌ Failed to send driver request:', err);
        client.end();
        process.exit(1);
      } else {
        console.log('✅ Driver Request sent');
        console.log('⏳ Waiting for driver info response...\n');

        // Set timeout in case we don't receive driver info
        setTimeout(() => {
          if (!driverInfoReceived) {
            console.error('❌ Timeout: Driver info not received after 5 seconds');
            console.log('💡 Check if server is running and processing driver requests');
            client.end();
            process.exit(1);
          }
        }, 5000);
      }
    }
  );
}

function step3_sendCheckIn(driverInfo) {
  console.log('3️⃣  Step 3: Send Driver Check-in');
  console.log('-'.repeat(70));

  const payload = {
    time_stamp: Date.now(),
    message_id: `checkin_test_checkin_${Date.now()}`,
    check_in_data: {
      driver_information: {
        driver_name: driverInfo.driver_information?.driver_name || "Test Driver",
        driver_license_number: driverInfo.driver_information?.driver_license_number || "B123456789"
      },
      check_in_timestamp: Date.now(),
      CheckInLocation: {
        gps_timestamp: Date.now(),
        latitude: 21.0285,
        longitude: 105.8542,
        accuracy: 10.5
      }
    }
  };

  console.log('Topic:', `fms/${DEVICE_ID}/driving_session/driver_checkin`);
  console.log('Payload:', JSON.stringify(payload, null, 2));
  console.log('');

  client.publish(
    `fms/${DEVICE_ID}/driving_session/driver_checkin`,
    JSON.stringify(payload),
    { qos: 1 },
    (err) => {
      if (err) {
        console.error('❌ Failed to send check-in:', err);
        client.end();
        process.exit(1);
      } else {
        console.log('✅ Driver Check-in sent (trip should be created)\n');
        console.log('='.repeat(70));
        console.log('✅ Check-in flow completed successfully!');
        console.log('');
        console.log('💡 Check server logs for:');
        console.log(`   1. "Received driver request from device: ${DEVICE_ID}"`);
        console.log(`   2. "Driver ID: ${DRIVER_ID}"`);
        console.log('   3. "Driver info fetched successfully"');
        console.log('   4. "Publishing driver info to MQTT"');
        console.log(`   5. "Received driver check-in from device: ${DEVICE_ID}"`);
        console.log('   6. "Trip created successfully"');
        console.log('='.repeat(70));
        console.log('');

        setTimeout(() => {
          client.end();
          process.exit(0);
        }, 1000);
      }
    }
  );
}

client.on('error', (error) => {
  console.error('❌ MQTT Error:', error);
  client.end();
  process.exit(1);
});

// Handle timeout
setTimeout(() => {
  console.error('❌ Test timeout after 15 seconds');
  client.end();
  process.exit(1);
}, 15000);

// Usage information
console.log('This script tests the complete check-in workflow:');
console.log('');
console.log('Flow:');
console.log('  1. Edge device sends driver_id via driver_request topic');
console.log('  2. Server fetches driver info from API and publishes to driver_info topic');
console.log('  3. Edge device receives driver info');
console.log('  4. Edge device sends check-in data with driver information');
console.log('  5. Server creates new trip');
console.log('');
console.log('Topics used:');
console.log('  OUT: fms/{device_id}/driving_session/driver_request');
console.log('  IN:  fms/{device_id}/driving_session/driver_info');
console.log('  OUT: fms/{device_id}/driving_session/driver_checkin');
console.log('');
console.log('Usage: node test-checkin-flow.js [device_id] [driver_id]');
console.log('Example: node test-checkin-flow.js vehicle_001 880e8400-e29b-41d4-a716-446655440001');
console.log('');
