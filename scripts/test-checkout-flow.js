#!/usr/bin/env node

/**
 * Script để test full checkout flow:
 * 1. Checkout Confirm Request -> gửi driver_id để kiểm tra có trip active không
 * 2. Receive Checkout Confirm Response -> nhận is_confirm (true/false)
 * 3. Driver Checkout -> gửi thông tin checkout để kết thúc trip (nếu is_confirm=true)
 *
 * Flow này test việc edge device kiểm tra trạng thái trip trước khi checkout
 */

const mqtt = require('mqtt');

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://103.216.116.186:1883';
const DEVICE_ID = process.argv[2] || 'vehicle_001';
const DRIVER_ID = process.argv[3] || '880e8400-e29b-41d4-a716-446655440001';

console.log('\n🧪 Checkout Flow Test');
console.log('='.repeat(70));
console.log(`📍 Broker: ${BROKER_URL}`);
console.log(`📱 Device ID: ${DEVICE_ID}`);
console.log(`👤 Driver ID: ${DRIVER_ID}`);
console.log('='.repeat(70) + '\n');

// Create MQTT client
const client = mqtt.connect(BROKER_URL, {
  clientId: `test_checkout_flow_${Math.random().toString(16).slice(3)}`,
});

// Subscribe to checkout confirm response
const checkoutConfirmResponseTopic = `fms/${DEVICE_ID}/driving_session/driver_checkout_confirm_respond`;
let confirmResponseReceived = false;
let isConfirmed = false;

client.on('connect', () => {
  console.log('✅ Connected to MQTT broker\n');

  // Subscribe to checkout confirm response topic
  client.subscribe(checkoutConfirmResponseTopic, { qos: 1 }, (err) => {
    if (err) {
      console.error('❌ Failed to subscribe to checkout confirm response topic:', err);
      client.end();
      process.exit(1);
    } else {
      console.log(`📡 Subscribed to: ${checkoutConfirmResponseTopic}\n`);

      // Start the flow
      console.log('📋 Flow Steps:');
      console.log('  1️⃣  Send Checkout Confirm Request with driver_id');
      console.log('  2️⃣  Receive Checkout Confirm Response (is_confirm: true/false)');
      console.log('  3️⃣  Send Driver Checkout if confirmed (or skip if not confirmed)');
      console.log('');

      // Step 1: Send Checkout Confirm Request
      step1_sendCheckoutConfirmRequest();
    }
  });
});

// Handle incoming messages
client.on('message', (topic, message) => {
  if (topic === checkoutConfirmResponseTopic) {
    console.log('2️⃣  Step 2: Received Checkout Confirm Response');
    console.log('-'.repeat(70));
    console.log('Topic:', topic);

    try {
      const response = JSON.parse(message.toString());
      console.log('Response:', JSON.stringify(response, null, 2));
      console.log('');

      isConfirmed = response.respond_data?.is_confirm || false;

      if (isConfirmed) {
        console.log('✅ Checkout CONFIRMED - Active trip found');
        console.log('   → Proceeding to send checkout data\n');
        confirmResponseReceived = true;

        // Wait a bit then send checkout
        setTimeout(() => step3_sendCheckout(), 2000);
      } else {
        console.log('❌ Checkout NOT CONFIRMED - No active trip or trip already ended');
        console.log('   → Skipping checkout step\n');
        console.log('='.repeat(70));
        console.log('⚠️  Checkout flow stopped - no active trip to end');
        console.log('');
        console.log('💡 To test successful checkout:');
        console.log('   1. First run: node scripts/test-checkin-flow.js');
        console.log('   2. Then run this script to checkout');
        console.log('='.repeat(70));
        console.log('');

        setTimeout(() => {
          client.end();
          process.exit(0);
        }, 1000);
      }
    } catch (err) {
      console.error('❌ Failed to parse checkout confirm response:', err);
      client.end();
      process.exit(1);
    }
  }
});

function step1_sendCheckoutConfirmRequest() {
  console.log('1️⃣  Step 1: Send Checkout Confirm Request');
  console.log('-'.repeat(70));

  const payload = {
    time_stamp: Date.now(),
    message_id: `checkout_test_confirm_req_${Date.now()}`,
    driver_id: DRIVER_ID
  };

  console.log('Topic:', `fms/${DEVICE_ID}/driving_session/driver_checkout_confirm_request`);
  console.log('Payload:', JSON.stringify(payload, null, 2));
  console.log('');

  client.publish(
    `fms/${DEVICE_ID}/driving_session/driver_checkout_confirm_request`,
    JSON.stringify(payload),
    { qos: 1 },
    (err) => {
      if (err) {
        console.error('❌ Failed to send checkout confirm request:', err);
        client.end();
        process.exit(1);
      } else {
        console.log('✅ Checkout Confirm Request sent');
        console.log('⏳ Waiting for checkout confirm response...\n');

        // Set timeout in case we don't receive response
        setTimeout(() => {
          if (!confirmResponseReceived && !isConfirmed) {
            console.error('❌ Timeout: Checkout confirm response not received after 5 seconds');
            console.log('💡 Check if server is running and processing checkout confirm requests');
            client.end();
            process.exit(1);
          }
        }, 5000);
      }
    }
  );
}

function step3_sendCheckout() {
  console.log('3️⃣  Step 3: Send Driver Checkout');
  console.log('-'.repeat(70));

  // Calculate working duration (assume 1 hour for test)
  const workingDurationSeconds = 3600; // 1 hour in seconds

  const payload = {
    time_stamp: Date.now(),
    message_id: `checkout_test_checkout_${Date.now()}`,
    check_out_data: {
      driver_information: {
        driver_name: "Test Driver",
        driver_license_number: "B123456789"
      },
      working_duration: workingDurationSeconds,
      check_out_timestamp: Date.now(),
      CheckOutLocation: {
        gps_timestamp: Date.now(),
        latitude: 21.0295, // Slightly different from check-in
        longitude: 105.8552,
        accuracy: 12.0
      }
    }
  };

  console.log('Topic:', `fms/${DEVICE_ID}/driving_session/driver_checkout`);
  console.log('Payload:', JSON.stringify(payload, null, 2));
  console.log('');

  client.publish(
    `fms/${DEVICE_ID}/driving_session/driver_checkout`,
    JSON.stringify(payload),
    { qos: 1 },
    (err) => {
      if (err) {
        console.error('❌ Failed to send checkout:', err);
        client.end();
        process.exit(1);
      } else {
        console.log('✅ Driver Checkout sent (trip should be ended)\n');
        console.log('='.repeat(70));
        console.log('✅ Checkout flow completed successfully!');
        console.log('');
        console.log('💡 Check server logs for:');
        console.log(`   1. "Received check-out confirm request from device: ${DEVICE_ID}"`);
        console.log(`   2. "Driver ID: ${DRIVER_ID}"`);
        console.log('   3. "Ongoing trip found for ... Confirming check-out."');
        console.log('   4. "Check-out confirm response sent ... is_confirm=true"');
        console.log(`   5. "Received driver check-out from device: ${DEVICE_ID}"`);
        console.log('   6. "Trip ... updated successfully with check-out data"');
        console.log('   7. Trip status should be "Completed" with end time set');
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
console.log('This script tests the complete checkout workflow:');
console.log('');
console.log('Flow:');
console.log('  1. Edge device sends driver_id via checkout_confirm_request topic');
console.log('  2. Server checks if there is an active trip (no end time)');
console.log('  3. Server responds with is_confirm=true/false');
console.log('  4. If confirmed, edge device sends checkout data');
console.log('  5. Server updates trip with end time and marks as Completed');
console.log('');
console.log('Topics used:');
console.log('  OUT: fms/{device_id}/driving_session/driver_checkout_confirm_request');
console.log('  IN:  fms/{device_id}/driving_session/driver_checkout_confirm_respond');
console.log('  OUT: fms/{device_id}/driving_session/driver_checkout');
console.log('');
console.log('Prerequisites:');
console.log('  - An active trip must exist (run test-checkin-flow.js first)');
console.log('  - The trip must not have an end time yet');
console.log('');
console.log('Usage: node test-checkout-flow.js [device_id] [driver_id]');
console.log('Example: node test-checkout-flow.js vehicle_001 880e8400-e29b-41d4-a716-446655440001');
console.log('');
